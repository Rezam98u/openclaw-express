// Prints the gateway config patch for WhatsApp autopilot, built from persona.txt (+ examples
// from persona-examples.txt, within the same 4,400-character budget Express uses) and
// AUTOPILOT_NUMBERS, so the gateway's copy of the persona never drifts by hand. The gateway
// prompt is fixed between syncs: rerun the sync to rotate which examples it gets.
// Apply with `npm run whatsapp:sync` (or `npm run whatsapp:sync:dry` to validate only).
//
// What it sets in ~/.openclaw/openclaw.json:
//   session.dmScope = "per-channel-peer"   one session per match (default "main" mixes all DMs)
//   session.maintenance.pruneAfter = "3650d"
//                                          keep every match's conversation live (the default "30d"
//                                          archives a conversation after a month of silence)
//   channels.whatsapp.dmPolicy = "allowlist", allowFrom = AUTOPILOT_NUMBERS
//                                          only listed matches are answered; no pairing codes
//   channels.whatsapp.direct = { "*": { systemPrompt: persona } }
//                                          one persona for every admitted DM (replaces the map)
//   channels.whatsapp.dmHistoryLimit = 20  only the last 20 turns of a match go to the model; the
//                                          full conversation stays stored
//   agents.defaults.thinkingDefault = "low"
//                                          less hidden reasoning: fewer tokens, faster, fewer leaks
//   agents.defaults.heartbeat = { every: "0m", target: "none" }
//                                          no background heartbeat turns: by default one runs every
//                                          30 min and messages the owner (the test number), which
//                                          put a "heartbeat alert" and unprompted texts into a match
//                                          chat and used up Groq tokens
//   skills.workshop.autonomous.mode = "off"
//                                          no weekly "Skill collection review" job (model calls)
//   plugins.entries["memory-core"].config.dreaming.enabled = false
//                                          no nightly "Memory Dreaming" job (model calls)
//
// dmHistoryLimit, thinkingDefault and the background jobs being off keep requests inside Groq's free tier
// (8,000 tokens per minute, and a single request may not exceed that either).
import { buildPersona, getPersonaPath } from "../src/utils/persona.js";
import { buildWhatsappAutopilotPatch } from "../src/utils/whatsappAutopilotPatch.js";
import { parseE164List } from "../src/utils/whatsappSession.js";

// stdout carries the patch to `config patch --stdin`; send log lines to stderr instead.
console.log = console.error;

const persona = buildPersona();
const numbers = parseE164List(process.env.AUTOPILOT_NUMBERS);

if (!persona) {
  console.error(`[whatsapp:sync] ${getPersonaPath()} is empty; refusing to clear the gateway prompt.`);
  process.exit(1);
}
if (!numbers.length) {
  console.error("[whatsapp:sync] AUTOPILOT_NUMBERS has no valid E.164 numbers; nobody would be answered.");
  process.exit(1);
}

const patch = buildWhatsappAutopilotPatch(persona, numbers);

process.stdout.write(JSON.stringify(patch, null, 2) + "\n");
