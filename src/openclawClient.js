import { OpenClawClient } from "openclaw-node";

let client = null;
let connectPromise = null;

const buildClient = () => {
  const instance = new OpenClawClient({
    url: process.env.OPENCLAW_GATEWAY_URL || "ws://localhost:18789",
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    autoReconnect: true,
    maxReconnectAttempts: 10,
  });

  // Required: EventEmitter throws if 'error' has no listener.
  // Per-request errors are still surfaced via rejected promises in chat()/chatSync().
  instance.on?.("error", (err) => {
    console.warn(`[openclaw] client error: ${err?.message || err}`);
  });

  return instance;
};

export const getClient = async () => {
  if (client?.isConnected) return client;
  if (connectPromise) return connectPromise;

  client = buildClient();
  connectPromise = client
    .connect()
    .then(() => {
      connectPromise = null;
      return client;
    })
    .catch((err) => {
      connectPromise = null;
      client = null;
      throw err;
    });

  return connectPromise;
};

export const disconnectClient = async () => {
  if (!client) return;
  try {
    if (client.isConnected) await client.disconnect();
  } finally {
    client = null;
    connectPromise = null;
  }
};
