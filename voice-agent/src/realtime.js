function huggingFaceSampleRate(value, fallback) {
  const sampleRate = Number(value);
  // The public server accepts its native 16 kHz rate when the PCM format is
  // omitted, or the OpenAI Realtime PCM schema at 24 kHz.
  return sampleRate === 16_000 || sampleRate === 24_000 ? sampleRate : fallback;
}

function sampleRates() {
  return {
    input: huggingFaceSampleRate(import.meta.env.VITE_HUGGING_FACE_INPUT_SAMPLE_RATE, 24_000),
    output: huggingFaceSampleRate(import.meta.env.VITE_HUGGING_FACE_OUTPUT_SAMPLE_RATE, 24_000)
  };
}

function huggingFaceServerVad(bargeInEnabled) {
  return { type: "server_vad", interrupt_response: bargeInEnabled };
}

function huggingFacePCMFormat(sampleRate) {
  return sampleRate === 24_000 ? { type: "audio/pcm", rate: 24_000 } : undefined;
}

function sessionUpdate({ tools, systemPrompt, bargeInEnabled, includeAudio = true }) {
  const rates = sampleRates();
  const input = { turn_detection: huggingFaceServerVad(bargeInEnabled) };
  const output = {};
  const inputFormat = huggingFacePCMFormat(rates.input);
  const outputFormat = huggingFacePCMFormat(rates.output);
  if (inputFormat) input.format = inputFormat;
  if (outputFormat) output.format = outputFormat;
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: systemPrompt,
      audio: includeAudio ? { input, output } : { input: { turn_detection: huggingFaceServerVad(bargeInEnabled) } },
      tools,
      tool_choice: "auto"
    }
  };
}

function turnDetectionUpdate(bargeInEnabled) {
  return { type: "session.update", session: { audio: { input: { turn_detection: huggingFaceServerVad(bargeInEnabled) } } } };
}

function webRTCEndpointFor(endpoint) {
  const url = new URL(endpoint);
  if (url.pathname.replace(/\/$/, "") === "/v1/realtime") url.pathname = "/v1/realtime/calls";
  return url.toString();
}

function bytesToBase64(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}

function floatToPCM16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, Math.max(-1, Math.min(1, sample)) * 0x7fff, true));
  return bytes;
}

function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.ceil(samples.length / ratio));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(Math.floor((outputIndex + 1) * ratio), samples.length);
    let total = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex++) total += samples[inputIndex];
    output[outputIndex] = total / Math.max(1, end - start);
  }
  return output;
}

function playPCM16(context, encoded, state, sampleRate) {
  const binary = atob(encoded);
  const input = new DataView(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) input.setUint8(index, binary.charCodeAt(index));
  const floats = new Float32Array(binary.length / 2);
  for (let index = 0; index < floats.length; index++) floats[index] = input.getInt16(index * 2, true) / 0x8000;
  const buffer = context.createBuffer(1, floats.length, sampleRate);
  buffer.copyToChannel(floats, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  state.sources.add(source);
  source.addEventListener("ended", () => state.sources.delete(source));
  state.nextStart = Math.max(state.nextStart, context.currentTime + 0.04);
  source.start(state.nextStart);
  state.nextStart += buffer.duration;
}

function stopPlayback(context, state) {
  for (const source of state.sources) {
    try { source.stop(); } catch { /* The source may already have ended. */ }
  }
  state.sources.clear();
  state.nextStart = context.currentTime;
}

/** Connects to either an SDP-over-HTTP WebRTC facade or an OpenAI-style WSS facade. */
export async function connectRealtime(options) {
  return options.endpoint.startsWith("ws:") || options.endpoint.startsWith("wss:")
    ? connectWebSocketRealtime(options)
    : connectWebRTCRealtime(options);
}

async function connectWebSocketRealtime({ endpoint, tools, systemPrompt = "", onEvent, onStatus, onBargeIn, bargeInEnabled = true }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this browser.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const context = new AudioContext({ latencyHint: "interactive" });
  await context.resume();
  const socket = new WebSocket(endpoint);
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentGain = context.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);
  const playback = { nextStart: 0, sources: new Set() };
  let bargeInAllowed = bargeInEnabled;
  let activeResponse = false;
  let responseOpen = false;
  let awaitingCancelledResponse = false;
  let followUpAfterResponse = false;
  const inputSampleRate = sampleRates().input;
  const outputSampleRate = sampleRates().output;
  const interrupt = (reason) => {
    const hasQueuedPlayback = playback.sources.size > 0;
    if (!bargeInAllowed || (!activeResponse && !hasQueuedPlayback) || awaitingCancelledResponse || socket.readyState !== WebSocket.OPEN) return;
    awaitingCancelledResponse = activeResponse;
    activeResponse = false;
    stopPlayback(context, playback);
    if (awaitingCancelledResponse) socket.send(JSON.stringify({ type: "response.cancel" }));
    onBargeIn?.(reason);
  };

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify(sessionUpdate({ tools, systemPrompt, bargeInEnabled: bargeInAllowed })));
    onStatus("connected");
  });
  socket.addEventListener("message", (event) => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type === "input_audio_buffer.speech_started") interrupt("server VAD");
    if (payload.type === "response.created") {
      activeResponse = true;
      responseOpen = true;
      awaitingCancelledResponse = false;
    }
    if (payload.type === "response.done") {
      activeResponse = false;
      responseOpen = false;
      awaitingCancelledResponse = false;
      // HF's GA server keeps a function-call response open until this event.
      // Coalesce completed page-tool outputs into one follow-up response.
      if (followUpAfterResponse) {
        followUpAfterResponse = false;
        socket.send(JSON.stringify({ type: "response.create" }));
      }
    }
    if (payload.type === "response.output_audio.done" || payload.type === "response.audio.done") {
      activeResponse = false;
      awaitingCancelledResponse = false;
    }
    if (payload.type === "error") awaitingCancelledResponse = false;
    if (payload.type === "response.output_audio.delta" || payload.type === "response.audio.delta") {
      if (awaitingCancelledResponse) return;
      activeResponse = true;
      if (payload.delta) playPCM16(context, payload.delta, playback, outputSampleRate);
      return;
    }
    onEvent(payload);
  });
  socket.addEventListener("error", () => onStatus("error"));
  socket.addEventListener("close", () => onStatus("disconnected"));
  processor.onaudioprocess = (event) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = floatToPCM16(resample(input, context.sampleRate, inputSampleRate));
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: bytesToBase64(pcm) }));
  };

  return {
    updateTools(nextTools) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session.update", session: { tools: nextTools, tool_choice: "auto" } })); },
    setBargeInEnabled(enabled) {
      bargeInAllowed = enabled;
      if (!enabled) awaitingCancelledResponse = false;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(turnDetectionUpdate(bargeInAllowed)));
    },
    setInstructions(instructions) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "session.update", session: { instructions } }));
    },
    sendToolOutput(callId, output) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } }));
      if (responseOpen) {
        followUpAfterResponse = true;
        return;
      }
      socket.send(JSON.stringify({ type: "response.create" }));
    },
    close() {
      processor.disconnect(); source.disconnect(); silentGain.disconnect();
      stopPlayback(context, playback);
      stream.getTracks().forEach((track) => track.stop()); socket.close(1000, "voice agent stopped"); context.close();
    }
  };
}

