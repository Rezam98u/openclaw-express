import { app } from "./app.js";
import { disconnectClient, getClient } from "./openclawClient.js";
import { buildPersona } from "./utils/persona.js";
import { MIN_API_KEY_LENGTH } from "./middleware/requireApiKey.js";

const port = Number(process.env.PORT) || 8080;
// Loopback by default: only this Mac can reach the API. Set HOST=0.0.0.0 to expose it on the network.
const host = process.env.HOST?.trim() || "127.0.0.1";

const start = async () => {
  buildPersona(); // reads the persona files now, so problems are logged at startup
  if ((process.env.API_KEY?.trim() ?? "").length < MIN_API_KEY_LENGTH) {
    console.warn(`[startup] API_KEY is missing or shorter than ${MIN_API_KEY_LENGTH} characters: every /api request will get 503.`);
  }
  try {
    await getClient();
    console.log("[startup] Connected to OpenClaw gateway.");
  } catch (err) {
    console.warn(`[startup] Gateway not reachable yet: ${err.message}`);
    console.warn("[startup] Server will start anyway; requests will retry on demand.");
  }

  app.listen(port, host, () => {
    console.log(`[startup] Express listening on http://${host}:${port}`);
  });
};

const shutdown = async (signal) => {
  console.log(`\n[shutdown] Received ${signal}, closing gateway connection...`);
  await disconnectClient().catch((err) => console.error("[shutdown]", err));
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

start().catch((err) => {
  console.error("[fatal] Failed to start server:", err);
  process.exit(1);
});
