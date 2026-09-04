import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createBridge } from "../src/server.js";

const open = (url) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data);
    const waiter = waiters.shift();
    if (waiter) waiter(message); else inbox.push(message);
  });
  socket.once("open", () => resolve({ socket, next: () => new Promise((done) => {
    const message = inbox.shift();
    if (message) done(message); else waiters.push(done);
  }) }));
  socket.once("error", reject);
});
const register = async (client, role, pairingCode) => {
  const connected = await client.next();
  assert.equal(connected.type, "BRIDGE_CONNECTED");
  client.socket.send(JSON.stringify({ type: "REGISTER", role, pairingCode }));
  return client.next();
};
const createPairing = async (agent) => {
  const created = agent.next();
  agent.socket.send(JSON.stringify({ type: "CREATE_PAIRING" }));
  return (await created).code;
};

test("routes an exact EXECUTE_TOOL payload to the agent-selected page", async (t) => {
  const bridge = createBridge({ port: 0 });
  const address = await new Promise((resolve) => bridge.wss.once("listening", () => resolve(bridge.wss.address())));
  const url = `ws://127.0.0.1:${address.port}`;
  const bookmarklet = await open(url);
  const agent = await open(url);
  t.after(async () => {
    bookmarklet.socket.close(); agent.socket.close(); await bridge.close();
  });
  await register(agent, "agent");
  const pairingCode = await createPairing(agent);
  await register(bookmarklet, "bookmarklet", pairingCode);

  const discovered = { type: "TOOLS_DISCOVERED", pageOrigin: "https://shop.example", tools: [{ name: "addToCart" }] };
  const discoveredForAgent = agent.next();
  bookmarklet.socket.send(JSON.stringify(discovered));
  assert.deepEqual(await discoveredForAgent, discovered);

  const activeSet = agent.next();
  agent.socket.send(JSON.stringify({ type: "SET_ACTIVE_PAGE", pageOrigin: "https://shop.example" }));
  assert.deepEqual(await activeSet, { type: "ACTIVE_PAGE_SET", pageOrigin: "https://shop.example", available: true });

  const execute = { type: "EXECUTE_TOOL", callId: "call_abc123", toolName: "addToCart", params: { itemId: "sku_999" } };
  const forwarded = bookmarklet.next();
  agent.socket.send(JSON.stringify(execute));
  assert.deepEqual(await forwarded, execute);
});

test("relays a TOOL_RESULT payload to the connected agent unchanged", async (t) => {
  const bridge = createBridge({ port: 0 });
  const address = await new Promise((resolve) => bridge.wss.once("listening", () => resolve(bridge.wss.address())));
  const url = `ws://127.0.0.1:${address.port}`;
  const bookmarklet = await open(url);
  const agent = await open(url);
  t.after(async () => {
    bookmarklet.socket.close(); agent.socket.close(); await bridge.close();
  });
  await register(agent, "agent");
  const pairingCode = await createPairing(agent);
  await register(bookmarklet, "bookmarklet", pairingCode);

  const result = { type: "TOOL_RESULT", callId: "call_abc123", toolName: "addToCart", result: { success: true, cartTotal: 45.99 } };
  const received = agent.next();
  bookmarklet.socket.send(JSON.stringify(result));
  assert.deepEqual(await received, result);
});

test("does not route paired page tools to another agent", async (t) => {
  const bridge = createBridge({ port: 0 });
  const address = await new Promise((resolve) => bridge.wss.once("listening", () => resolve(bridge.wss.address())));
  const url = `ws://127.0.0.1:${address.port}`;
  const bookmarklet = await open(url);
  const agent = await open(url);
  const otherAgent = await open(url);
  t.after(async () => {
    bookmarklet.socket.close(); agent.socket.close(); otherAgent.socket.close(); await bridge.close();
  });
  await register(agent, "agent");
  await register(otherAgent, "agent");
  const pairingCode = await createPairing(agent);
  await register(bookmarklet, "bookmarklet", pairingCode);
  bookmarklet.socket.send(JSON.stringify({ type: "TOOLS_DISCOVERED", pageOrigin: "https://paired.example", tools: [{ name: "privateTool" }] }));
  assert.equal((await agent.next()).type, "TOOLS_DISCOVERED");
  const activeSet = otherAgent.next();
  otherAgent.socket.send(JSON.stringify({ type: "SET_ACTIVE_PAGE", pageOrigin: "https://paired.example" }));
  assert.deepEqual(await activeSet, { type: "ACTIVE_PAGE_SET", pageOrigin: "https://paired.example", available: false });
});
