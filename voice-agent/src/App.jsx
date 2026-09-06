import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectRealtime } from "./realtime.js";

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL || "ws://localhost:8080";
const REALTIME_URL = import.meta.env.VITE_REALTIME_URL || "";
const normalize = (tool) => ({ type: "function", name: tool.name, description: tool.description || "", parameters: tool.parameters || { type: "object", properties: {} } });
const MAX_TRANSCRIPT_ENTRIES = 32;
const MAX_TOOL_CALLS = 20;
const DEFAULT_SYSTEM_PROMPT = "You are a concise voice assistant. Use active WebMCP tools only when they help satisfy the request. Tools configured as Require approval wait for the user in the app; only use preconfigured Auto-run tools without waiting. Summarize tool results naturally.";
const toolPolicyKey = (origin, toolName) => `${origin}::${toolName}`;

function mergeTranscript(current, incoming, append) {
  if (!append || !current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.endsWith(incoming)) return current;
  return current + incoming;
}

function pretty(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

function Status({ label, value }) {
  return <div className="status"><span className={`dot ${value === "connected" ? "ok" : value === "error" ? "bad" : ""}`} /><span>{label}</span><strong>{value}</strong></div>;
}

export default function App() {
  const [bridgeStatus, setBridgeStatus] = useState("connecting");
  const [micStatus, setMicStatus] = useState("idle");
  const [toolsByOrigin, setToolsByOrigin] = useState({});
  const [pageUrlsByOrigin, setPageUrlsByOrigin] = useState({});
  const [activeOrigin, setActiveOrigin] = useState("");
  const [selectedBlueprintToolName, setSelectedBlueprintToolName] = useState("");
  const [selectedBlueprintToolNames, setSelectedBlueprintToolNames] = useState([]);
  const [agentStatus, setAgentStatus] = useState("idle");
  const [bargeInEnabled, setBargeInEnabled] = useState(() => localStorage.getItem("voice-webmcp.barge-in") !== "false");
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem("voice-webmcp.system-prompt") || DEFAULT_SYSTEM_PROMPT);
  const [toolPolicies, setToolPolicies] = useState(() => {
    try { return JSON.parse(localStorage.getItem("voice-webmcp.tool-policies") || "{}"); } catch { return {}; }
  });
  const [pairingCode, setPairingCode] = useState("");
  const [events, setEvents] = useState([]);
  const [transcript, setTranscript] = useState([]);
  const [toolCalls, setToolCalls] = useState([]);
  const [selectedCallId, setSelectedCallId] = useState(null);
  const bridgeRef = useRef(null);
  const realtimeRef = useRef(null);
  const activeOriginRef = useRef("");
  const toolPoliciesRef = useRef(toolPolicies);
  const playbackRef = useRef(null);

  const appendEvent = useCallback((message) => setEvents((current) => [message, ...current].slice(0, 8)), []);
  const activePageTools = useMemo(() => toolsByOrigin[activeOrigin] || [], [toolsByOrigin, activeOrigin]);
  const activeTools = useMemo(() => activePageTools.map(normalize), [activePageTools]);
  const selectedBlueprintTool = activePageTools.find((tool) => tool.name === selectedBlueprintToolName) || activePageTools[0];
  const selectedBlueprintTools = activePageTools.filter((tool) => selectedBlueprintToolNames.includes(tool.name));
  const selectedBlueprintToolCount = selectedBlueprintTools.length;
  const allBlueprintToolsSelected = activePageTools.length > 0 && selectedBlueprintToolCount === activePageTools.length;
  const autoRunCount = activePageTools.filter((tool) => toolPolicies[toolPolicyKey(activeOrigin, tool.name)] === "auto").length;
  const approvalCount = activePageTools.length - autoRunCount;
  const selectedTool = toolCalls.find((call) => call.callId === selectedCallId) || toolCalls[0];

  const updateTranscript = useCallback(({ id, role, text, append, complete }) => {
    if (!text) return;
    setTranscript((current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) return [...current, { id, role, text, complete }].slice(-MAX_TRANSCRIPT_ENTRIES);
      const next = [...current];
      next[index] = { ...next[index], text: mergeTranscript(next[index].text, text, append), complete: next[index].complete || complete };
      return next;
    });
  }, []);

  const registerToolCall = useCallback(({ callId, toolName, params, policy }) => {
    setToolCalls((current) => [...current.filter((call) => call.callId !== callId), { callId, toolName, params, policy, status: policy === "auto" ? "running" : "awaiting", output: null }].slice(-MAX_TOOL_CALLS));
    setSelectedCallId(callId);
  }, []);

  const completeToolCall = useCallback(({ callId, toolName, result, error }) => {
    setToolCalls((current) => {
      const existing = current.find((call) => call.callId === callId);
      const next = { callId, toolName: toolName || existing?.toolName || "unknown_tool", params: existing?.params || {}, policy: existing?.policy || "approve", status: error ? "error" : "complete", output: error ? { error } : result };
      return [...current.filter((call) => call.callId !== callId), next].slice(-MAX_TOOL_CALLS);
    });
    setSelectedCallId(callId);
  }, []);

  const handleTranscriptEvent = useCallback((event) => {
    const input = event.type?.startsWith("conversation.item.input_audio_transcription.");
    const output = event.type?.startsWith("response.output_audio_transcript.") || event.type?.startsWith("response.audio_transcript.") || event.type?.startsWith("response.text.");
    if (!input && !output) return false;
    const text = event.delta ?? event.transcript ?? event.text;
    if (!text) return true;
    const role = input ? "You" : "Assistant";
    const id = event.item_id || event.response_id || `${role}-active`;
    updateTranscript({ id, role, text, append: event.type.endsWith(".delta"), complete: event.type.endsWith(".completed") || event.type.endsWith(".done") });
    return true;
  }, [updateTranscript]);

  const sendBridge = useCallback((payload) => {
    if (bridgeRef.current?.readyState === WebSocket.OPEN) bridgeRef.current.send(JSON.stringify(payload));
  }, []);

  const approveToolCall = () => {
    if (!selectedTool || selectedTool.status !== "awaiting") return;
    setToolCalls((current) => current.map((call) => call.callId === selectedTool.callId ? { ...call, status: "running" } : call));
    sendBridge({ type: "EXECUTE_TOOL", callId: selectedTool.callId, toolName: selectedTool.toolName, params: selectedTool.params });
    appendEvent(`Approved ${selectedTool.toolName}`);
  };

  const rejectToolCall = () => {
    if (!selectedTool || selectedTool.status !== "awaiting") return;
    const output = { error: "Tool call declined by the user." };
    setToolCalls((current) => current.map((call) => call.callId === selectedTool.callId ? { ...call, status: "rejected", output } : call));
    realtimeRef.current?.sendToolOutput(selectedTool.callId, output);
    appendEvent(`Declined ${selectedTool.toolName}`);
  };

  useEffect(() => {
    const socket = new WebSocket(BRIDGE_URL);
    bridgeRef.current = socket;
    socket.addEventListener("open", () => {
      setBridgeStatus("connected");
      socket.send(JSON.stringify({ type: "REGISTER", role: "agent" }));
    });
    socket.addEventListener("close", () => setBridgeStatus("disconnected"));
    socket.addEventListener("error", () => setBridgeStatus("error"));
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "BRIDGE_REGISTERED" && message.role === "agent") socket.send(JSON.stringify({ type: "CREATE_PAIRING" }));
      if (message.type === "PAIRING_CREATED") setPairingCode(message.code);
      if (message.type === "TOOLS_DISCOVERED") {
        setToolsByOrigin((all) => ({ ...all, [message.pageOrigin]: message.tools || [] }));
        if (message.pageUrl) setPageUrlsByOrigin((all) => ({ ...all, [message.pageOrigin]: message.pageUrl }));
        if (!activeOriginRef.current) setActiveOrigin(message.pageOrigin);
        appendEvent(`Discovered ${(message.tools || []).length} tool(s) from ${message.pageOrigin}`);
      }
      if (message.type === "TOOL_RESULT" || message.type === "TOOL_ERROR") {
        const payload = message.type === "TOOL_RESULT" ? message.result : { error: message.error };
        realtimeRef.current?.sendToolOutput(message.callId, payload);
        completeToolCall({ callId: message.callId, toolName: message.toolName, result: message.result, error: message.type === "TOOL_ERROR" ? message.error : null });
        appendEvent(`${message.type}: ${message.toolName}`);
      }
      if (message.type === "BRIDGE_ERROR") appendEvent(`Bridge: ${message.error}`);
    });
    return () => socket.close();
  }, [appendEvent, completeToolCall]);

  useEffect(() => {
    activeOriginRef.current = activeOrigin;
    if (!activeOrigin) return;
    sendBridge({ type: "SET_ACTIVE_PAGE", pageOrigin: activeOrigin });
    realtimeRef.current?.updateTools((toolsByOrigin[activeOrigin] || []).map(normalize));
  }, [activeOrigin, sendBridge, toolsByOrigin]);

  useEffect(() => {
    if (!activePageTools.some((tool) => tool.name === selectedBlueprintToolName)) setSelectedBlueprintToolName(activePageTools[0]?.name || "");
  }, [activePageTools, selectedBlueprintToolName]);

  useEffect(() => {
    setSelectedBlueprintToolNames((current) => current.filter((toolName) => activePageTools.some((tool) => tool.name === toolName)));
  }, [activePageTools]);

  useEffect(() => {
    localStorage.setItem("voice-webmcp.barge-in", String(bargeInEnabled));
    realtimeRef.current?.setBargeInEnabled(bargeInEnabled);
  }, [bargeInEnabled]);

  useEffect(() => localStorage.setItem("voice-webmcp.system-prompt", systemPrompt), [systemPrompt]);
  useEffect(() => {
    localStorage.setItem("voice-webmcp.tool-policies", JSON.stringify(toolPolicies));
    toolPoliciesRef.current = toolPolicies;
  }, [toolPolicies]);

  const setToolPolicy = (toolName, policy) => {
    setToolPolicies((current) => ({ ...current, [toolPolicyKey(activeOrigin, toolName)]: policy }));
  };

  const toggleBlueprintToolSelection = (toolName, selected) => {
    setSelectedBlueprintToolNames((current) => selected ? [...new Set([...current, toolName])] : current.filter((name) => name !== toolName));
  };

  const toggleAllBlueprintToolSelections = (selected) => {
    setSelectedBlueprintToolNames(selected ? activePageTools.map((tool) => tool.name) : []);
  };

  const setSelectedToolPolicies = (policy) => {
    const toolNames = selectedBlueprintTools.map((tool) => tool.name);
    if (!toolNames.length) return;
    setToolPolicies((current) => {
      const next = { ...current };
      toolNames.forEach((toolName) => { next[toolPolicyKey(activeOrigin, toolName)] = policy; });
      return next;
    });
    appendEvent(`Set ${toolNames.length} tool${toolNames.length === 1 ? "" : "s"} to ${policy === "auto" ? "Auto-run" : "Require approval"}.`);
  };

  const applySystemPrompt = () => {
    realtimeRef.current?.setInstructions(systemPrompt);
    appendEvent(realtimeRef.current ? "System prompt applied to the live session." : "System prompt saved for the next session.");
  };

  const startAgent = async () => {
    try {
      setMicStatus("requesting");
      setTranscript([]);
      setToolCalls([]);
      setSelectedCallId(null);
      const session = await connectRealtime({
        endpoint: REALTIME_URL,
        tools: activeTools,
        systemPrompt,
        audioElement: playbackRef.current,
        bargeInEnabled,
        onBargeIn: (reason) => appendEvent(`Barge-in: assistant response cancelled (${reason}).`),
        onStatus: (status) => { setAgentStatus(status); setMicStatus(status === "connected" ? "live" : "idle"); },
        onEvent: (event) => {
          if (handleTranscriptEvent(event)) return;
          if (event.type !== "response.function_call_arguments.done") return;
          try {
            const params = event.arguments ? JSON.parse(event.arguments) : {};
            const policy = toolPoliciesRef.current[toolPolicyKey(activeOriginRef.current, event.name)] || "approve";
            registerToolCall({ callId: event.call_id, toolName: event.name, params, policy });
            if (policy === "auto") {
              sendBridge({ type: "EXECUTE_TOOL", callId: event.call_id, toolName: event.name, params });
              appendEvent(`Auto-ran ${event.name}`);
            } else {
              appendEvent(`Approval required: ${event.name}`);
            }
          } catch { appendEvent(`Invalid function arguments for ${event.name}`); }
        }
      });
      realtimeRef.current = session;
    } catch (error) {
      setMicStatus("error");
      setAgentStatus("error");
      appendEvent(error.message);
    }
  };
  const stopAgent = () => { realtimeRef.current?.close(); realtimeRef.current = null; setMicStatus("idle"); setAgentStatus("idle"); };

  return <main>
    <audio ref={playbackRef} autoPlay />
    <section className="intro"><p className="eyebrow">LOCAL VOICE CONTROL</p><h1>Voice WebMCP Bridge</h1><p>Connect your local speech stack to the tools a page chooses to expose.</p></section>
    <section className="panel controls">
      <div className="status-row"><Status label="Bridge" value={bridgeStatus} /><Status label="Microphone" value={micStatus} /><Status label="Realtime" value={agentStatus} /></div>
      <div className="pairing"><span>Pair a browser tab</span><strong>{pairingCode || "Creating code…"}</strong><small>Run the bookmarklet and enter this six-digit code.</small></div>
      <label>Active target tab<select value={activeOrigin} onChange={(event) => setActiveOrigin(event.target.value)}><option value="">Choose a discovered page</option>{Object.keys(toolsByOrigin).map((origin) => <option key={origin}>{origin}</option>)}</select></label>
      <label className="toggle"><input type="checkbox" checked={bargeInEnabled} onChange={(event) => setBargeInEnabled(event.target.checked)} /> <span>Allow interruption / barge-in</span></label>
      <p className="hint">Hugging Face Realtime: PCM16 24 kHz over WebSocket; WebRTC uses <code>/v1/realtime/calls</code> and the <code>oai-events</code> data channel.</p>
      <label>System prompt<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows="4" placeholder="Instructions for the voice agent" /></label>
      <div className="prompt-actions"><button className="secondary" onClick={applySystemPrompt}>Apply prompt</button><span>Saved locally and sent with each new session.</span></div>
      <div className="actions"><button disabled={agentStatus === "connected" || !activeOrigin} onClick={startAgent}>Start voice agent</button><button className="secondary" disabled={agentStatus !== "connected"} onClick={stopAgent}>Stop</button></div>
      <p className="hint">Barge-in uses server VAD, stops queued playback, and sends <code>response.cancel</code>. Headphones are recommended; speaker echo can still look like speech.</p>
      {!REALTIME_URL && <p className="hint">Set <code>VITE_REALTIME_URL</code> to your Windows backend’s SDP-over-HTTP WebRTC endpoint before starting.</p>}
    </section>
    <section className="panel blueprint">
      <header className="blueprint-header"><div><p className="eyebrow">TOOL BLUEPRINT</p><h2>{activeOrigin ? new URL(pageUrlsByOrigin[activeOrigin] || activeOrigin).hostname : "Awaiting paired page"}</h2></div><div className="capability-counts"><span className="count auto">Auto-run <strong>{autoRunCount}</strong></span><span className="count approval-count">Approval <strong>{approvalCount}</strong></span><span className="count total">Tools <strong>{activePageTools.length}</strong></span></div></header>
      {activeOrigin ? <div className="blueprint-body"><div className="tool-tree"><div className="tree-root"><span className="root-dot" />Paired browser tab</div><div className="tree-route"><span>{pageUrlsByOrigin[activeOrigin] || activeOrigin}</span><strong>{activePageTools.length}</strong></div><div className="bulk-tool-controls"><label className="bulk-select"><input type="checkbox" checked={allBlueprintToolsSelected} onChange={(event) => toggleAllBlueprintToolSelections(event.target.checked)} />Select all tools</label><div><button disabled={!selectedBlueprintToolCount} onClick={() => setSelectedToolPolicies("auto")}>Set {selectedBlueprintToolCount || "selected"} to Auto-run</button><button className="secondary" disabled={!selectedBlueprintToolCount} onClick={() => setSelectedToolPolicies("approve")}>Require approval</button></div></div><div className="tree-tools">{activePageTools.map((tool) => { const policy = toolPolicies[toolPolicyKey(activeOrigin, tool.name)] || "approve"; const isSelected = selectedBlueprintToolNames.includes(tool.name); return <div className="tree-tool-row" key={tool.name}><label className="tree-select" aria-label={`Select ${tool.name} for bulk configuration`}><input type="checkbox" checked={isSelected} onChange={(event) => toggleBlueprintToolSelection(tool.name, event.target.checked)} /></label><button className={`tree-tool ${selectedBlueprintTool?.name === tool.name ? "selected" : ""}`} onClick={() => setSelectedBlueprintToolName(tool.name)}><span className={`policy-dot ${policy}`} /><strong>{tool.name}</strong><small>{policy === "auto" ? "Auto-run" : "Approval"}</small></button></div>; })}</div></div><aside className="blueprint-detail"><p className="eyebrow">SELECTED TOOL</p><h3>{selectedBlueprintTool?.name}</h3><p>{selectedBlueprintTool?.description || "No description supplied."}</p><label className="tool-policy">Execution<select value={toolPolicies[toolPolicyKey(activeOrigin, selectedBlueprintTool?.name)] || "approve"} onChange={(event) => setToolPolicy(selectedBlueprintTool.name, event.target.value)}><option value="approve">Require approval</option><option value="auto">Auto-run</option></select></label><h4>Tool JSON</h4><pre>{pretty(normalize(selectedBlueprintTool || {}))}</pre></aside></div> : <p className="empty">Pair a WebMCP-enabled page to explore its tool blueprint.</p>}
    </section>
    <section className="monitor-grid"><div className="panel"><h2>Rolling transcript</h2>{transcript.length ? <ol className="transcript">{transcript.map((entry) => <li key={entry.id} className={entry.role === "You" ? "user-turn" : "assistant-turn"}><strong>{entry.role}</strong><p>{entry.text}{!entry.complete && <span className="live-mark"> •</span>}</p></li>)}</ol> : <p className="empty">Your spoken turns and the assistant’s replies will appear here.</p>}</div><div className="panel"><h2>Tool inspector</h2>{toolCalls.length ? <><div className="call-tabs">{toolCalls.map((call) => <button key={call.callId} className={`call-tab ${selectedTool?.callId === call.callId ? "selected" : ""}`} onClick={() => setSelectedCallId(call.callId)}>{call.toolName}<span className={call.status}>{call.status}</span></button>)}</div><div className="inspection"><p><strong>Call ID</strong><code>{selectedTool.callId}</code><strong>Policy</strong><span>{selectedTool.policy === "auto" ? "Auto-run" : "Require approval"}</span></p><h3>Input</h3><pre>{pretty(selectedTool.params)}</pre>{selectedTool.status === "awaiting" && <div className="approval"><p>Approval is required before this tool runs.</p><button onClick={approveToolCall}>Approve tool</button><button className="secondary" onClick={rejectToolCall}>Decline</button></div>}<h3>{selectedTool.status === "error" || selectedTool.status === "rejected" ? "Error" : "Output"}</h3><pre>{selectedTool.output ? pretty(selectedTool.output) : selectedTool.status === "awaiting" ? "Awaiting your approval…" : "Awaiting result…"}</pre></div></> : <p className="empty">Function calls will show their exact input and returned output here.</p>}</div></section>
    <section className="panel activity-panel"><h2>Live activity</h2>{events.length ? <ul className="events">{events.map((event, index) => <li key={`${event}-${index}`}>{event}</li>)}</ul> : <p className="empty">Awaiting a page connection.</p>}</section>
  </main>;
}
