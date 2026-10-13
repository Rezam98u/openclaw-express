import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const personaPath =
  process.env.PERSONA_FILE_PATH ||
  path.resolve(__dirname, "..", "..", "persona.txt");

// The example bank sits next to persona.txt and may grow without limit.
const examplesPath = path.join(path.dirname(personaPath), "persona-examples.txt");

// Most characters of persona text sent to the model per request (core + examples).
// Keeps every reply's cost fixed, however large the example bank grows.
export const PERSONA_MAX_CHARS = 4400;

const EXAMPLES_HEADER = "\n\nExamples (tone only):";

/**
 * Core rules plus as many examples as fit in `maxChars`, taken in random order.
 * The core is always included in full; an example that doesn't fit is skipped,
 * so shorter ones later in the order can still fill the remaining space.
 */
export function composePersona(core, examples, { maxChars = PERSONA_MAX_CHARS, random = Math.random } = {}) {
  if (!core || !examples.length) return core;

  const shuffled = [...examples];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  let persona = core + EXAMPLES_HEADER;
  let picked = 0;
  for (const example of shuffled) {
    if (persona.length + 1 + example.length > maxChars) continue;
    persona += "\n" + example;
    picked++;
  }
  return picked ? persona : core;
}

const readText = (file, { required }) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (err) {
    if (required) console.warn(`[persona] Could not read ${file}: ${err.message}`);
    return "";
  }
};

let cached = null;

const loadSources = () => {
  if (cached) return cached;
  const core = readText(personaPath, { required: true });
  const examples = readText(examplesPath, { required: false })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!core) console.warn(`[persona] ${personaPath} is empty; system prompt disabled.`);
  else {
    console.log(
      `[persona] Loaded ${core.length} chars of core rules and ${examples.length} examples; ` +
        `up to ${PERSONA_MAX_CHARS} chars are sent per request.`
    );
    if (core.length + EXAMPLES_HEADER.length >= PERSONA_MAX_CHARS) {
      console.warn(`[persona] Core rules leave no room for examples within ${PERSONA_MAX_CHARS} chars.`);
    }
  }
  cached = { core, examples };
  return cached;
};

/** The persona for one request: core rules + a fresh random set of examples that fits the budget. */
export const buildPersona = () => {
  const { core, examples } = loadSources();
  return composePersona(core, examples);
};

export const getPersonaPath = () => personaPath;
