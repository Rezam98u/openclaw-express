// Prints the gateway config patch for WhatsApp autopilot, built from persona.txt and
// AUTOPILOT_NUMBERS, so the gateway's copy of the persona never drifts by hand.
// Apply with `npm run whatsapp:sync` (or `npm run whatsapp:sync:dry` to validate only).
//
// What it sets in ~/.openclaw/openclaw.json:
//   session.dmScope = "per-channel-peer"   one session per match (default "main" mixes all DMs)
//   channels.whatsapp.dmPolicy = "allowlist", allowFrom = AUTOPILOT_NUMBERS
//                                          only listed matches are answered; no pairing codes
//   channels.whatsapp.direct = { "*": { systemPrompt: persona } }
//                                          one persona for every admitted DM (replaces the map)
import fs from "fs";
import { getPersonaPath } from "../src/utils/persona.js";
import { parseE164List } from "../src/utils/whatsappSession.js";

const persona = fs.readFileSync(getPersonaPath(), "utf8").trim();
const numbers = parseE164List(process.env.AUTOPILOT_NUMBERS);

if (!persona) {
  console.error(`[whatsapp:sync] ${getPersonaPath()} is empty; refusing to clear the gateway prompt.`);
  process.exit(1);
}
if (!numbers.length) {
  console.error("[whatsapp:sync] AUTOPILOT_NUMBERS has no valid E.164 numbers; nobody would be answered.");
  process.exit(1);
}

const patch = {
  session: { dmScope: "per-channel-peer" },
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: numbers,
      direct: { "*": { systemPrompt: persona } },
    },
  },
};

process.stdout.write(JSON.stringify(patch, null, 2) + "\n");
