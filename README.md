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

3. Who the gateway answers is an **allowlist**, not pairing: `npm run whatsapp:sync` sets `channels.whatsapp.dmPolicy: "allowlist"` with `allowFrom` = `AUTOPILOT_NUMBERS`, so no one is sent a pairing code. Check it with:

   ```bash
   docker compose exec openclaw-gateway node dist/index.js channels status
   ```

4. WhatsApp credentials persist in the bind-mounted `~/.openclaw` folder on your Mac. Keep it across restarts or you will need to scan again.

**Then:** Express sends autopilot messages with the gateway's `send` method to numbers in `AUTOPILOT_NUMBERS`, and the gateway answers those matches' replies on its own (see **Autopilot** below).

### Docker: Express ↔ gateway URL

| Where Express runs | Typical `OPENCLAW_GATEWAY_URL` |
| --- | --- |
| On your **host** (this repo, `npm start`) | `ws://127.0.0.1:18789` — gateway port **published** in Compose |
| In **another Docker container** (same machine) | `ws://host.docker.internal:18789` (Docker Desktop), or `ws://<gateway-service-hostname>:18789` on a **shared Compose network** |

### Model (configured on the gateway, not in Express)

The gateway's config file is `~/.openclaw/openclaw.json` on your Mac (bind-mounted into the container). What it uses today:

- **Model:** `groq/openai/gpt-oss-120b`, the only model. Llama 3.3 was retired from Groq.
- **No fallback:** when Groq answers 429 (rate limit), the gateway retries the same model up to 9 times, about 50 seconds apart, so replies get slow. Choosing a fallback (local Ollama, Cerebras, or a paid provider) is still open.
- **Reasoning:** `gpt-oss-120b` is a reasoning model. `npm run whatsapp:sync` sets `agents.defaults.thinkingDefault: "low"` to keep its hidden reasoning short, and `sanitizeChatAnswer.js` strips reasoning that leaks into Express answers. Replies the gateway sends to matches on its own are not sanitized.
- **Groq free tier for this model:** 8,000 tokens per minute and 200,000 per day, shared across your whole Groq organization. A single request may not exceed 8,000 tokens either. One reply costs about 2,900 input tokens, so about 2 replies per minute and about 65 per day fit.

Check the live setting:

```bash
docker compose exec openclaw-gateway node dist/index.js config get agents.defaults.model
```

[`openclaw-model-pin.json5`](openclaw-model-pin.json5) holds exactly this setting; apply it to restore the model after experiments (run from `openclaw-gateway-docker`, no restart needed):

```bash
docker compose exec -T openclaw-gateway node dist/index.js config patch --stdin < ../openclaw-express/openclaw-model-pin.json5
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

Edit `.env`:

- `OPENCLAW_GATEWAY_TOKEN`: the **same value** you used on the gateway.
- `API_KEY`: a random secret of at least 24 characters (`openssl rand -hex 32`). Every `/api` request must send it; see **Authentication** below.
- `AUTOPILOT_NUMBERS`: the matches the AI may text (or use `npm run match:add`).

If Express runs **inside Docker**, set `OPENCLAW_GATEWAY_URL` per the table in **Docker: Express ↔ gateway URL** above (not always `localhost` from inside a container).

## 3. Run

```bash
npm run dev    # auto-reload via node --watch
# or
npm start
```

Server boots on `http://localhost:8080`.

## API

### Authentication

- **API key:** every `/api/*` request needs `Authorization: Bearer <API_KEY>` (or `X-API-Key: <API_KEY>`). A missing or wrong key gets `401`. If `API_KEY` is missing or shorter than 24 characters, every `/api` request gets `503`, so the API never runs unprotected.
- **Local only:** Express listens on `127.0.0.1` by default, so other devices on your network can't reach it. Set `HOST=0.0.0.0` only if you need network access, and keep the API key secret if you do.
- **Open route:** only `/health` works without a key.

For the examples below, load the key into your shell once (from `openclaw-express`):

```bash
export API_KEY="$(grep '^API_KEY=' .env | cut -d= -f2-)"
```

### `GET /health`

Returns gateway connection status.

```bash
curl http://localhost:8080/health
```

### Coach: `POST /api/chat/ask`

**Coach (Option A):** the AI helps you. Paste what the match wrote as `question`; you get back **one suggested reply** in the persona, to send yourself. Nothing is sent to WhatsApp and nothing is stored: every request runs in its own throwaway session (`agent:main:coach:<uuid>`) that is deleted afterwards.

```bash
curl -s -X POST http://localhost:8080/api/chat/ask \
  -H "Authorization: Bearer $API_KEY" \
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
  -H "Authorization: Bearer $API_KEY" \
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
| Existing conversation | `continue` | Your next message, written from the last 12 messages |
| `"restart": true` | `opener` | Wipes that match's conversation, then sends a fresh opener |

Conversations are never wiped automatically. The gateway's archive window is set to 10 years by `npm run whatsapp:sync`, so even a match who goes quiet for months continues where you left off.

How a message is made:

1. Reads the match's stored history (unless `restart`).
2. Drafts the message in a throwaway session (persona: `persona.txt` plus a random set of examples from `persona-examples.txt`, see **Persona**), with no delivery, then deletes that session.
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
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","context":"Likes hiking and bad puns","send":false}'

# Send it (opener for a new number, next message for an existing conversation)
curl -s -X POST http://localhost:8080/api/autopilot/message \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15551234567","context":"Likes hiking and bad puns"}'
```

Response: `{ "mode": "opener" | "continue", "message": "...", "to": "+15551234567", "sessionKey": "agent:main:whatsapp:direct:+15551234567", "sent": true, "result": { ... } }`. `502` if reading history, the agent run, or the send fails.

