// Adds a match to autopilot: appends the number to AUTOPILOT_NUMBERS in .env, then runs
// `npm run whatsapp:sync` so the gateway answers them too.
//   npm run match:add -- +491511234567
// Restart Express afterwards (it reads .env at startup). The match's conversation starts from
// scratch with the first POST /api/autopilot/message.
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { isValidE164, normalizeE164, parseE164List } from "../src/utils/whatsappSession.js";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
const number = process.argv[2];

if (!isValidE164(number)) {
  console.error("Usage: npm run match:add -- +<country><number>   (E.164, e.g. +491511234567)");
  process.exit(1);
}
const match = normalizeE164(number);

const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n") : [];
const idx = lines.findIndex((l) => /^AUTOPILOT_NUMBERS=/.test(l));
const current = idx >= 0 ? parseE164List(lines[idx].slice("AUTOPILOT_NUMBERS=".length)) : [];

if (current.includes(match)) {
  console.log(`[match:add] ${match} is already in AUTOPILOT_NUMBERS.`);
} else {
  const line = `AUTOPILOT_NUMBERS=${[...current, match].join(",")}`;
  if (idx >= 0) lines[idx] = line;
  else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, line);
  fs.writeFileSync(envPath, lines.join("\n"));
  console.log(`[match:add] Added ${match} to AUTOPILOT_NUMBERS (${current.length + 1} total).`);
}

execSync("npm run -s whatsapp:sync", { stdio: "inherit", cwd: path.dirname(envPath) });
console.log("[match:add] Gateway updated. Restart Express so it picks up the new AUTOPILOT_NUMBERS.");
