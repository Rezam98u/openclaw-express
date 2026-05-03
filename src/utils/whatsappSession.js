/** E.164: + then 7–15 digits (ITU-T E.164). */
const E164_RE = /^\+[1-9]\d{6,14}$/;

export function isValidE164(to) {
  return typeof to === "string" && E164_RE.test(to.trim());
}

export function normalizeE164(to) {
  return String(to).trim();
}

/**
 * @param {string} agentId
 * @param {string} e164
 */
export function buildWhatsAppDmSessionKey(agentId, e164) {
  const id = agentId.trim() || "main";
  return `agent:${id}:whatsapp:dm:${normalizeE164(e164)}`;
}
