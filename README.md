# Voice-Driven WebMCP Bridge

An isolated local stack that lets a browser voice agent discover WebMCP tools in a target tab and invoke them through a loopback WebSocket bridge.

## Components

| Component | Location | Purpose |
|---|---|---|
| Signaling bridge | `bridge/` | WebSocket router on `ws://localhost:8080` |
| WebMCP injector | `bookmarklet/` | Bookmarklet source and generated URI |
| Voice agent | `voice-agent/` | React/Vite UI, microphone transport, function-call relay |

The bridge treats `REGISTER`, `CREATE_PAIRING`, and `SET_ACTIVE_PAGE` as control-plane messages. The agent displays a six-digit pairing code; the bookmarklet must enter it before its page tools can reach that agent. Selecting the paired page determines the exact bookmarklet socket that receives an `EXECUTE_TOOL` payload.

## Run locally

```sh
npm install
npm run build:bookmarklet
npm run start:bridge
```

In another terminal, configure the Realtime endpoint and run the UI:

```sh
cp voice-agent/.env.example voice-agent/.env
npm run start:agent
```

### Bring a compatible realtime backend

This repository contains the browser bridge, bookmarklet, and voice UI. It
does **not** include or host a speech-to-speech inference service. Before
starting the agent, set `VITE_REALTIME_URL` in `voice-agent/.env` to a
Realtime-compatible endpoint you operate or are authorized to use.

The project is tested with a self-hosted
[`huggingface/speech-to-speech`](https://github.com/huggingface/speech-to-speech)
Realtime server. It must accept the session, audio, function-call, and tool
result events described below. Do not expose a local bridge or backend on the
public internet without authentication and TLS.

Open the displayed Vite URL, then drag the full contents of `bookmarklet/bookmarklet.txt` into a bookmark. With the bridge running, copy the six-digit pairing code from the app, open a page that exposes `document.modelContext` (or the legacy navigator alias), use that bookmark, enter the code, choose the discovered tab, and start the voice agent. Every tool call pauses in the inspector until you explicitly approve or decline it.

Each tool can instead be changed to **Auto-run** in the Tool Blueprint. Select multiple tool checkboxes (or all tools) to set their policy together. This local preference is scoped to that page origin and tool name; all other tools continue to require approval by default.

### Recommended first browser test

Use the public [WebMCP Pizza Maker demo](https://googlechromelabs.github.io/webmcp-tools/demos/pizza-maker/)
for the first complete test. Pair that tab, leave every tool on **Require
approval**, and ask the agent to set the pizza size to Large. Confirm that the
Tool Inspector shows the proposed `set_pizza_size` input before approving it.
Avoid `share_pizza` until you have inspected its input and are comfortable with
the destination it uses.

[`webmcp.sh`](https://webmcp.sh/) remains a useful alternate test page when you
want a read-only first call such as `get_current_context`.

## Hugging Face Realtime backend

The voice agent targets an OpenAI-Realtime-compatible
[`huggingface/speech-to-speech`](https://github.com/huggingface/speech-to-speech)
server. Direct WebSocket is the recommended first transport; WebRTC is
optional and requires an SDP-capable facade.

| Transport | `VITE_REALTIME_URL` | Audio and event contract |
|---|---|---|
| WebSocket | `wss://YOUR_REALTIME_HOST/v1/realtime` | PCM16 24 kHz; GA session shape |
| WebRTC | `https://YOUR_REALTIME_HOST/v1/realtime` | Optional SDP facade; the app adds `/calls`; media over RTP; events on `oai-events` |

The client sends the current OpenAI GA-style nested audio/VAD session configuration, listens for `response.function_call_arguments.done`, and returns tool results as function-call outputs. When the function response is still active, it waits for `response.done` before sending the one follow-up `response.create` required by the Hugging Face server.

```json
{ "type": "session.update", "session": { "tools": [{ "type": "function", "name": "addToCart", "parameters": { "type": "object" } }] } }
```

When the backend emits `response.function_call_arguments.done`, the client forwards the exact `EXECUTE_TOOL` schema through the bridge. A `TOOL_RESULT` or `TOOL_ERROR` returns as a `conversation.item.create` function-call output followed by `response.create`.

See [backend-contract.md](backend-contract.md) for the facade event contract and safe mixed-GPU scheduling boundary.

## Important limits

- WebMCP availability is browser/page dependent. The bookmarklet never injects or invents tools; it only calls the page-provided `navigator.modelContext` API.
- `ws://localhost` is intentionally loopback-only. If the voice-agent page is served over HTTPS, browser mixed-content policies can vary; run the agent locally over HTTP or expose the bridge through a trusted local TLS proxy.
- The mixed AMD/NVIDIA inference topology is deployed and scheduled by the Windows llama.cpp cluster. This repository defines its WebRTC/API integration contract rather than prescribing unsafe or hardware-specific GPU split flags.

## Verification

```sh
npm test
npm run build
```

For the full browser, tool, and voice test, follow [MANUAL_TEST.md](MANUAL_TEST.md).
