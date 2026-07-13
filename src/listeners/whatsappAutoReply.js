import { loadPersona } from "../utils/persona.js";
import { sanitizeChatAnswer } from "../utils/sanitizeChatAnswer.js";
import { buildWhatsAppDmSessionKey, isValidE164 } from "../utils/whatsappSession.js";

/**
 * Attaches a listener to the OpenClaw WebSocket client that:
 *  1. Watches for incoming WhatsApp messages from WHATSAPP_TARGET_NUMBER
 *  2. Feeds the message to the AI with the dating-coach persona
 *  3. Delivers the AI reply back to that WhatsApp number
 *
 * Set WHATSAPP_DEBUG_EVENTS=true in .env to log all raw gateway events —
 * useful for confirming the exact event name and payload shape on first run.
 */
export function startWhatsAppAutoReply(client) {
  const target = process.env.WHATSAPP_TARGET_NUMBER?.trim();
  const debugEvents = process.env.WHATSAPP_DEBUG_EVENTS === "true";

  if (!target) {
    console.log("[whatsapp:auto] WHATSAPP_TARGET_NUMBER not set — auto-reply disabled.");
    return;
  }
  if (!isValidE164(target)) {
    console.warn(`[whatsapp:auto] WHATSAPP_TARGET_NUMBER "${target}" is not valid E.164 — auto-reply disabled.`);
    return;
  }

  // Normalise for comparison: strip leading "+" for chatId matching
  const targetDigits = target.replace(/^\+/, "");

  console.log(`[whatsapp:auto] Listening for incoming WhatsApp messages from ${target}`);
  if (debugEvents) {
    console.log("[whatsapp:auto] WHATSAPP_DEBUG_EVENTS=true — all gateway events will be logged.");
  }

  // Guard against concurrent AI calls for the same contact
  let busy = false;

  client.on("event", async (evt) => {
    if (debugEvents) {
      console.log("[whatsapp:auto][debug event]", JSON.stringify(evt, null, 2));
    }

    const payload = evt.payload ?? {};

    // #region agent log
    // H-A: log every non-tick event name so we can confirm the real incoming message event
    if (evt.event !== "tick" && evt.event !== "state") {
      fetch('http://127.0.0.1:7676/ingest/fcf447b1-6f61-4713-a26a-5f30796a09a3', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c8dd67' }, body: JSON.stringify({ sessionId: 'c8dd67', location: 'whatsappAutoReply.js:event', message: 'non-tick event received', data: { event: evt.event, payloadKeys: Object.keys(payload), channel: payload.channel, platform: payload.platform, direction: payload.direction, from: payload.from, sender: payload.sender, chatId: payload.chatId, hasText: !!(payload.text ?? payload.body ?? payload.message) }, timestamp: Date.now(), hypothesisId: 'H-A' }) }).catch(() => { });
    }
    // #endregion

    // Match any event name that looks like an incoming channel message.
    // Common names seen in the wild: "channel:message", "whatsapp:message", "message".
    // The debug log above will reveal the exact name on your gateway.
    const isChannelMessage =
      typeof evt.event === "string" &&
      (evt.event.includes("message") || evt.event.includes("channel"));

    // #region agent log
    // H-A + H-B: log when a candidate event passes/fails the isChannelMessage filter
    if (evt.event !== "tick" && evt.event !== "state") {
      fetch('http://127.0.0.1:7676/ingest/fcf447b1-6f61-4713-a26a-5f30796a09a3', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c8dd67' }, body: JSON.stringify({ sessionId: 'c8dd67', location: 'whatsappAutoReply.js:isChannelMessage', message: 'isChannelMessage filter result', data: { event: evt.event, isChannelMessage, channel: payload.channel, platform: payload.platform }, timestamp: Date.now(), hypothesisId: 'H-B' }) }).catch(() => { });
    }
    // #endregion

    if (!isChannelMessage) return;

    // Must be WhatsApp
    if (payload.channel !== "whatsapp" && payload.platform !== "whatsapp") return;

    // Must be inbound (not something we sent)
    if (payload.direction === "outbound") return;

    // Must be from the target number
    const from = String(payload.from ?? payload.sender ?? payload.chatId ?? "");
    const matchesTarget =
      from === target ||
      from.replace(/^\+/, "") === targetDigits ||
      from.includes(targetDigits);

    // #region agent log
    // H-C: log from field and match result
    fetch('http://127.0.0.1:7676/ingest/fcf447b1-6f61-4713-a26a-5f30796a09a3', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c8dd67' }, body: JSON.stringify({ sessionId: 'c8dd67', location: 'whatsappAutoReply.js:fromMatch', message: 'from field and match result', data: { from, target, targetDigits, matchesTarget, direction: payload.direction }, timestamp: Date.now(), hypothesisId: 'H-C' }) }).catch(() => { });
    // #endregion

    if (!matchesTarget) return;

    // Extract message text
    const text = (payload.text ?? payload.body ?? payload.message ?? "").trim();
    if (!text) return;

    if (busy) {
      console.warn(`[whatsapp:auto] Still processing previous message — skipping: "${text.slice(0, 40)}"`);
      return;
    }

    busy = true;
    const sessionKey = buildWhatsAppDmSessionKey("main", target);
    const persona = loadPersona();

    try {
      console.log(`[whatsapp:auto] Received from ${target}: "${text.slice(0, 80)}"`);

      // Fresh session per message — each opener is independent
      await client.sessions.reset(sessionKey, { reason: "new" }).catch(() => { });

      const raw = await client.chatSync(text, {
        sessionKey,
        agentId: "main",
        ...(persona ? { extraSystemPrompt: persona } : {}),
      });

      const reply = sanitizeChatAnswer(raw);

      // #region agent log
      // H-D: log raw AI output and sanitized reply
      fetch('http://127.0.0.1:7676/ingest/fcf447b1-6f61-4713-a26a-5f30796a09a3', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c8dd67' }, body: JSON.stringify({ sessionId: 'c8dd67', location: 'whatsappAutoReply.js:aiReply', message: 'AI raw and sanitized reply', data: { rawLength: raw?.length, rawPreview: String(raw ?? '').slice(0, 200), reply, replyEmpty: !reply }, timestamp: Date.now(), hypothesisId: 'H-D' }) }).catch(() => { });
      // #endregion

      if (!reply) {
        console.warn("[whatsapp:auto] AI returned empty reply — not sending.");
        return;
      }

      // Deliver reply to WhatsApp
      const deliverChunks = [];
      for await (const chunk of client.chat(reply, {
        sessionKey,
        agentId: "main",
        deliver: true,
        channel: "whatsapp",
      })) {
        deliverChunks.push(chunk.type);
        if (chunk.type === "done" || chunk.type === "error") break;
      }

      // #region agent log
      // H-E: log delivery chunk sequence to verify deliver worked
      fetch('http://127.0.0.1:7676/ingest/fcf447b1-6f61-4713-a26a-5f30796a09a3', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c8dd67' }, body: JSON.stringify({ sessionId: 'c8dd67', location: 'whatsappAutoReply.js:deliver', message: 'deliver chunk sequence', data: { deliverChunks, reply }, timestamp: Date.now(), hypothesisId: 'H-E' }) }).catch(() => { });
      // #endregion

      console.log(`[whatsapp:auto] Replied to ${target}: "${reply.slice(0, 80)}"`);
    } catch (err) {
      console.error("[whatsapp:auto] Error generating/sending reply:", err.message);
      // #region agent log
      fetch('http://127.0.0.1:7676/ingest/fcf447b1-6f61-4713-a26a-5f30796a09a3', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c8dd67' }, body: JSON.stringify({ sessionId: 'c8dd67', location: 'whatsappAutoReply.js:catch', message: 'error in handler', data: { error: err.message }, timestamp: Date.now(), hypothesisId: 'H-E' }) }).catch(() => { });
      // #endregion
    } finally {
      busy = false;
    }
  });
}
