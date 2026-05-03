/**
 * Consumes OpenClawClient.chat() async iterator (chunk types: text, error, done, ...).
 *
 * @param {AsyncIterable<{ type: string; text?: string }>} stream
 * @returns {Promise<{ answer: string; streamError: string | null }>}
 */
export async function collectAgentTextStream(stream) {
  let answer = "";
  let streamError = null;

  for await (const chunk of stream) {
    if (chunk.type === "text") {
      answer += chunk.text;
    } else if (chunk.type === "error") {
      const t = chunk.text?.trim();
      streamError = t || "Agent stream reported an error.";
    }
  }

  return { answer, streamError };
}
