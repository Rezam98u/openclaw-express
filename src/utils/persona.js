import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const personaPath =
  process.env.PERSONA_FILE_PATH ||
  path.resolve(__dirname, "..", "..", "persona.txt");

let cachedPersona = null;

export const loadPersona = () => {
  if (cachedPersona !== null) return cachedPersona;
  try {
    cachedPersona = fs.readFileSync(personaPath, "utf8").trim();
    if (!cachedPersona) {
      console.warn(`[persona] ${personaPath} is empty; system prompt disabled.`);
    } else {
      console.log(`[persona] Loaded ${cachedPersona.length} chars from ${personaPath}`);
    }
  } catch (err) {
    console.warn(`[persona] Could not read ${personaPath}: ${err.message}`);
    cachedPersona = "";
  }
  return cachedPersona;
};

export const getPersonaPath = () => personaPath;
