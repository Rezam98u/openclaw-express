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

    // Match any event name that looks like an incoming channel message.
    // Common names seen in the wild: "channel:message", "whatsapp:message", "message".
    // Set WHATSAPP_DEBUG_EVENTS=true to reveal the exact name on your gateway.
    const isChannelMessage =
      typeof evt.event === "string" &&
      (evt.event.includes("message") || evt.event.includes("channel"));

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

      if (!reply) {
        console.warn("[whatsapp:auto] AI returned empty reply — not sending.");
        return;
      }

      // Deliver reply to WhatsApp
      for await (const chunk of client.chat(reply, {
        sessionKey,
        agentId: "main",
        deliver: true,
        channel: "whatsapp",
      })) {
        if (chunk.type === "done" || chunk.type === "error") break;
      }

      console.log(`[whatsapp:auto] Replied to ${target}: "${reply.slice(0, 80)}"`);
    } catch (err) {
      console.error("[whatsapp:auto] Error generating/sending reply:", err.message);
    } finally {
      busy = false;
    }
  });
}
