import crypto from "crypto";
import { Router } from "express";
import { getClient } from "../openclawClient.js";
import { buildPersona } from "../utils/persona.js";
import { sanitizeChatAnswer } from "../utils/sanitizeChatAnswer.js";
import { collectAgentTextStream } from "../utils/agentStreamCollect.js";

// Coach endpoint (Option A, "the AI helps you"): `question` is what the match wrote, the answer
// is a reply the user can send themselves. Nothing is sent to WhatsApp.
//
// Each request runs in its own throwaway session (agent:<id>:coach:<uuid>), deleted afterwards:
// every reply is a single fresh turn driven by the persona, concurrent requests can't clobber
// each other, and callers can't name (and wipe) another session such as a match's autopilot
// conversation.
export const chatRouter = Router();

const prepare = (req, res) => {
  const { question, agentId: providedAgentId } = req.body || {};
  if (typeof question !== "string" || !question.trim()) {
    res.status(400).json({ error: "Field 'question' (string) is required." });
    return null;
  }
  const agentId = providedAgentId?.trim() || "main";
  const persona = buildPersona();
  return {
    question,
    sessionKey: `agent:${agentId}:coach:${crypto.randomUUID()}`,
    options: { agentId, ...(persona ? { extraSystemPrompt: persona } : {}) },
  };
};

const discard = (client, sessionKey) =>
  client?.sessions.delete(sessionKey, { deleteTranscript: true }).catch(() => { });

chatRouter.post("/ask", async (req, res) => {
  const run = prepare(req, res);
  if (!run) return;

  let client;
  try {
    client = await getClient();
    // chatSync resolves to "" when the run fails, so collect the stream to see error chunks.
    const { answer, streamError } = await collectAgentTextStream(
      client.chat(run.question, { ...run.options, sessionKey: run.sessionKey })
    );
    if (streamError) {
      return res.status(502).json({ error: "Agent run failed.", detail: streamError });
    }
    res.json({ answer: sanitizeChatAnswer(answer) });
  } catch (err) {
    console.error("[chat:ask]", err);
    res.status(502).json({ error: err.message });
  } finally {
    discard(client, run.sessionKey);
  }
});

chatRouter.post("/stream", async (req, res) => {
  const run = prepare(req, res);
  if (!run) return;

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

  let client;
  try {
    client = await getClient();
    const stream = client.chat(run.question, { ...run.options, sessionKey: run.sessionKey });

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
    discard(client, run.sessionKey);
  }
});
