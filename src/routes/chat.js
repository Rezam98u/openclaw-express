import { Router } from "express";
import { getClient } from "../openclawClient.js";

export const chatRouter = Router();

chatRouter.post("/ask", async (req, res) => {
  const { question, sessionKey, agentId } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Field 'question' (string) is required." });
  }

  // FIX: Add default agentId if missing
  const options = { sessionKey, agentId: agentId || "main" };

  try {
    const client = await getClient();
    const answer = await client.chatSync(question, options);
    res.json({ answer });
  } catch (err) {
    console.error("[chat:ask]", err);
    res.status(502).json({ error: err.message });
  }
});

chatRouter.post("/stream", async (req, res) => {
  const { question, sessionKey, agentId } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Field 'question' (string) is required." });
  }

  const options = { sessionKey, agentId: agentId || "main" };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  try {
    const client = await getClient();
    const stream = client.chat(question, options);

    for await (const chunk of stream) {
      if (cancelled) break;
      sendEvent(chunk.type, chunk);
      if (chunk.type === "done") break;
    }
  } catch (err) {
    console.error("[chat:stream]", err);
    sendEvent("error", { message: err.message });
  } finally {
    res.end();
  }
});