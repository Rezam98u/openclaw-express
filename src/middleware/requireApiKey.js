import crypto from "crypto";

// Shorter keys are refused outright, so a placeholder like "changeme" can't protect the API.
export const MIN_API_KEY_LENGTH = 24;

// Hashing both sides gives equal-length buffers, which timingSafeEqual requires.
const digest = (value) => crypto.createHash("sha256").update(value).digest();

const providedKey = (req) => {
  const auth = req.get("authorization") ?? "";
  if (/^bearer /i.test(auth)) return auth.slice(7).trim();
  return (req.get("x-api-key") ?? "").trim();
};

/**
 * Requires `Authorization: Bearer <API_KEY>` (or `X-API-Key: <API_KEY>`) on every request.
 * Fails closed: if API_KEY is missing or too short, every request gets 503 instead of
 * the API running unprotected. API_KEY is read per request, so tests can change it.
 */
export function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY?.trim() ?? "";
  if (expected.length < MIN_API_KEY_LENGTH) {
    return res
      .status(503)
      .json({ error: `API_KEY is not configured on the server (needs at least ${MIN_API_KEY_LENGTH} characters).` });
  }

  const provided = providedKey(req);
  if (!provided || !crypto.timingSafeEqual(digest(provided), digest(expected))) {
    return res.status(401).json({ error: "Missing or invalid API key." });
  }
  next();
}
