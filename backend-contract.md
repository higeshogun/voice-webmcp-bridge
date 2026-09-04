# Windows Realtime backend contract

This bridge intentionally keeps model execution outside the browser and Node router. The Windows llama.cpp cluster needs to provide one stable **SDP-over-HTTP WebRTC facade** that the browser can reach.

## Required facade behavior

| Area | Required behavior |
|---|---|
| SDP exchange | `POST` the browser offer as `application/sdp`; return the answer as `application/sdp` |
| Audio | Receive the microphone track; return the synthesized assistant track |
| Data channel | Accept/open `model-events` and exchange UTF-8 JSON Realtime events |
| Tool updates | Apply `session.update.session.tools` before future response generation |
| Tool call | Emit `response.function_call_arguments.done` with `call_id`, `name`, and JSON-string `arguments` |
| Tool result | Consume `conversation.item.create` where `item.type` is `function_call_output` and `item.call_id` matches the tool call |

The response event needs the following shape for the frontend:

```json
{
  "type": "response.function_call_arguments.done",
  "call_id": "call_abc123",
  "name": "addToCart",
  "arguments": "{\"itemId\":\"sku_999\"}"
}
```

## Mixed-GPU deployment boundary

Keep latency-sensitive streaming stages independent: ASR holds the incoming audio stream, the LLM owns function selection/argument generation, and TTS owns the outgoing audio stream. Give each worker a bounded queue and report queue depth, first-token latency, tool-call latency, and first-audio latency at the facade. This lets the scheduler place a process on the AMD or NVIDIA device based on the actual builds and runtime support available on the Windows host, instead of assuming incompatible cross-vendor tensor splitting works.

The browser configuration is deliberately just an endpoint URL:

```env
VITE_REALTIME_URL=http://WINDOWS_HOST:PORT/v1/realtime
```

Do not expose the Windows facade publicly without authentication and TLS. The loopback bridge and bookmarklet should remain local to the browser machine.
