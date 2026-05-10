# openclaw-express

Express server that talks to a **self-hosted OpenClaw gateway** (running in Docker) using **Groq** as the LLM provider.

```
┌────────────────────┐      ws://localhost:18789      ┌──────────────────────┐      HTTPS      ┌────────────────┐
│  This Express app  │ ─────────────────────────────► │  OpenClaw Gateway    │ ──────────────► │  Groq API      │
│  (openclaw-node)   │   token auth, streaming RPC    │  (Docker container)  │  OpenAI-compat  │ (LPU inference)│
└────────────────────┘                                └──────────────────────┘                 └────────────────┘
```

## Prerequisites

- Node.js **22+**
- Docker Desktop / Docker Engine + Docker Compose v2
- A Groq API key (get one at <https://console.groq.com/keys>)

## 1. Run the OpenClaw gateway in Docker

In the sibling folder `E:\Agents\openclaw-gateway`:

```bash
git clone https://github.com/openclaw-foundation/openclaw.git .
cp .env.example .env
```

Edit `.env`:

```env
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_your_key_here
OPENCLAW_GATEWAY_TOKEN=pick-a-long-random-string
```

Then bring it up:

```bash
docker compose up -d
docker compose logs -f openclaw-gateway
```

### Docker: WhatsApp (link your own number)

The **gateway container** holds the WhatsApp Web session. You only need to pair once (until you log out or auth expires).

1. Install / enable the WhatsApp plugin if your image does not already include it (see OpenClaw onboarding or `openclaw plugins install @openclaw/whatsapp` inside the **CLI** image).
2. Run login from a **one-off CLI container** (replace `openclaw-cli` with the CLI service name from your Compose file — check `docker compose config --services`):

   ```bash
   docker compose run --rm openclaw-cli channels login --channel whatsapp
   ```

   A **QR code** appears in the terminal (or follow the image’s instructions). Scan it with the phone whose WhatsApp account should **send** outbound messages.

3. If your config uses **pairing** for unknown DMs, approve from the same CLI pattern:

   ```bash
   docker compose run --rm openclaw-cli pairing list whatsapp
   docker compose run --rm openclaw-cli pairing approve whatsapp <CODE>
   ```

4. WhatsApp credentials persist in whatever **volume** or bind mount your stack uses for OpenClaw state — keep that volume across restarts or you will need to scan again.

**Then:** `openclaw-express` calls the gateway with `to=+E164`; the linked WhatsApp account sends to that number, subject to `channels.whatsapp` allowlists / pairing on the gateway.

### Docker: Express ↔ gateway URL

| Where Express runs | Typical `OPENCLAW_GATEWAY_URL` |
| --- | --- |
| On your **host** (this repo, `npm start`) | `ws://127.0.0.1:18789` — gateway port **published** in Compose |
| In **another Docker container** (same machine) | `ws://host.docker.internal:18789` (Docker Desktop), or `ws://<gateway-service-hostname>:18789` on a **shared Compose network** |

Optional — pin models on the **gateway** (not in Express). Active file: `openclaw config file` (often `~/.openclaw/openclaw.json` on Windows).

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

Or apply the checked-in patch from this folder (restart the gateway afterward):

```bash
openclaw config patch --file openclaw-model-pin.json5
```

If you ever need a fresh dashboard URL:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
```

## 2. Configure this Express app

```bash
cd E:\Agents\openclaw-express
copy .env.example .env       # PowerShell:  Copy-Item .env.example .env
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

### `POST /api/chat/ask`

Synchronous one-shot chat. Returns the full answer once it's ready.

```bash
curl -X POST http://localhost:8080/api/chat/ask \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"Summarize the SOLID principles in 3 bullets.\"}"
```

Response:

```json
{ "answer": "..." }
```

Optional fields:

- `sessionKey` — continue an existing conversation
- `agentId` — target a specific agent configured in the gateway

### `POST /api/chat/stream`

Server-Sent Events stream of agent chunks (`text`, `tool_use`, `tool_result`, `done`, `error`).

```bash
curl -N -X POST http://localhost:8080/api/chat/stream \
  -H "Content-Type: application/json" \
  -d "{\"question\":\"Refactor my todo list app.\"}"
```

Each event line looks like:

```
event: text
data: {"type":"text","text":"..."}
```

### `POST /api/whatsapp/ask-deliver`

Runs **one** agent turn with spreadsheet data as context, then **delivers** the assistant reply to a **WhatsApp DM** through the gateway (same Groq path as `/api/chat/*`).

**Prompt shape**

- **User message** to the agent is only **`task`** (plain text, like a single user turn).
- **System** is sent via **`extraSystemPrompt`**: your optional `extraSystemPrompt` field **plus** the spreadsheet as a TSV block. If you omit `extraSystemPrompt` but the sheet has rows, a default opener is used: *“You are a dating message coach…”* so guidelines in the file stay on the system side.

**Prerequisites on the gateway**

- WhatsApp channel linked (`openclaw channels login --channel whatsapp`) and gateway running.
- `channels.whatsapp` **dmPolicy** / **allowFrom** / **pairing** must allow the destination number. See OpenClaw docs: [WhatsApp channel](https://docs.openclaw.com/channels/whatsapp).

**Request:** `multipart/form-data`

| Field | Required | Description |
| --- | --- | --- |
| `file` | Yes | `.xlsx` or `.xls` (first worksheet, or see `sheetName`) |
| `task` | Yes | **User** instruction only (alias: `question`; e.g. “Write a playful opening message…”) — spreadsheet stays in **system** |
| `to` | Yes | Destination in **E.164** form, e.g. `+15551234567` |
| `agentId` | No | Gateway agent id (default `main`) |
| `sheetName` | No | Worksheet name; default is the first sheet |
| `extraSystemPrompt` | No | **System** prefix before the TSV block; if omitted and the sheet has data, a default dating-coach line is used |

**Environment**

- `MAX_EXCEL_CONTEXT_CHARS` — max characters of TSV context injected into the prompt (default **24000**). The response includes `contextMeta.truncated` if the sheet was cut off. Large prompts can trigger **Groq TPM / size errors**; lower this value or reduce the spreadsheet size.

**Example (curl)**

```bash
curl -X POST http://localhost:8080/api/whatsapp/ask-deliver \
  -F "file=@./sample.xlsx" \
  -F "task=Summarize the spreadsheet in 3 short bullet points suitable for WhatsApp." \
  -F "to=+15551234567" \
  -F "sheetName=Sheet1"
```

**Response**

- **`deliveryRequested`** — always `true` for this route (the gateway is asked to deliver when possible).
- **`delivered`** — `true` only if some non-empty assistant **text** was streamed **and** no stream-level error was reported. This does not prove WhatsApp server ACK; use logs and the device to confirm.
- **`hint`** — present when `answer` is empty but the run did not report a stream error (check gateway + WhatsApp).
- **`502`** — transport failure or **`detail`** from a failed agent lifecycle (partial **`answer`** may still be present).

```json
{
  "answer": "...",
  "sessionKey": "agent:main:whatsapp:dm:+15551234567",
  "deliveryRequested": true,
  "delivered": true,
  "contextMeta": {
    "sheetName": "Sheet1",
    "rowCount": 42,
    "colCount": 5,
    "charCount": 12000,
    "truncated": false,
    "maxChars": 24000,
    "sourceBytes": 9012
  }
}
```

**Note:** Group chats use a different `sessionKey` shape (`...whatsapp:group:...`); this route only builds DM keys from `to`.

## Project layout

```
openclaw-express/
├── package.json
├── .env.example
├── .gitignore
├── README.md
└── src/
    ├── server.js              # Express bootstrap + lifecycle
    ├── openclawClient.js      # Singleton OpenClaw gateway client
    ├── routes/
    │   ├── chat.js            # POST /api/chat/ask + /api/chat/stream
    │   └── whatsappDeliver.js # POST /api/whatsapp/ask-deliver
    └── utils/
        ├── agentStreamCollect.js # consume agent stream → answer + streamError
        ├── excelContext.js    # xlsx → TSV context + truncation
        └── whatsappSession.js # E.164 + sessionKey helpers
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gateway: "disconnected"` on `/health` | Gateway container not running, or wrong port | `docker compose ps`; verify `OPENCLAW_GATEWAY_URL` |
| `401 Unauthorized` from gateway | Token mismatch | Make `OPENCLAW_GATEWAY_TOKEN` identical on both sides |
| `HTTP 401` from Groq in gateway logs | `GROQ_API_KEY` not visible to daemon | Put it in the gateway's `.env` (loaded by Docker Compose) |
| `HTTP 429` from Groq | Free-tier TPM cap | Lower concurrency or upgrade Groq plan |
| `413` / large request errors from Groq | Prompt too large vs TPM | Lower `MAX_EXCEL_CONTEXT_CHARS`, shrink the sheet, or shorten `task` |
| Reply not received on WhatsApp | Channel not linked, wrong session, blocked by `allowFrom` | `openclaw channels status`; check pairing and policies |
| Tool calls ignored | Picked a Groq model without function-calling | Use `groq/llama-3.3-70b-versatile` |
| `answer` empty, `delivered` false, `hint` set | Model sent no text in the stream (or similar) | Check gateway logs, WhatsApp thread, Groq quotas; try `/api/chat/stream` to inspect chunks |
