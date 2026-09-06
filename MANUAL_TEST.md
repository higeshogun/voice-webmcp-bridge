# Manual Chrome test

Use this guide to validate the full path: a WebMCP page exposes tools, the bookmarklet shares them with the local bridge, and the speech-to-speech agent invokes a read-only tool.

## Before starting

| Requirement | Check |
|---|---|
| Chrome/Edge WebMCP support | In a Chromium browser that supports WebMCP, open `chrome://flags/#enable-webmcp-testing`, enable it, then relaunch. If this flag is absent, use a newer Chrome/Chrome Beta/Canary build. |
| Target test page | Use `https://webmcp.sh/`. It exposes read-only tools such as `get_current_context`. |
| Local speech server | Set `VITE_REALTIME_URL` in `voice-agent/.env` to your own reachable realtime endpoint. |
| Microphone | Be ready to allow microphone access for `http://127.0.0.1:5173`. |

## Start the local components

In Terminal 1:

```sh
cd /path/to/voice-webmcp-bridge
npm install
npm run start:bridge
```

Keep that terminal open. It should print:

```text
Voice WebMCP bridge listening on ws://127.0.0.1:8080
```

In Terminal 2:

```sh
cd /path/to/voice-webmcp-bridge
cp voice-agent/.env.example voice-agent/.env
npm run start:agent
```

Set `VITE_REALTIME_URL` to your own server before starting the agent. The supplied `.env` uses the Custom / legacy preset and 16 kHz output. For the public Hugging Face speech-to-speech project, choose **Hugging Face speech-to-speech** in the UI (or set `VITE_REALTIME_PRESET=huggingface`) and use `ws://HOST:8765/v1/realtime`; the preset uses 24 kHz PCM16 automatically. For WebRTC, set the endpoint to `http://HOST:8765/v1/realtime`; the app adds `/calls` for the Hugging Face endpoint.

Open the Vite URL shown in the terminal, normally `http://127.0.0.1:5173`. Its Bridge status should become **connected**.

## Create and run the bookmarklet

Build the bookmarklet if you have not already:

```sh
cd /path/to/voice-webmcp-bridge
npm run build:bookmarklet
```

1. Show Chrome’s bookmarks bar with `Cmd` + `Shift` + `B`.
2. Create a new bookmark. Any title is fine, for example **Voice WebMCP**.
3. Copy the *entire single line* from `bookmarklet/bookmarklet.txt` into the bookmark’s URL field.
4. Open `https://webmcp.sh/` in Chrome.
5. In Voice WebMCP, note the six-digit **Pair a browser tab** code.
6. Click the **Voice WebMCP** bookmark once, then enter that code when asked.

Expected result: the Voice WebMCP app receives `https://webmcp.sh` as an Active target tab and lists its available tools. A code only pairs the tab with the one agent instance that generated it.

For each discovered tool, choose its **Execution** policy in the Tool Blueprint:

| Policy | Behavior |
|---|---|
| Require approval | The call pauses in the Tool Inspector until you approve or decline its exact input. This is the default. |
| Auto-run | The configured tool runs immediately, but its input and output remain visible in the inspector. |

Policies are saved locally per page origin and tool name.

To configure several tools at once, select their checkboxes in the Tool Blueprint (or use **Select all tools**), then choose **Set selected to Auto-run**. This makes those tools run without an individual approval prompt on future calls. **Require approval** reverses that saved policy; neither action executes calls already waiting in the Tool Inspector.

## Check WebMCP before involving voice

If no tools appear, open DevTools → Console on `webmcp.sh` and run:

```js
const context = document.modelContext ?? navigator.modelContext;
await context.getTools();
```

Expected result: an array containing tools such as `get_current_context`, `list_all_routes`, and `app_gateway`.

| Result | Meaning | Next action |
|---|---|---|
| `document.modelContext` / `navigator.modelContext` is missing | WebMCP is not enabled in that Chrome profile. | Enable the flag above and relaunch. |
| Tools appear in DevTools but not in Voice WebMCP | The bookmarklet did not reach the local bridge. | Confirm the bridge is running on port 8080, reload the page, then click the bookmarklet again. |
| Browser reports a blocked localhost WebSocket | Chrome policy is preventing `https://webmcp.sh` from opening `ws://localhost:8080`. | Capture the console message; the next change is to serve the bridge over trusted local WSS. |

## Run the voice and tool test

1. In Voice WebMCP, select `https://webmcp.sh` if it is not already selected.
2. Click **Start voice agent** and allow microphone access.
3. Say: **“Use the get_current_context tool, then tell me the current route.”**
4. Pause after speaking so the server can complete the turn.

The successful path is:

| Surface | Expected evidence |
|---|---|
| Voice WebMCP | Microphone and Realtime statuses become **live** / **connected**. |
| Tool inspector | A pending `get_current_context` call shows its exact input. Click **Approve tool**; then the inspector shows its output. |
| Voice WebMCP activity | `Approved get_current_context`, followed by `TOOL_RESULT: get_current_context`. |
| Browser page | No page change is required: this tool is read-only. |
| Speaker output | The assistant reports the current route, normally `/`. |

## Test interruption / barge-in

1. Keep **Allow interruption / barge-in** enabled in Voice WebMCP. It is enabled by default and remembered locally.
2. Ask a question likely to produce a longer reply.
3. While the reply is audible, say: **“Stop. Use get_current_context instead.”**

Expected result: queued assistant audio stops immediately, the activity list records `Barge-in: assistant response cancelled (server VAD).`, and the server answers the new request. Use headphones for this test. Browser echo cancellation is requested, but physical speaker playback can still be misread as speech on some hardware.

## What to report back

Please send a screenshot of the Voice WebMCP status/activity area and, if it fails, the exact first browser-console error. The key distinction is whether the failure occurs before discovery, when the voice session starts, when the tool is called, or when audio is played.
