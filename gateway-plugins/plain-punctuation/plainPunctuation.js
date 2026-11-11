// Shared by the gateway plugin (index.js) and Express (src/utils/sanitizeChatAnswer.js).
// No imports: the gateway container sees only this folder.

/**
 * Long dashes and semicolons make a text read as AI-written, and gpt-oss uses them even when
 * the persona forbids them. Turn them into commas, and its non-breaking hyphen ("go‑to") into "-".
 */
export function plainPunctuation(text) {
  return text
    .replace(/‑/g, "-")
    .replace(/\s*[—–;]\s*/g, ", ")
    .replace(/,\s*([?!.,])/g, "$1")
    .replace(/,\s*$/, "");
}

/** `message_sending` hook: the rewritten content, or nothing when there is nothing to change. */
export function cleanOutgoingMessage(event) {
  if (typeof event?.content !== "string") return undefined;
  const content = plainPunctuation(event.content);
  return content === event.content ? undefined : { content };
}