async function connectWebRTCRealtime({ endpoint, tools, systemPrompt = "", onEvent, onStatus, audioElement, bargeInEnabled = true }) {
  if (!endpoint) throw new Error("Set VITE_REALTIME_URL to the local WebRTC SDP endpoint.");
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this browser.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const peer = new RTCPeerConnection();
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
  peer.addEventListener("track", (event) => {
    if (!audioElement) return;
    audioElement.srcObject = event.streams[0]; audioElement.play().catch(() => {});
  });
  const dataChannel = peer.createDataChannel("oai-events");
  let responseOpen = false;
  let followUpAfterResponse = false;
  dataChannel.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "response.created") responseOpen = true;
      if (payload.type === "response.done") {
        responseOpen = false;
        if (followUpAfterResponse) {
          followUpAfterResponse = false;
          dataChannel.send(JSON.stringify({ type: "response.create" }));
        }
      }
      onEvent(payload);
    } catch {}
  });
  dataChannel.addEventListener("open", () => {
    onStatus("connected");
    dataChannel.send(JSON.stringify(sessionUpdate({ tools, systemPrompt, bargeInEnabled, includeAudio: false })));
  });
  dataChannel.addEventListener("close", () => onStatus("disconnected"));
  peer.addEventListener("connectionstatechange", () => { if (["failed", "closed", "disconnected"].includes(peer.connectionState)) onStatus("disconnected"); });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const response = await fetch(webRTCEndpointFor(endpoint), { method: "POST", headers: { "Content-Type": "application/sdp", Accept: "application/sdp" }, body: offer.sdp });
  if (!response.ok) { stream.getTracks().forEach((track) => track.stop()); peer.close(); throw new Error(`Realtime backend rejected the WebRTC offer (${response.status}).`); }
  await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  return {
    updateTools(nextTools) { if (dataChannel.readyState === "open") dataChannel.send(JSON.stringify({ type: "session.update", session: { tools: nextTools, tool_choice: "auto" } })); },
    setBargeInEnabled(enabled) {
      if (dataChannel.readyState === "open") dataChannel.send(JSON.stringify(turnDetectionUpdate(enabled)));
    },
    setInstructions(instructions) { if (dataChannel.readyState === "open") dataChannel.send(JSON.stringify({ type: "session.update", session: { instructions } })); },
    sendToolOutput(callId, output) {
      if (dataChannel.readyState !== "open") return;
      dataChannel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } }));
      if (responseOpen) {
        followUpAfterResponse = true;
        return;
      }
      dataChannel.send(JSON.stringify({ type: "response.create" }));
    },
    close() { stream.getTracks().forEach((track) => track.stop()); dataChannel.close(); peer.close(); }
  };
}
