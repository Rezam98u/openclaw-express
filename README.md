# openclaw-express

Express server that talks to a **self-hosted OpenClaw gateway** (running in Docker) using **Groq** as the LLM provider.

```
┌────────────────────┐      ws://localhost:18789      ┌──────────────────────┐      HTTPS      ┌────────────────┐
│  This Express app  │ ─────────────────────────────► │  OpenClaw Gateway    │ ──────────────► │  Groq API      │
│  (openclaw-node)   │   token auth, streaming RPC    │  (Docker container)  │  OpenAI-compat  │ (LPU inference)│
└────────────────────┘                                └──────────────────────┘                 └────────────────┘
```

## Prerequisites

- macOS
- Node.js **22+** (e.g. `brew install node`)
- Docker Desktop for Mac (includes Docker Compose v2)
- A Groq API key (get one at <https://console.groq.com/keys>)

## 1. Run the OpenClaw gateway in Docker

In the sibling folder `../openclaw-gateway-docker` (it uses the official `ghcr.io/openclaw/openclaw` image):

```bash
cd ../openclaw-gateway-docker
cp env.example .env
```

Edit `.env` (use absolute paths; Compose does not expand `~` here):

```env
OPENCLAW_CONFIG_DIR=/Users/<you>/.openclaw
OPENCLAW_WORKSPACE_DIR=/Users/<you>/.openclaw/workspace
OPENCLAW_GATEWAY_TOKEN=pick-a-long-random-string
GROQ_API_KEY=gsk_your_key_here
```

Then bring it up and wait until `docker compose ps` reports it `healthy`:

```bash
./start-gateway.sh            # same as: docker compose up -d openclaw-gateway
docker compose logs -f openclaw-gateway
```

There is no native `openclaw` CLI on this setup. Run CLI commands inside the running container:

```bash
docker compose exec openclaw-gateway node dist/index.js <openclaw-args>
```

Don't use `docker compose run --rm openclaw-cli ...` while the gateway is up: it fails with `GatewayLockNamespaceError`.

### Docker: WhatsApp (link your own number)

The **gateway container** holds the WhatsApp Web session. You only need to pair once (until you log out or auth expires).

1. Install / enable the WhatsApp plugin if your image does not already include it (see OpenClaw onboarding, or `plugins install @openclaw/whatsapp` via the `exec` pattern above).
2. Run login inside the running gateway container:

   ```bash
   docker compose exec openclaw-gateway node dist/index.js channels login --channel whatsapp
   ```

   A **QR code** appears in the terminal (or follow the image’s instructions). Scan it with the phone whose WhatsApp account should **send** outbound messages.

3. If your config uses **pairing** for unknown DMs, approve with the same pattern:

   ```bash
   docker compose exec openclaw-gateway node dist/index.js pairing list whatsapp
   docker compose exec openclaw-gateway node dist/index.js pairing approve whatsapp <CODE>
   ```

4. WhatsApp credentials persist in the bind-mounted `~/.openclaw` folder on your Mac. Keep it across restarts or you will need to scan again.

**Then:** `openclaw-express` calls the gateway with `to=+E164`; the linked WhatsApp account sends to that number, subject to `channels.whatsapp` allowlists / pairing on the gateway.

### Docker: Express ↔ gateway URL

| Where Express runs | Typical `OPENCLAW_GATEWAY_URL` |
| --- | --- |
| On your **host** (this repo, `npm start`) | `ws://127.0.0.1:18789` — gateway port **published** in Compose |
| In **another Docker container** (same machine) | `ws://host.docker.internal:18789` (Docker Desktop), or `ws://<gateway-service-hostname>:18789` on a **shared Compose network** |

Optional — pin models on the **gateway** (not in Express). Active file: `~/.openclaw/openclaw.json` on your Mac (bind-mounted into the container).

Use a **non-reasoning** primary and fallbacks (e.g. Groq Llama → Gemini Flash). Avoid putting reasoning-style models in the fallback chain or you will see meta commentary in chat replies.

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "groq/llama-3.3-70b-versatile",
        fallbacks: ["google/gemini-2.5-flash"],
      },
    },
  },
}
```

Or apply the checked-in patch from this folder (run from `openclaw-gateway-docker`, then restart the gateway):

```bash
docker compose exec -T openclaw-gateway node dist/index.js config patch --stdin < ../openclaw-express/openclaw-model-pin.json5
docker compose restart openclaw-gateway
```

If you ever need a fresh dashboard URL:

```bash
docker compose exec openclaw-gateway node dist/index.js dashboard --no-open
```

## 2. Configure this Express app

```bash
cd ../openclaw-express
cp .env.example .env
npm install
```

Edit `.env` and set `OPENCLAW_GATEWAY_TOKEN` to the **same value** you used on the gateway.

If Express runs **inside Docker**, set `OPENCLAW_GATEWAY_URL` per the table in **Docker: Express ↔ gateway URL** above (not always `localhost` from inside a container).

## 3. Run

```bash
npm run dev    # auto-reload via node --watch
# or
npm start
```

Server boots on `http://localhost:8080`.

