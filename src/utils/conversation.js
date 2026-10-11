/**
 * Turns gateway `sessions.history` messages into a plain conversation.
 * User turns are the match's messages; assistant turns are what "I" sent.
 * Thinking blocks and empty turns are dropped.
 *
 * @param {Array<{ role?: string; content?: unknown; timestamp?: number }>} messages
 * @returns {Array<{ from: "match" | "me"; text: string; timestamp: number | null }>}
 */
export function toConversation(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({
      from: m.role === "user" ? "match" : "me",
      text: contentText(m.content),
      timestamp: typeof m.timestamp === "number" ? m.timestamp : null,
    }))
    .filter((m) => m.text);
}

/** "Them: …" / "Me: …" lines, for putting the conversation into a prompt. */
export function formatTranscript(conversation) {
  return conversation.map((m) => `${m.from === "match" ? "Them" : "Me"}: ${m.text}`).join("\n");
}

function contentText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}
