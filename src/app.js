import express from "express";
import { chatRouter } from "./routes/chat.js";
import { autopilotRouter } from "./routes/autopilot.js";
import { getClient } from "./openclawClient.js";
import { requireApiKey } from "./middleware/requireApiKey.js";

// The Express app without the network listener, so tests exercise the real wiring.
export const app = express();
app.use(express.json({ limit: "1mb" }));

// Open on purpose: reports only whether the gateway is reachable.
app.get("/health", async (_req, res) => {
  try {
    const client = await getClient();
    res.json({ ok: true, gateway: client.isConnected ? "connected" : "disconnected" });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Everything under /api can message matches or read conversations: API key required.
app.use("/api", requireApiKey);
app.use("/api/chat", chatRouter);
app.use("/api/autopilot", autopilotRouter);
