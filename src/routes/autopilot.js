import crypto from "crypto";
import { Router } from "express";
import { getClient } from "../openclawClient.js";
import { loadPersona } from "../utils/persona.js";
import { sanitizeChatAnswer } from "../utils/sanitizeChatAnswer.js";
import { collectAgentTextStream } from "../utils/agentStreamCollect.js";
import {
  buildWhatsAppDmSessionKey,
  isValidE164,
  normalizeE164,
  parseE164List,
} from "../utils/whatsappSession.js";

export const autopilotRouter = Router();

// Autopilot: the AI texts a match as the user. Express only sends the opener;
// the match's replies are answered by the gateway itself (channels.whatsapp.direct["*"]).
//   1. Draft the opener in a throwaway session (persona as extraSystemPrompt, no delivery).
//   2. Sanitize it, so leaked planning text never reaches the match.
//   3. Reset the match's DM session (new conversation) and send exactly that text with the
//      gateway's `send` RPC. `sessionKey` mirrors it into the match's transcript, so the
//      gateway's later replies know what "we" said.
autopilotRouter.post("/opener", async (req, res) => {
  const { to, context, agentId: providedAgentId, send } = req.body || {};
  // Preview mode: { "send": false } drafts the opener without messaging anyone.
  const shouldSend = send !== false && send !== "false";
  if (!isValidE164(to)) return res.status(400).json({ error: "Valid E.164 'to' field required." });
  if (context !== undefined && typeof context !== "string") {
    return res.status(400).json({ error: "Field 'context' must be a string." });
  }

  const recipient = normalizeE164(to);
  if (!parseE164List(process.env.AUTOPILOT_NUMBERS).includes(recipient)) {
    return res.status(403).json({ error: "Number is not in AUTOPILOT_NUMBERS." });
  }

  const agentId = providedAgentId?.trim() || "main";
  const sessionKey = buildWhatsAppDmSessionKey(agentId, recipient);
  const draftKey = `agent:${agentId}:autopilot:draft:${crypto.randomUUID()}`;
  const persona = loadPersona();

  const instruction = [
    "[Note from the user, not from the match] Start the conversation with this new match.",
    "Write the first message I send them.",
    context?.trim() ? `What I know about them: ${context.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  let client;
  try {
    client = await getClient();
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
    if (!message) return res.status(502).json({ error: "Agent returned an empty opener." });
    if (!shouldSend) return res.json({ message, to: recipient, sessionKey, sent: false });

    await client.sessions.reset(sessionKey, { reason: "new" }).catch(() => {});
    const { payload } = await client.request("send", {
      to: recipient,
      message,
      channel: "whatsapp",
      agentId,
      sessionKey,
      idempotencyKey: crypto.randomUUID(),
    });

    console.log(`[autopilot:opener] Sent opener to ${recipient}`);
    res.json({ message, to: recipient, sessionKey, sent: true, result: payload ?? null });
  } catch (err) {
    console.error("[autopilot:opener]", err);
    res.status(502).json({ error: "Gateway failed.", detail: err.message });
  } finally {
    // The draft session is scratch space; don't let one accumulate per opener.
    client?.sessions.delete(draftKey, { deleteTranscript: true }).catch(() => {});
  }
});