## API

### `GET /health`

Returns gateway connection status.

```bash
curl http://localhost:8080/health
```

### Coach: `POST /api/chat/ask`

**Coach (Option A):** the AI helps you. Paste what the match wrote as `question`; you get back **one suggested reply** in the persona, to send yourself. Nothing is sent to WhatsApp and nothing is stored: every request runs in its own throwaway session (`agent:main:coach:<uuid>`) that is deleted afterwards.

```bash
curl -s -X POST http://localhost:8080/api/chat/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"Haha you seem fun. What do you do on weekends?"}'
```

Response:

```json
{ "answer": "..." }
```

Optional field: `agentId`, to target a specific agent configured in the gateway (default `main`).

### Coach: `POST /api/chat/stream`

Same as `/api/chat/ask`, streamed as Server-Sent Events of agent chunks (`text`, `tool_use`, `tool_result`, `done`, `error`). Unlike `/ask`, the streamed text is not sanitized.

```bash
curl -N -X POST http://localhost:8080/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"question":"Haha you seem fun. What do you do on weekends?"}'
```

Each event line looks like:

```
event: text
data: {"type":"text","text":"..."}
```

### Autopilot: `POST /api/autopilot/message`

**Autopilot:** the AI texts a match on WhatsApp **as you**. Every match has **one durable conversation**, stored by the gateway (session `agent:main:whatsapp:direct:<number>`, on disk in `~/.openclaw`). The **gateway** answers each of the match's replies on its own, in the persona, with the full conversation as context. This route sends **your** next message into that conversation:

| Situation | `mode` | What is sent |
| --- | --- | --- |
| New number (no stored history) | `opener` | A first message: the conversation starts from scratch |
| Existing conversation | `continue` | Your next message, written from the last 30 messages |
| `"restart": true` | `opener` | Wipes that match's conversation, then sends a fresh opener |

Conversations are never wiped automatically. The gateway's archive window is set to 10 years by `npm run whatsapp:sync`, so even a match who goes quiet for months continues where you left off.

How a message is made:

1. Reads the match's stored history (unless `restart`).
2. Drafts the message in a throwaway session (persona from `persona.txt`, no delivery), then deletes that session.
3. Cleans it with the same sanitizer as `/api/chat/ask`, so leaked planning text never reaches the match.
4. Sends **exactly that text** through the gateway's `send` RPC and mirrors it into the match's conversation, so the gateway's later replies know what you said.

**Request:** JSON

| Field | Required | Description |
| --- | --- | --- |
| `to` | Yes | Match number in **E.164** form; must be listed in `AUTOPILOT_NUMBERS` (else 403) |
| `context` | No | What you know about the match (profile notes, photos, interests) |
| `send` | No | `false` = preview only: draft and return the message without sending or changing anything |
| `restart` | No | `true` = wipe this match's conversation and start over with an opener |
| `agentId` | No | Gateway agent id (default `main`) |

