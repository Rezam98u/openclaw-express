import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { makeWorkbook } from "./helpers.js";

// Point the client at a closed port so gateway-backed routes fail fast and predictably.
process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:1";
process.env.OPENCLAW_GATEWAY_TOKEN = "test-token";

const { chatRouter } = await import("../src/routes/chat.js");
const { whatsappDeliverRouter } = await import("../src/routes/whatsappDeliver.js");
const { excelSessionRouter } = await import("../src/routes/excelSession.js");
const { disconnectClient } = await import("../src/openclawClient.js");

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  app.use("/api/whatsapp", whatsappDeliverRouter);
  app.use("/api/excel-session", excelSessionRouter);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await disconnectClient();
  await new Promise((resolve) => server.close(resolve));
});

const postJson = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const xlsxBlob = (rows) =>
  new Blob([makeWorkbook({ Sheet1: rows })], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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

test("POST /api/whatsapp/ask-deliver validates task, number and file", async () => {
  const send = async (fields, withFile = true) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (withFile) form.append("file", xlsxBlob([["x"]]), "book.xlsx");
    const res = await fetch(base + "/api/whatsapp/ask-deliver", { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
  };

  let r = await send({ to: "+491511234567" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /task/);

  r = await send({ task: "sum it", to: "0151" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /E\.164/);

  r = await send({ task: "sum it", to: "+491511234567" }, false);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /file/);

  r = await send({ task: "sum it", to: "+491511234567" });
  assert.equal(r.status, 502);
  assert.equal(r.body.sessionKey, "agent:main:whatsapp:dm:+491511234567");
  assert.equal(r.body.contextMeta.rowCount, 1);
});

test("excel-session: upload, fetch, list, delete", async () => {
  const form = new FormData();
  form.append("file", xlsxBlob([["name", "score"], ["ana", 9]]), "scores.xlsx");
  let res = await fetch(base + "/api/excel-session/upload", { method: "POST", body: form });
  assert.equal(res.status, 200);
  const { sessionId, excelData } = await res.json();
  assert.equal(excelData.text, "name\tscore\nana\t9");

  res = await fetch(`${base}/api/excel-session/${sessionId}`);
  assert.equal((await res.json()).excelData.meta.rowCount, 2);

  res = await fetch(`${base}/api/excel-session`);
  assert.ok((await res.json()).some((s) => s.sessionId === sessionId));

  res = await fetch(`${base}/api/excel-session/${sessionId}`, { method: "DELETE" });
  assert.deepEqual(await res.json(), { deleted: true, sessionId });

  res = await fetch(`${base}/api/excel-session/${sessionId}`);
  assert.equal(res.status, 404);
});

test("excel-session: rejects missing files and non-spreadsheets", async () => {
  let res = await fetch(base + "/api/excel-session/upload", { method: "POST", body: new FormData() });
  assert.equal(res.status, 400);

  const form = new FormData();
  form.append("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
  res = await fetch(base + "/api/excel-session/upload", { method: "POST", body: form });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Invalid file type/);
});
