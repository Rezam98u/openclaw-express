import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeChatAnswer } from "../src/utils/sanitizeChatAnswer.js";
import {
  buildWhatsAppDmSessionKey,
  isValidE164,
  normalizeE164,
  parseE164List,
} from "../src/utils/whatsappSession.js";
import { collectAgentTextStream } from "../src/utils/agentStreamCollect.js";
import { formatTranscript, toConversation } from "../src/utils/conversation.js";
import { PERSONA_MAX_CHARS, buildPersona, composePersona } from "../src/utils/persona.js";

test("sanitizeChatAnswer: non-strings and blanks", () => {
  assert.equal(sanitizeChatAnswer(undefined), "");
  assert.equal(sanitizeChatAnswer(null), "");
  assert.equal(sanitizeChatAnswer("   "), "");
  assert.equal(sanitizeChatAnswer("  hey there  "), "hey there");
});

test("sanitizeChatAnswer: unwraps thinking tags and orphan prefixes", () => {
  assert.equal(sanitizeChatAnswer("<think>Bold move.</think>"), "Bold move.");
  assert.equal(sanitizeChatAnswer("<final> You again?"), "You again?");
});

test("sanitizeChatAnswer: long meta ramble keeps the last clean line", () => {
  const raw = [
    "I need to check AGENTS.md and follow the OUTPUT RULES before answering.",
    "I should also keep it under 35 words per the examples in the workspace.",
    "x".repeat(200),
    "Are you always this mysterious, or is it just for me?",
  ].join("\n");
  assert.equal(sanitizeChatAnswer(raw), "Are you always this mysterious, or is it just for me?");
});

test("whatsappSession: E.164 validation and session keys", () => {
  assert.ok(isValidE164("+491511234567"));
  assert.ok(isValidE164(" +989121234567 "));
  for (const bad of ["491511234567", "+0123456789", "+12", "+1234567890123456", 491511234567, null]) {
    assert.equal(isValidE164(bad), false, `expected invalid: ${bad}`);
  }
  assert.equal(normalizeE164(" +491511234567 "), "+491511234567");
  assert.equal(buildWhatsAppDmSessionKey("main", "+491511234567"), "agent:main:whatsapp:direct:+491511234567");
  assert.equal(buildWhatsAppDmSessionKey("  ", "+491511234567"), "agent:main:whatsapp:direct:+491511234567");
});

test("whatsappSession: parseE164List keeps valid numbers only", () => {
  assert.deepEqual(parseE164List("+491511234567, +989121234567 nope,,0151"), ["+491511234567", "+989121234567"]);
  assert.deepEqual(parseE164List(undefined), []);
});

test("collectAgentTextStream: joins text and reports errors", async () => {
  async function* stream(chunks) {
    yield* chunks;
  }
  assert.deepEqual(
    await collectAgentTextStream(stream([{ type: "text", text: "Hi " }, { type: "tool_use" }, { type: "text", text: "there" }, { type: "done" }])),
    { answer: "Hi there", streamError: null }
  );
  assert.deepEqual(
    await collectAgentTextStream(stream([{ type: "text", text: "partial" }, { type: "error", text: " quota " }])),
    { answer: "partial", streamError: "quota" }
  );
  assert.equal((await collectAgentTextStream(stream([{ type: "error" }]))).streamError, "Agent stream reported an error.");
});

test("conversation: maps gateway history to match/me turns and a transcript", () => {
  const history = [
    { role: "assistant", content: [{ type: "text", text: "Hiking or puns first?" }], timestamp: 1 },
    { role: "user", content: " Puns, obviously ", timestamp: 2 },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan..." }, { type: "text", text: "Bold choice." }], timestamp: 3 },
    { role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }], timestamp: 4 },
    { role: "toolResult", content: "ignored", timestamp: 5 },
  ];
  const convo = toConversation(history);
  assert.deepEqual(convo, [
    { from: "me", text: "Hiking or puns first?", timestamp: 1 },
    { from: "match", text: "Puns, obviously", timestamp: 2 },
    { from: "me", text: "Bold choice.", timestamp: 3 },
  ]);
  assert.equal(formatTranscript(convo), "Me: Hiking or puns first?\nThem: Puns, obviously\nMe: Bold choice.");
  assert.deepEqual(toConversation(undefined), []);
});

test("composePersona: core always in full, examples only while they fit the budget", () => {
  const core = "CORE RULES";
  const examples = ["short one", "a much longer example line here", "tiny"];
  const inOrder = () => 0.999; // keeps the shuffle in its original order

  // Room for everything
  let persona = composePersona(core, examples, { maxChars: 1000, random: inOrder });
  assert.equal(persona, "CORE RULES\n\nExamples (tone only):\nshort one\na much longer example line here\ntiny");

  // The long example doesn't fit, but the shorter one after it still does
  persona = composePersona(core, examples, { maxChars: 50, random: inOrder });
  assert.equal(persona, "CORE RULES\n\nExamples (tone only):\nshort one\ntiny");
  assert.ok(persona.length <= 50);

  // No example fits: core alone, without a dangling header
  assert.equal(composePersona(core, examples, { maxChars: 20, random: inOrder }), core);

  // No examples, or no core
  assert.equal(composePersona(core, [], { maxChars: 1000 }), core);
  assert.equal(composePersona("", examples, { maxChars: 1000 }), "");
});

test("composePersona: picks a random subset, never more than the budget", () => {
  const examples = Array.from({ length: 500 }, (_, i) => `example number ${i} with some words`);
  const a = composePersona("CORE", examples, { maxChars: 4400 });
  const b = composePersona("CORE", examples, { maxChars: 4400 });
  assert.ok(a.length <= 4400 && b.length <= 4400);
  assert.ok(a.length > 4000, "fills most of the budget");
  assert.notEqual(a, b, "different requests get different examples");
});

test("persona.txt + persona-examples.txt stay within the per-request budget", () => {
  const persona = buildPersona();
  assert.ok(persona.length > 0, "persona.txt must not be empty");
  assert.ok(persona.length <= PERSONA_MAX_CHARS, `persona sent to the model is ${persona.length} chars`);
  assert.match(persona, /Examples \(tone only\):\n\S/, "persona.txt must leave room for at least one example");
});