```bash
# Preview (nothing is sent)
curl -s -X POST http://localhost:8080/api/autopilot/message \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","context":"Likes hiking and bad puns","send":false}'

# Send it (opener for a new number, next message for an existing conversation)
curl -s -X POST http://localhost:8080/api/autopilot/message \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","context":"Likes hiking and bad puns"}'
```

Response: `{ "mode": "opener" | "continue", "message": "...", "to": "+15551234567", "sessionKey": "agent:main:whatsapp:direct:+15551234567", "sent": true, "result": { ... } }`. `502` if reading history, the agent run, or the send fails.

### `GET /api/autopilot/conversations/:to`

The stored conversation with one match, oldest first (`?limit=`, default 200). `from` is `"match"` or `"me"`.

```bash
curl -s "http://localhost:8080/api/autopilot/conversations/%2B15551234567"
```

```json
{ "to": "+15551234567", "sessionKey": "agent:main:whatsapp:direct:+15551234567", "totalMessages": 3,
  "messages": [{ "from": "me", "text": "...", "timestamp": 1791751684000 }, { "from": "match", "text": "...", "timestamp": 1791751840527 }] }
```

### Adding a match

```bash
npm run match:add -- +15551234567   # adds it to AUTOPILOT_NUMBERS in .env and updates the gateway
```

Then restart Express (it reads `.env` at startup). The first `POST /api/autopilot/message` to that number sends an opener.

**Gateway setup (`match:add` runs this for you; run it yourself after editing `persona.txt`):**

```bash
npm run whatsapp:sync:dry   # validate
npm run whatsapp:sync       # apply to the running gateway
```

This sets `session.dmScope: "per-channel-peer"` (one conversation per match), `session.maintenance.pruneAfter: "3650d"` (conversations aren't archived after the default 30 quiet days), `channels.whatsapp.dmPolicy: "allowlist"` with `allowFrom` = `AUTOPILOT_NUMBERS` (only listed matches are answered; nobody gets pairing codes), and `channels.whatsapp.direct["*"].systemPrompt` = `persona.txt`.

## Project layout

```
openclaw-express/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── persona.txt                # system prompt sent with every chat request
├── src/
│   ├── server.js              # Express bootstrap + lifecycle
│   ├── openclawClient.js      # Singleton OpenClaw gateway client
│   ├── routes/
│   │   ├── chat.js            # coach: POST /api/chat/ask + /api/chat/stream
│   │   └── autopilot.js       # /api/autopilot/message + /conversations/:to
│   └── utils/
│       ├── agentStreamCollect.js # consume agent stream → answer + streamError
│       ├── persona.js         # load + cache persona.txt
│       ├── sanitizeChatAnswer.js # strip leaked planning / tags from answers
│       └── whatsappSession.js # E.164 + sessionKey helpers
└── test/                      # node:test suite (npm test), runs offline
```

Inbound WhatsApp auto-replies are handled by the gateway itself, not by this app.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gateway: "disconnected"` on `/health` | Gateway container not running, or wrong port | `docker compose ps`; verify `OPENCLAW_GATEWAY_URL` |
| `401 Unauthorized` from gateway | Token mismatch | Make `OPENCLAW_GATEWAY_TOKEN` identical on both sides |
| `HTTP 401` from Groq in gateway logs | `GROQ_API_KEY` not visible to daemon | Put it in the gateway's `.env` (loaded by Docker Compose) |
| `HTTP 429` from Groq | Free-tier TPM cap | Lower concurrency or upgrade Groq plan |
| `413` / large request errors from Groq | Prompt too large vs TPM | Keep `tools.profile` set to `minimal` on the gateway and keep `persona.txt` short |
| Reply not received on WhatsApp | Channel not linked, wrong session, blocked by `allowFrom` | `openclaw channels status`; check pairing and policies |
| Tool calls ignored | Picked a Groq model without function-calling | Use `groq/llama-3.3-70b-versatile` |
| `answer` empty, `delivered` false, `hint` set | Model sent no text in the stream (or similar) | Check gateway logs, WhatsApp thread, Groq quotas; try `/api/chat/stream` to inspect chunks |
