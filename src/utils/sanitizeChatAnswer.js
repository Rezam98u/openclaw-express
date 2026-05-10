/**
 * Best-effort cleanup when the gateway model leaks planning, tags, or workspace refs.
 */
const META_LINE =
  /AGENTS\.md|SOUL\.md|USER\.md|MEMORY\.md|`RULES`|OUTPUT RULES|per the examples|I will craft|I need to|I should also|chain-of-thought/i;

export function sanitizeChatAnswer(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (!s) return s;

  // Strip paired thinking / tag blocks at the start (repeat a few times).
  const pairedXml =
    /^<(?:think|redacted_thinking|thinking)[^>]*>([\s\S]*?)<\/(?:think|redacted_thinking|thinking)>/i;
  for (let i = 0; i < 5; i++) {
    const m = s.match(pairedXml);
    if (!m) break;
    s = m[1].trim();
  }

  // Orphan opening "<...>" prefix (incomplete tag / leaked token).
  if (s.startsWith("<")) {
    const gt = s.indexOf(">");
    if (gt > 0 && gt < 500) s = s.slice(gt + 1).trim();
  }

  // Long ramble that cites workspace or narrates planning — keep last clean short line.
  if (s.length > 280 && META_LINE.test(s)) {
    const lines = s.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.length > 320) continue;
      if (META_LINE.test(line)) continue;
      if (/^[`#*\-]{1,3}\s/.test(line)) continue;
      return line;
    }
    // Single blob with newlines escaped as \n — try sentence tail.
    const parts = s.split(/(?<=[.?!])\s+/).map((p) => p.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.length > 320 || p.length < 8) continue;
      if (META_LINE.test(p)) continue;
      return p;
    }
  }

  return s.trim();
}
