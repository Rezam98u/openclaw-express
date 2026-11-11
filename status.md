# Project status

Snapshot of 2026-11-11. Covers `openclaw-express/` (the code, in git) and `openclaw-gateway-docker/` (the gateway setup, not in git).

## In one paragraph

An Express API sits in front of a self-hosted OpenClaw gateway in Docker. The gateway writes short dating messages in your persona and sends them over WhatsApp. The product runs in **autopilot** mode today: the AI texts matches as you, and the gateway answers each match on its own. The target is **coach** mode, where you paste what a match wrote and get a suggested reply to send yourself; its endpoints exist already. The main model is Groq `gpt-oss-120b`, with local Ollama `gpt-oss:20b` as the fallback when Groq is rate-limited. Only one number can be texted or answered right now: your own test number.

```
client ──HTTP──► openclaw-express ──WS :18789 (token)──► OpenClaw gateway (Docker) ──► Groq gpt-oss-120b
                                                              │                     └─► Ollama gpt-oss:20b (fallback, on this Mac)
                                                              ├─► WhatsApp Web session
                                                              └─► plain-punctuation plugin (cleans every outgoing message)
```

## Health right now

| Part | State |
| --- | --- |
| Tests | 24 of 24 pass (`npm test`, offline, under a second) |
| Git (`openclaw-express`) | `main`, clean, in sync with `origin/main`. Last commit `3591333` "Clean long dashes from every outgoing message" |
| Gateway | Running and healthy, OpenClaw 2026.10.1 |
| WhatsApp | Linked and connected. Allowlist only: the test number +989337203961 |
| Models | Primary `groq/openai/gpt-oss-120b`, fallback `ollama/gpt-oss:20b`. `tools.profile` is `minimal` |
| Ollama | 0.40.16 running at `localhost:11434`. Model downloaded, not loaded at the moment (it loads on demand, about 7 s) |
| plain-punctuation plugin | Loaded and enabled, `message_sending` hook registered. Proven on a real WhatsApp message |
| Background jobs | None enabled: heartbeat, weekly skill review and nightly memory dreaming are all off |
| Express | Not running (start with `npm run dev` in `openclaw-express/`) |
| Test conversation | Wiped. Only the gateway's "Reset" marker is stored, so the next message starts fresh |

## What the code does

### API (`openclaw-express/src`)

Every `/api/*` route needs `Authorization: Bearer <API_KEY>` (or `X-API-Key`). Without a valid key it answers 401. If `API_KEY` is missing or shorter than 24 characters, every `/api` request gets 503. Express listens on `127.0.0.1` by default, so only this Mac can reach it.

| Route | What it does |
| --- | --- |
| `GET /health` | Open health check |
| `POST /api/chat/ask` | **Coach.** `question` is what the match wrote; the answer is a suggested reply. Nothing is sent to WhatsApp. Runs in a throwaway session that is deleted afterwards |
| `POST /api/chat/stream` | Coach, streamed as server-sent events |
| `POST /api/autopilot/message` | **Autopilot.** Writes and sends our next message to a match: an opener for a new number, otherwise a continuation using the last 12 messages. `send: false` previews without sending, `restart: true` wipes the conversation and sends a new opener |
| `GET /api/autopilot/conversations/:to` | The stored conversation with a match |

Autopilot routes refuse any number outside `AUTOPILOT_NUMBERS` with 403.

### Files

| File | Role |
| --- | --- |
| `src/app.js` | Express app without a listener (routes, `/health`, API key check); tests import it |
| `src/server.js` | Entry point; listens and connects to the gateway at startup (starts even if the gateway is down) |
| `src/openclawClient.js` | One shared gateway client (`getClient()`) |
| `src/middleware/requireApiKey.js` | API key check, fails closed |
| `src/routes/chat.js` | Coach endpoints |
| `src/routes/autopilot.js` | Autopilot endpoints |
| `src/utils/persona.js` | Builds the persona: core rules plus a random sample of examples, at most 4,400 characters per request |
| `src/utils/sanitizeChatAnswer.js` | Strips leaked reasoning and tags; turns long dashes and semicolons into commas |
| `src/utils/conversation.js` | Gateway history into `match` / `me` turns |
| `src/utils/whatsappSession.js` | Phone number (E.164) checks and session keys |
| `src/utils/whatsappAutopilotPatch.js` | The gateway config that `npm run whatsapp:sync` applies |
| `src/utils/agentStreamCollect.js` | Collects a streamed agent answer |
| `scripts/whatsapp-autopilot-patch.js` | Prints that config for `whatsapp:sync` |
| `scripts/add-match.js` | `npm run match:add -- +<number>`: adds a match and syncs |
| `gateway-plugins/plain-punctuation/` | Our own gateway plugin (see below) |
| `openclaw-model-pin.json5` | The exact model and fallback config, to restore after experiments |
| `Commands.txt` | Copy-paste command reference |
| `test/routes.test.js`, `test/utils.test.js` | The test suite |

Dependencies: `express` 5.2 and `openclaw-node` 0.14 (needed for gateway protocol 4). Node 22 or newer. No build step, no linter.

### Gateway config set by `npm run whatsapp:sync`

