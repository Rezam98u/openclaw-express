/** E.164: + then 7–15 digits (ITU-T E.164). */
const E164_RE = /^\+[1-9]\d{6,14}$/;

export function isValidE164(to) {
  return typeof to === "string" && E164_RE.test(to.trim());
}

export function normalizeE164(to) {
  return String(to).trim();
}

/**
 * Same key the gateway builds for an inbound WhatsApp DM when
 * `session.dmScope` is "per-channel-peer", so Express and the gateway share
 * one conversation per contact.
 * @param {string} agentId
 * @param {string} e164
 */
export function buildWhatsAppDmSessionKey(agentId, e164) {
  const id = agentId.trim() || "main";
  return `agent:${id}:whatsapp:direct:${normalizeE164(e164).toLowerCase()}`;
}

/**
 * Parses a comma/space separated list of E.164 numbers (e.g. AUTOPILOT_NUMBERS).
 * Invalid entries are dropped.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseE164List(raw) {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map(normalizeE164)
    .filter(isValidE164);
}
