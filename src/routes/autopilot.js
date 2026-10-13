import crypto from "crypto";
import { Router } from "express";
import { getClient } from "../openclawClient.js";
import { buildPersona } from "../utils/persona.js";
import { sanitizeChatAnswer } from "../utils/sanitizeChatAnswer.js";
import { collectAgentTextStream } from "../utils/agentStreamCollect.js";
import { formatTranscript, toConversation } from "../utils/conversation.js";
import {
  buildWhatsAppDmSessionKey,
  isValidE164,
  normalizeE164,
  parseE164List,
} from "../utils/whatsappSession.js";

export const autopilotRouter = Router();

// How many recent messages to show the model when continuing a conversation. Kept small:
// Groq's free tier caps a whole request at 8,000 tokens.
const CONTEXT_MESSAGES = 12;

// Validates `to` (body or URL) against AUTOPILOT_NUMBERS; sends the error response itself.
const resolveMatch = (to, res) => {
  if (!isValidE164(to)) {
    res.status(400).json({ error: "Valid E.164 'to' field required." });
    return null;
  }
  const recipient = normalizeE164(to);
  if (!parseE164List(process.env.AUTOPILOT_NUMBERS).includes(recipient)) {
    res.status(403).json({ error: "Number is not in AUTOPILOT_NUMBERS." });
    return null;
  }
  return recipient;
};

// Autopilot: the AI texts a match as the user. Each match has one durable conversation,
// the gateway session agent:<id>:whatsapp:direct:<e164>; the gateway stores it and answers
// the match's replies on its own (channels.whatsapp.direct["*"]). This route sends *our* next
// message into that conversation:
//   - new number (no history)   -> opener, starting the conversation from scratch
//   - existing conversation     -> next message, continuing from the stored history
//   - { restart: true }         -> wipe the conversation, then send a fresh opener
// The message is drafted in a throwaway session, sanitized (leaked planning text never reaches
// the match), then sent verbatim with the gateway's `send` RPC; `sessionKey` mirrors it into
// the match's transcript so the conversation stays complete.
autopilotRouter.post("/message", async (req, res) => {
  const { to, context, agentId: providedAgentId, send, restart } = req.body || {};
  // Preview mode: { "send": false } drafts the message without sending or changing anything.
  const shouldSend = send !== false && send !== "false";
  const shouldRestart = restart === true || restart === "true";
  if (context !== undefined && typeof context !== "string") {
    return res.status(400).json({ error: "Field 'context' must be a string." });
  }
  const recipient = resolveMatch(to, res);
  if (!recipient) return;

  const agentId = providedAgentId?.trim() || "main";
  const sessionKey = buildWhatsAppDmSessionKey(agentId, recipient);
  const draftKey = `agent:${agentId}:autopilot:draft:${crypto.randomUUID()}`;
  const persona = buildPersona();

  let client;
  try {
    client = await getClient();

    const conversation = shouldRestart
      ? []
      : toConversation((await client.sessions.history(sessionKey, { limit: CONTEXT_MESSAGES })).messages);
    const mode = conversation.length ? "continue" : "opener";

    const instruction = [
      "[Note from the user, not from the match]",
      mode === "opener"
        ? "Start the conversation with this new match. Write the first message I send them."
        : `Our conversation so far:\n${formatTranscript(conversation)}\n\nWrite my next message to keep the conversation going. Don't repeat anything I already said.`,
      context?.trim() ? `What I know about them: ${context.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const { answer, streamError } = await collectAgentTextStream(
      client.chat(instruction, {
        sessionKey: draftKey,
        agentId,
        ...(persona ? { extraSystemPrompt: persona } : {}),
      })
    );
    if (streamError) {
      return res.status(502).json({ error: "Agent run failed.", detail: streamError });
    }

    const message = sanitizeChatAnswer(answer);
    if (!message) return res.status(502).json({ error: "Agent returned an empty message." });
    if (!shouldSend) return res.json({ mode, message, to: recipient, sessionKey, sent: false });

    if (shouldRestart) await client.sessions.reset(sessionKey, { reason: "new" }).catch(() => {});
    const { payload } = await client.request("send", {
      to: recipient,
      message,
      channel: "whatsapp",
      agentId,
      sessionKey,
      idempotencyKey: crypto.randomUUID(),
    });

    console.log(`[autopilot:message] Sent ${mode} to ${recipient}`);
    res.json({ mode, message, to: recipient, sessionKey, sent: true, result: payload ?? null });
  } catch (err) {
    console.error("[autopilot:message]", err);
    res.status(502).json({ error: "Gateway failed.", detail: err.message });
  } finally {
    // The draft session is scratch space; don't let one accumulate per message.
    client?.sessions.delete(draftKey, { deleteTranscript: true }).catch(() => {});
  }
});

// The stored conversation with one match, oldest first (from the gateway's transcript).
autopilotRouter.get("/conversations/:to", async (req, res) => {
  const recipient = resolveMatch(req.params.to, res);
  if (!recipient) return;

  const agentId = (typeof req.query.agentId === "string" && req.query.agentId.trim()) || "main";
  const sessionKey = buildWhatsAppDmSessionKey(agentId, recipient);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);

  try {
    const client = await getClient();
    const history = await client.sessions.history(sessionKey, { limit });
    res.json({
      to: recipient,
      sessionKey,
      totalMessages: history.totalMessages ?? null,
      messages: toConversation(history.messages),
    });
  } catch (err) {
    console.error("[autopilot:conversation]", err);
    res.status(502).json({ error: "Gateway failed.", detail: err.message });
  }
});
