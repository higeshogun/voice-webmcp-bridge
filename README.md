# Voice-Driven WebMCP Bridge

An isolated local stack that lets a browser voice agent discover WebMCP tools in a target tab and invoke them through a loopback WebSocket bridge.

## Components

| Component | Location | Purpose |
|---|---|---|
| Signaling bridge | `bridge/` | WebSocket router on `ws://localhost:8080` |
| WebMCP injector | `bookmarklet/` | Bookmarklet source and generated URI |
| Voice agent | `voice-agent/` | React/Vite UI, microphone/WebRTC, function-call relay |

The bridge treats `REGISTER`, `CREATE_PAIRING`, and `SET_ACTIVE_PAGE` as control-plane messages. The agent displays a six-digit pairing code; the bookmarklet must enter it before its page tools can reach that agent. Selecting the paired page determines the exact bookmarklet socket that receives an `EXECUTE_TOOL` payload.

## Run locally

```sh
npm install
npm run build:bookmarklet
npm run start:bridge
```

In another terminal, configure the WebRTC SDP endpoint and run the UI:

```sh
cp voice-agent/.env.example voice-agent/.env
npm run start:agent
```

Open the displayed Vite URL, then drag the full contents of `bookmarklet/bookmarklet.txt` into a bookmark. With the bridge running, copy the six-digit pairing code from the app, open a page that exposes `document.modelContext` (or the legacy navigator alias), use that bookmark, enter the code, choose the discovered tab, and start the voice agent. Every tool call pauses in the inspector until you explicitly approve or decline it.

Each tool can instead be changed to **Auto-run** in the Tool Blueprint. Select multiple tool checkboxes (or all tools) to set their policy together. This local preference is scoped to that page origin and tool name; all other tools continue to require approval by default.

## Windows Realtime backend contract

`VITE_REALTIME_URL` supports either an SDP-over-HTTP WebRTC facade or an OpenAI-style `ws://`/`wss://` Realtime facade. The latter sends and receives JSON events directly, streams 16 kHz PCM microphone input, and schedules PCM output for playback at `VITE_OUTPUT_SAMPLE_RATE` (16 kHz by default for `hf-s2s`). The WebRTC variant sends Realtime events on a channel named `model-events`, including:

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
