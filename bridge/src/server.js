import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const OPEN = WebSocket.OPEN;

/**
 * Payload relay with a deliberately small control plane. Tool payloads are
 * forwarded unmodified; the router reads only message type and discovery
 * routing metadata so it can choose the active target tab.
 */
export function createBridge({ port = 8080, host = "127.0.0.1" } = {}) {
  const clients = new Map();
  const activeTargetByAgent = new Map();
  const bookmarkletByOrigin = new Map();
  const pairings = new Map();
  const wss = new WebSocketServer({ port, host });

  const send = (socket, payload) => {
    if (socket.readyState === OPEN) socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  };
  const sendToAgent = (agentId, raw) => {
    const agent = [...clients.values()].find((client) => client.id === agentId);
    if (agent) send(agent.socket, raw);
  };
  const createPairingCode = () => {
    let code;
    do code = String(Math.floor(100000 + Math.random() * 900000)); while (pairings.has(code));
    return code;
  };

  wss.on("connection", (socket) => {
    const client = { id: randomUUID(), socket, role: "unknown" };
    clients.set(socket, client);
    send(socket, { type: "BRIDGE_CONNECTED", clientId: client.id });

    socket.on("message", (buffer) => {
      const raw = buffer.toString();
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        send(socket, { type: "BRIDGE_ERROR", error: "Messages must be valid JSON." });
        return;
      }

      if (message.type === "REGISTER") {
        if (message.role !== "agent" && message.role !== "bookmarklet") {
          send(socket, { type: "BRIDGE_ERROR", error: "Unknown client role." });
          return;
        }
        client.role = message.role;
        if (client.role === "bookmarklet") {
          const agentId = pairings.get(message.pairingCode);
          if (!agentId) {
            send(socket, { type: "BRIDGE_ERROR", error: "Pairing code is missing, expired, or invalid." });
            return;
          }
          client.agentId = agentId;
        }
        send(socket, { type: "BRIDGE_REGISTERED", clientId: client.id, role: client.role });
        return;
      }

      if (message.type === "CREATE_PAIRING") {
        if (client.role !== "agent") return;
        for (const [code, agentId] of pairings) if (agentId === client.id) pairings.delete(code);
        const code = createPairingCode();
        pairings.set(code, client.id);
        send(socket, { type: "PAIRING_CREATED", code });
        return;
      }

      if (message.type === "TOOLS_DISCOVERED") {
        if (client.role !== "bookmarklet" || !client.agentId || typeof message.pageOrigin !== "string") {
          send(socket, { type: "BRIDGE_ERROR", error: "Only paired bookmarklets can discover tools." });
          return;
        }
        // Latest discovery wins for an origin; agents explicitly select an origin.
        bookmarkletByOrigin.set(message.pageOrigin, client);
        sendToAgent(client.agentId, raw);
        return;
      }

      if (message.type === "SET_ACTIVE_PAGE") {
        if (client.role !== "agent" || typeof message.pageOrigin !== "string") return;
        activeTargetByAgent.set(client.id, message.pageOrigin);
        const target = bookmarkletByOrigin.get(message.pageOrigin);
        const available = target?.agentId === client.id;
        if (!available) {
          activeTargetByAgent.delete(client.id);
          send(socket, { type: "ACTIVE_PAGE_SET", pageOrigin: message.pageOrigin, available: false });
          return;
        }
        send(socket, { type: "ACTIVE_PAGE_SET", pageOrigin: message.pageOrigin, available });
        return;
      }

      if (message.type === "EXECUTE_TOOL") {
        if (client.role !== "agent") return;
        const origin = activeTargetByAgent.get(client.id);
        const target = origin && bookmarkletByOrigin.get(origin);
        if (!target || target.agentId !== client.id) {
          send(socket, JSON.stringify({
            type: "TOOL_ERROR",
            callId: message.callId,
            toolName: message.toolName,
            error: "No active WebMCP tab is connected. Select a discovered page first."
          }));
          return;
        }
        send(target.socket, raw);
        return;
      }

      if (message.type === "TOOL_RESULT" || message.type === "TOOL_ERROR") {
        if (client.role !== "bookmarklet" || !client.agentId) return;
        sendToAgent(client.agentId, raw);
      }
    });

    socket.on("close", () => {
      clients.delete(socket);
      for (const [origin, owner] of bookmarkletByOrigin) if (owner === client) bookmarkletByOrigin.delete(origin);
      for (const [code, agentId] of pairings) if (agentId === client.id) pairings.delete(code);
      for (const [agentId, origin] of activeTargetByAgent) {
        if (agentId === client.id || !bookmarkletByOrigin.has(origin)) activeTargetByAgent.delete(agentId);
      }
    });
  });

  return {
    wss,
    close: () => new Promise((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()))
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "127.0.0.1";
  const bridge = createBridge({ port, host });
  console.log(`Voice WebMCP bridge listening on ws://${host}:${port}`);
  const shutdown = () => bridge.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
