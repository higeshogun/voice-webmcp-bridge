(() => {
  const BRIDGE_URL = "ws://localhost:8080";
  const context = document.modelContext || window.navigator?.modelContext;
  if (!context?.getTools || (!context?.executeTool && !context?.invokeTool)) {
    alert("This page does not expose a supported WebMCP modelContext API.");
    return;
  }

  const pairingCode = window.prompt("Enter the six-digit pairing code shown in Voice WebMCP.");
  if (!pairingCode?.trim()) return;
  const socket = new WebSocket(BRIDGE_URL);
  const toError = (error) => error instanceof Error ? error.message : String(error);
  const send = (payload) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(payload));

  const discoverTools = async () => {
    try {
      const rawTools = await context.getTools();
      const tools = rawTools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        parameters: typeof (tool.parameters || tool.inputSchema) === "string"
          ? JSON.parse(tool.parameters || tool.inputSchema)
          : tool.parameters || tool.inputSchema || { type: "object", properties: {} }
      }));
      window.__voiceWebMCPTools = new Map(rawTools.map((tool) => [tool.name, tool]));
      send({ type: "TOOLS_DISCOVERED", pageOrigin: window.location.origin, pageUrl: window.location.href, tools });
      console.info(`[Voice WebMCP] Shared ${tools.length} tool(s) from ${window.location.origin}.`);
    } catch (error) {
      console.error("[Voice WebMCP] Tool discovery failed:", error);
      alert(`Voice WebMCP tool discovery failed: ${toError(error)}`);
    }
  };

  socket.addEventListener("open", () => send({ type: "REGISTER", role: "bookmarklet", pairingCode: pairingCode.trim() }));

  socket.addEventListener("message", async (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "BRIDGE_REGISTERED") {
      discoverTools();
      return;
    }
    if (message.type === "BRIDGE_ERROR") {
      console.error("[Voice WebMCP]", message.error);
      alert(`Voice WebMCP bridge error: ${message.error}`);
      return;
    }
    if (message.type !== "EXECUTE_TOOL") return;
    try {
      const descriptor = window.__voiceWebMCPTools?.get(message.toolName);
      const result = context.invokeTool
        ? await context.invokeTool(message.toolName, message.params || {})
        : await context.executeTool(descriptor, JSON.stringify(message.params || {}));
      send({ type: "TOOL_RESULT", callId: message.callId, toolName: message.toolName, result });
    } catch (error) {
      send({ type: "TOOL_ERROR", callId: message.callId, toolName: message.toolName, error: toError(error) });
    }
  });

  socket.addEventListener("close", () => console.info("[Voice WebMCP] Bridge disconnected."));
  socket.addEventListener("error", () => console.error("[Voice WebMCP] Could not connect to ws://localhost:8080."));
})();
