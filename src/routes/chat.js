import { Router } from "express";
import { getClient } from "../openclawClient.js";
import { loadPersona } from "../utils/persona.js";
import { sanitizeChatAnswer } from "../utils/sanitizeChatAnswer.js";

export const chatRouter = Router();

chatRouter.post("/ask", async (req, res) => {
  const { question, sessionKey: providedSessionKey, agentId: providedAgentId } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Field 'question' (string) is required." });
  }

  const agentId = providedAgentId?.trim() || "main";
  // Stable per-agent key so we can reliably reset history before each call.
  const sessionKey = providedSessionKey || `agent:${agentId}:chat:opener`;

  const persona = loadPersona();
  const options = {
    sessionKey,
    agentId,
    ...(persona ? { extraSystemPrompt: persona } : {}),
  };

  try {
    const client = await getClient();
    // Each opener is independent — wipe prior turns so persona examples drive every reply.
    await client.sessions.reset(sessionKey, { reason: "new" }).catch(() => {});
    const raw = await client.chatSync(question, options);
    res.json({ answer: sanitizeChatAnswer(raw) });
  } catch (err) {
    console.error("[chat:ask]", err);
    res.status(502).json({ error: err.message });
  }
});

chatRouter.post("/stream", async (req, res) => {
  const { question, sessionKey: providedSessionKey, agentId: providedAgentId } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    return res.status(400).json({ error: "Field 'question' (string) is required." });
  }

  const agentId = providedAgentId?.trim() || "main";
  const sessionKey = providedSessionKey || `agent:${agentId}:chat:opener`;

  const persona = loadPersona();
  const options = {
    sessionKey,
    agentId,
    ...(persona ? { extraSystemPrompt: persona } : {}),
  };

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
    await client.sessions.reset(sessionKey, { reason: "new" }).catch(() => {});
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