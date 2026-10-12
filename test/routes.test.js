import { after, before, test } from "node:test";
import assert from "node:assert/strict";

// Point the client at a closed port so gateway-backed routes fail fast and predictably.
process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:1";
process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";
process.env.AUTOPILOT_NUMBERS = "+989121234567";
const API_KEY = "test-api-key-0123456789abcdef";
process.env.API_KEY = API_KEY;

const { app } = await import("../src/app.js");
const { disconnectClient } = await import("../src/openclawClient.js");

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await disconnectClient();
  await new Promise((resolve) => server.close(resolve));
});

const auth = { Authorization: `Bearer ${API_KEY}` };

const postJson = (path, body, headers = auth) =>
  fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const get = (path, headers = auth) => fetch(base + path, { headers });

test("/api requires the API key", async () => {
  let res = await postJson("/api/chat/ask", { question: "hi" }, {});
  assert.equal(res.status, 401);

  res = await postJson("/api/chat/ask", { question: "hi" }, { Authorization: "Bearer wrong-key-wrong-key-wrong-key" });
  assert.equal(res.status, 401);

  res = await get("/api/autopilot/conversations/%2B989121234567", {});
  assert.equal(res.status, 401);

  // X-API-Key works too; the request then reaches validation (400), not auth.
  res = await postJson("/api/chat/ask", {}, { "X-API-Key": API_KEY });
  assert.equal(res.status, 400);
});

test("/api fails closed when API_KEY is missing or too short", async () => {
  for (const value of [undefined, "short"]) {
    if (value === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = value;
    const res = await postJson("/api/chat/ask", { question: "hi" });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /API_KEY/);
  }
  process.env.API_KEY = API_KEY;
});

test("GET /health stays open (no API key needed)", async () => {
  const res = await get("/health", {});
  assert.notEqual(res.status, 401);
});

test("POST /api/chat/ask rejects a missing or blank question", async () => {
  for (const body of [{}, { question: "   " }, { question: 42 }]) {
    const res = await postJson("/api/chat/ask", body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /question/);
  }
});

test("POST /api/chat/stream rejects a missing question", async () => {
  const res = await postJson("/api/chat/stream", {});
  assert.equal(res.status, 400);
});

test("POST /api/chat/ask returns 502 when the gateway is unreachable", async () => {
  const res = await postJson("/api/chat/ask", { question: "hi" });
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
});

test("POST /api/chat/stream emits an SSE error event when the gateway is unreachable", async () => {
  const res = await postJson("/api/chat/stream", { question: "hi" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  assert.match(await res.text(), /^event: error\ndata: \{"message":/);
});

test("POST /api/autopilot/message validates the number and context", async () => {
  let res = await postJson("/api/autopilot/message", { to: "0151" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /E\.164/);

  res = await postJson("/api/autopilot/message", { to: "+491511234567", context: 42 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /context/);
});

test("POST /api/autopilot/message refuses numbers outside AUTOPILOT_NUMBERS", async () => {
  const res = await postJson("/api/autopilot/message", { to: "+15551234567" });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /AUTOPILOT_NUMBERS/);
});

test("POST /api/autopilot/message returns 502 when the gateway is unreachable", async () => {
  const res = await postJson("/api/autopilot/message", { to: "+989121234567", send: false });
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
});

test("GET /api/autopilot/conversations/:to validates, allowlists, and reports gateway errors", async () => {
  let res = await get("/api/autopilot/conversations/0151");
  assert.equal(res.status, 400);

  res = await get("/api/autopilot/conversations/+15551234567");
  assert.equal(res.status, 403);

  res = await get(`/api/autopilot/conversations/${encodeURIComponent("+989121234567")}`);
  assert.equal(res.status, 502);
});