### `GET /api/autopilot/conversations/:to`

The stored conversation with one match, oldest first (`?limit=`, default 200). `from` is `"match"` or `"me"`.

```bash
curl -s -H "Authorization: Bearer $API_KEY" "http://localhost:8080/api/autopilot/conversations/%2B15551234567"
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

**Gateway setup (`match:add` runs this for you; run it yourself after editing `persona.txt` or `persona-examples.txt`):**

```bash
npm run whatsapp:sync:dry   # validate
npm run whatsapp:sync       # apply to the running gateway
```

This sets `session.dmScope: "per-channel-peer"` (one conversation per match), `session.maintenance.pruneAfter: "3650d"` (conversations aren't archived after the default 30 quiet days), `channels.whatsapp.dmPolicy: "allowlist"` with `allowFrom` = `AUTOPILOT_NUMBERS` (only listed matches are answered; nobody gets pairing codes), `channels.whatsapp.direct["*"].systemPrompt` = `persona.txt`, `channels.whatsapp.dmHistoryLimit: 20` (only the last 20 turns go to the model; the full conversation stays stored), and `agents.defaults.thinkingDefault: "low"` (less hidden reasoning). The last two keep each request well inside Groq's free tier of 8,000 tokens per minute.

## Persona

The persona has two files. Both are personal and **not in git** (see `.gitignore`), so create them yourself on a new machine:

| File | What goes in it | Sent to the model |
| --- | --- | --- |
| `persona.txt` | The rules: voice, length, what never to say | Always, in full |
| `persona-examples.txt` | Example messages, **one per line**. Add to it as often as you like | A **random set that fits the budget**, different on every request |

Each request sends at most **4,400 characters** in total (`PERSONA_MAX_CHARS` in `src/utils/persona.js`): the full rules, then examples in random order until the next one wouldn't fit. The cost per reply stays the same however large the example bank grows. Keep `persona.txt` short (about 1,000 characters today) so there's room for examples; `npm test` fails if the rules leave no room.

After editing either file:

1. **Restart Express** (`npm run dev`): it reads both files once at startup.
2. Run **`npm run whatsapp:sync`**: the gateway's own replies to matches use a fixed prompt built the same way. Rerunning the sync also rotates which examples the gateway gets.

## Project layout

```
openclaw-express/
├── package.json
├── .env.example
├── .gitignore
├── README.md
├── persona.txt                # core persona rules, sent in full with every request
├── persona-examples.txt       # example bank, one per line; grows freely, a random subset is sent
├── src/
│   ├── server.js              # starts the listener (127.0.0.1 by default) + lifecycle
│   ├── app.js                 # routes + API key check, without the listener (used by tests)
│   ├── openclawClient.js      # Singleton OpenClaw gateway client
│   ├── middleware/
│   │   └── requireApiKey.js   # API key check for /api/*
│   ├── routes/
│   │   ├── chat.js            # coach: POST /api/chat/ask + /api/chat/stream
│   │   └── autopilot.js       # /api/autopilot/message + /conversations/:to
│   └── utils/
│       ├── agentStreamCollect.js # consume agent stream → answer + streamError
│       ├── persona.js         # core + random examples within 4,400 chars per request
│       ├── sanitizeChatAnswer.js # strip leaked planning / tags from answers
│       └── whatsappSession.js # E.164 + sessionKey helpers
└── test/                      # node:test suite (npm test), runs offline
```

Inbound WhatsApp auto-replies are handled by the gateway itself, not by this app.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `401` from Express | Missing or wrong API key | Send `Authorization: Bearer $API_KEY` (see **Authentication**) |
| `503` from every `/api` route | `API_KEY` missing or shorter than 24 characters | Set it in `.env` and restart Express |
| Can't reach Express from another device | Express listens on `127.0.0.1` only (on purpose) | Set `HOST=0.0.0.0` in `.env` if you really need network access |
| `/health` returns `503` | Gateway container not running, or wrong URL | `docker compose ps`; check `OPENCLAW_GATEWAY_URL` |
| Gateway closes the connection: token or "pairing required" | Token mismatch, or Express's device needs (re)approval | Make `OPENCLAW_GATEWAY_TOKEN` identical on both sides; `devices list` / `devices approve <requestId>` via `docker compose exec` |
| `HTTP 401` from Groq in gateway logs | `GROQ_API_KEY` not visible to the gateway | Put it in `openclaw-gateway-docker/.env` and restart the gateway |
| Slow replies; `429` in gateway logs | Groq free tier: 8,000 tokens/min, 200,000/day for `gpt-oss-120b`; the gateway retries up to 9 times, ~50 s apart | Wait, send fewer requests, keep the workspace files tiny (see CLAUDE.md "Token budget"), or add a fallback / upgrade Groq |
| `413` or "Context overflow: prompt too large" | One request is over 8,000 tokens; nothing is sent | Keep `~/.openclaw/workspace/*.md` to a line or two, `tools.profile` on `minimal`, and run `npm run whatsapp:sync` (history limit 20) |
| `403` from `/api/autopilot/*` | Number not in `AUTOPILOT_NUMBERS`, or Express not restarted after `match:add` | `npm run match:add -- +<number>`, then restart Express |
| A match gets no reply on WhatsApp | Number not in the gateway allowlist, or WhatsApp not linked | `npm run whatsapp:sync`; `docker compose exec openclaw-gateway node dist/index.js channels status` |
| Reply contains planning text ("I need to…") | `gpt-oss-120b` leaked its reasoning | Express answers are sanitized; gateway replies to matches are not yet. Keep `thinkingDefault: "low"` |