- One conversation per match (`session.dmScope: "per-channel-peer"`), kept for 10 years instead of being archived after 30 quiet days.
- Only numbers in `AUTOPILOT_NUMBERS` are answered (`dmPolicy: "allowlist"`); everyone else is ignored.
- One persona for every allowed DM, built from `persona.txt` and a sample of `persona-examples.txt`. Re-syncing picks a new sample.
- Only the last 20 messages go to the model; low reasoning effort.
- Heartbeat, skill review and memory dreaming off, so nothing texts on its own or spends tokens in the background.

### Persona

- `persona.txt` (core rules, about 1,500 characters) and `persona-examples.txt` (101 example lines) are private and not in git.
- The rules were rewritten today for short, plain, human texts: one or two short sentences, everyday words, no poetic lines or clichés, at most one question. A side-by-side test on Groq gave clearly shorter, more natural replies. Backup of the previous version: `persona.txt.bak-2026-11-11` in the project root, outside this repo.
- gpt-oss still adds long dashes, so they are cleaned in code on both paths: in Express by `sanitizeChatAnswer`, and in the gateway by the plain-punctuation plugin. Both use the same function, `gateway-plugins/plain-punctuation/plainPunctuation.js`.

### Models and limits

- **Groq free tier:** 8,000 tokens per minute and 200,000 per day; no single request may exceed 8,000. One reply costs about 2,900 tokens, so about 2 replies per minute and about 65 per day.
- **When Ollama takes over:** after a Groq rate limit the gateway first retries Groq (up to 10 attempts). It switches to Ollama at once when Groq asks to wait more than 60 s or the daily limit is used up, and keeps using Ollama while Groq cools down (30 s, then 1 min, then 5 min). A request that is too large for Groq (413) fails and does not fall back.
- **Speed (measured on this Mac):** Groq answers in under 1 s. Ollama takes about 2 to 5 s, plus about 7 s if the model has to load first; it stays loaded for 30 minutes after use.
- **Quality:** the 20b fallback is weaker. In a small test it broke the "one question" rule more often than 120b.

## What changed today

1. Added Ollama `gpt-oss:20b` as the fallback model (commit `d420b50`).
2. Turned off the gateway's heartbeat, which had texted the test number a "First heartbeat alert" and unprompted messages, and turned off the weekly skill review and nightly memory dreaming jobs (commit `d420b50`).
3. Moved the `whatsapp:sync` config into a tested function (commit `d420b50`).
4. Rewrote the persona's tone rules for plain, human texting (private file, not in git).
5. Added the dash cleanup in Express and the plain-punctuation gateway plugin; tested on a real WhatsApp message (commit `3591333`).
6. Wiped the test number's stored conversation.

Gateway config backups from today: `~/.openclaw/openclaw.json.bak-2026-11-11` (before the Ollama change) and `~/.openclaw/openclaw.json.bak-2026-11-11-plugin` (before the plugin install).

## Not in git

These live only on this Mac. Back them up separately.

- `openclaw-gateway-docker/` including `docker-compose.yml`, which now mounts the plugin folder. Without that mount the plugin can't load.
- `CLAUDE.md` in the project root (the project root isn't a git repository; this file lives in `openclaw-express/` so it is versioned).
- `persona.txt`, `persona-examples.txt` (private on purpose).
- `~/.openclaw/` (gateway config, WhatsApp session, stored conversations).
- `.env` files (tokens; never commit them).

## Open items and known gaps

| Item | Why it matters |
| --- | --- |
| Groq → Ollama switch not yet seen on a real match reply | The config and Ollama connection are tested, but the switch during a rate limit has only been seen on a background job, not on a normal reply |
| Gateway replies are only cleaned of dashes | Express also strips leaked reasoning; replies the gateway sends on its own don't get that |
| 4 lines in `persona-examples.txt` contain long dashes | They teach the model that dashes are fine; changing them to commas would reduce dashes at the source |
| `.env.example` lacks `HOST` and `PERSONA_FILE_PATH` | Both are documented env vars; the project rule is to list every env var there |
| `DREAMS.md` (2.8 KB) in `~/.openclaw/workspace` | Created by memory dreaming before it was turned off. Not checked whether the gateway adds it to every request; if it does, it costs tokens |
| Gateway listens on all network interfaces | Startup warns that it binds to `0.0.0.0` (`lan`), so other devices on your network can reach its port. Token-protected, but `loopback` would be tighter |
| Fallback needs Ollama running | If the Ollama app is closed, rate-limited replies fail and nothing is sent |
| Only the test number is allowed | Real matches have to be added with `npm run match:add -- +<number>`; a real match must never be in `commands.ownerAllowFrom` |
| Coach mode is the target | Autopilot is what's implemented; new features should help move the product to coach mode |

## Everyday commands

From `openclaw-express/`:

```bash
npm run dev                          # start Express
npm test                             # run the tests
npm run whatsapp:sync                # apply persona and WhatsApp config to the gateway
npm run match:add -- +491511234567   # add a match
```

From `openclaw-gateway-docker/`:

```bash
docker compose up -d openclaw-gateway
docker compose logs -f openclaw-gateway
docker compose exec openclaw-gateway node dist/index.js channels status
docker compose exec openclaw-gateway node dist/index.js cron list --all
docker compose exec openclaw-gateway node dist/index.js plugins inspect plain-punctuation --runtime --json
```

Ollama:

```bash
curl localhost:11434/api/version
ollama ps
```
