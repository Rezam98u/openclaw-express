import express from "express";
import { chatRouter } from "./routes/chat.js";
import { whatsappDeliverRouter } from "./routes/whatsappDeliver.js";
import { getClient, disconnectClient } from "./openclawClient.js";
import { loadPersona } from "./utils/persona.js";

const port = Number(process.env.PORT) || 8080;

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    const client = await getClient();
    res.json({ ok: true, gateway: client.isConnected ? "connected" : "disconnected" });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.use("/api/chat", chatRouter);
app.use("/api/whatsapp", whatsappDeliverRouter);

const start = async () => {
  loadPersona();
  try {
    await getClient();
    console.log("[startup] Connected to OpenClaw gateway.");
  } catch (err) {
    console.warn(`[startup] Gateway not reachable yet: ${err.message}`);
    console.warn("[startup] Server will start anyway; requests will retry on demand.");
  }

  app.listen(port, () => {
    console.log(`[startup] Express listening on http://localhost:${port}`);
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
