# DIOSCURI — deployment & operations runbook

The practical operator playbook: zero to living twins, then day-2 operations.
Deep references: [setup.md](setup.md) (full setup), [usage.md](usage.md)
(operator's manual), [security.md](security.md) (defense model),
[architecture.md](architecture.md). Languages: [runbook-ru.md](runbook-ru.md) · [runbook-es.md](runbook-es.md).

## 1. What this is

One Docker container running the community agents of the AICOM ecosystem:

- **CASTOR** rides Telegram (fast, grounded); **POLLUX** holds Discord (deep,
  structured). One shared memory, one shared shield.
- **MNEMOSYNE** — the knowledge base: self-syncs from GitHub (READMEs,
  releases, a 14-day commit digest per repo) and from the ecosystem's live
  demo endpoints.
- **AEGIS** — prompt-injection firewall (EN+RU) + moderation. The Q&A brain is
  tool-less: a public message physically cannot execute anything.
- **THEOXENIA** — the content calendar: spotlights, cross-platform banter,
  polls, digests — autonomous, on a weekly rhythm. All proactive content is
  English; replies mirror the asker's language.
- **KERYX** — post-only syndication of releases to Bluesky/Mastodon/X plus a
  monthly dev.to digest. Own accounts only, no engagement automation.

Hard guarantees: **bans are impossible** (the bot's ceiling: warn / delete /
timeout ≤10 min / escalate to humans), every consequential act lands in a
hash-chained audit log, LLM calls and posts are budget-capped daily.

## 2. What you need

| What | Why | Required? |
|---|---|---|
| A server with Docker + docker compose | the service itself (~150–300 MB RAM) | yes |
| One LLM key: `DEEPSEEK_API_KEY` (default) or anthropic/openai/local ollama | answers, content, moderation classifier | yes |
| A Discord bot (token + guild ID) | Pollux | at least one platform |
| A Telegram bot (token + group ID) | Castor | at least one platform |
| `GITHUB_TOKEN` (read-only PAT) | GitHub API limits 60/h → 5000/h | recommended |
| Bluesky/Mastodon/X/dev.to keys | KERYX syndication | no (sleeps silently) |

## 3. Quick start (10 minutes)

```bash
git clone <gitea>/alexar76/dioscuri.git && cd dioscuri   # or dioscuri/ in the monorepo
cp .env.example .env                        # secrets go here, and only here
cp dioscuri.config.example.json dioscuri.config.json     # non-secret tuning
# edit both files (minimum below), then:
docker compose up -d --build
curl -s http://localhost:8790/health        # {"ok":true,...} = alive
docker logs -f dioscuri                     # JSON logs; look for "waking the twins"
```

Minimum in `.env`: one LLM key + platform tokens. Minimum in
`dioscuri.config.json`: real `links.discordInvite` and
`links.telegramChannel` — the whole cross-promotion mechanic is built on them.

The service also boots with zero tokens: `DIOSCURI_DRY_RUN=1` brings up the
knowledge base and the health endpoint (handy for checking the environment).

## 4. Platform tokens

### Discord (Pollux)
1. [discord.com/developers/applications](https://discord.com/developers/applications) →
   New Application → **Bot** tab → Reset Token → that's `DISCORD_BOT_TOKEN`.
2. Same tab: enable **Message Content Intent** (without it the bot cannot see
   message text — no answers, no moderation) and **Server Members Intent**
   (welcomes, timeouts).
3. OAuth2 → URL Generator: scopes `bot` + `applications.commands`; permissions:
   Manage Channels, Manage Roles, Manage Messages, Moderate Members,
   Send Messages, Read Message History, Embed Links, Attach Files,
   Add Reactions. Open the generated URL → pick your server → Authorize.
4. In Discord: Settings → Advanced → Developer Mode → right-click the server →
   Copy Server ID = `DISCORD_GUILD_ID`.
5. After first boot, move the bot's role **above** the `Keeper` role in the
   role list (otherwise it cannot manage roles/timeouts).

No channel IDs needed: on first boot Pollux builds the whole structure himself
(THE GATES / AGORA / FORGE / SKY HALL / THE WATCH, the Keeper role,
permissions, a pinned welcome manifest). Re-runs never destroy anything — they
only heal what's missing. Disable with `DISCORD_AUTOSTRUCTURE=0`.

### Telegram (Castor)
1. [@BotFather](https://t.me/BotFather) → `/newbot` → token = `TELEGRAM_BOT_TOKEN`.
2. Add the bot to the group as an **admin** (delete messages, ban users, pin).
3. `TELEGRAM_CHAT_ID`: forward any group message to
   [@userinfobot](https://t.me/userinfobot); supergroup IDs look like `-100…`.

## 5. What happens on first boot (by itself)

1. Pollux builds the server structure; Castor sets the command menu and pins
   the links message.
2. The twins post their opening manifests (once; flag file in `/data`).
3. MNEMOSYNE seeds the knowledge base from GitHub (the first pass announces
   nothing — no historic-release spam).
4. The live showcase starts polling demo endpoints (monitor every 10 min).
5. The content calendar arms itself: Mon/Thu spotlight, Tue/Sat banter,
   Wed poll, Fri "This week in the forge" digest, Sun show-and-tell. Quiet
   hours 22:00–07:00 UTC, max 3 posts/platform/day.

Verify: `curl :8790/health` → `adapters.telegram/discord: true`,
`kb.chunks > 0`. In the logs: `POLLUX holds the sky`, `CASTOR rides the
ground`, `KB sync pass complete`.

## 6. Day-2 operations

### Feed a topic to the twins
Drop into `/data/content-queue.json` (inside the `dioscuri-data` volume):
```json
[
  { "kind": "spotlight", "topic": "the new FOURIER oracle and why it matters" },
  { "topic": "a topic without kind — consumed by the next matching slot" }
]
```
The queue is consumed before topic rotation. Standing topics and the schedule
live in `topics` / `slots` in `dioscuri.config.json` (restart the container).

### Q&A behaviour
Discord: mention, reply or `/ask`; Telegram: DM, mention, reply, `/ask`.
Reply language = question language, default English. Rate limits:
4 messages/min per user (beyond that — a polite refusal, no LLM call).

### Moderation
Deterministic rules decide first: foreign invites (delete), mass mentions and
flood (delete + timeout ≤10 min), repeat spam, caps. The LLM classifier is
advisory-only and runs only on risk signals. **Never an automatic ban**: the
worst case is an escalation to `#mod-log` for human moderators. Mod bypass is
built in.

### Syndication (KERYX)
Once the accounts exist, put the keys in `.env` and restart:
`BLUESKY_IDENTIFIER`+`BLUESKY_APP_PASSWORD`, `MASTODON_BASE_URL`+
`MASTODON_ACCESS_TOKEN` (enable the "bot" flag on the profile), for X —
`X_SYNDICATION=1` + the four keys (pay-per-use: ~$0.015/post, $0.20 with a
URL), `DEVTO_API_KEY` for the monthly digest. Look for `KERYX armed` in the
logs. Every new GitHub release then goes out as a short announcement to every
armed sink.

DISBOARD: if you list the server and add their bot, Pollux reminds Keepers to
`/bump` two hours after a successful bump. **The bot never bumps by itself and
must never be made to** — auto-bumping means delisting plus account bans.

### Live showcase
Add a source in `dioscuri.config.json`:
```json
"showcase": { "sources": [
  { "name": "alien-monitor", "url": "https://magic-ai-factory.com/monitor/api/health", "kind": "json" }
]}
```
Check by hand first: `curl <url>` must return JSON. Secret-looking keys
(`token`, `api_key`, `seed`…) never enter the knowledge base.

### Audit & health
- Every action lands in `/data/audit.jsonl`, hash-chained. Integrity check
  (prints `audit chain intact`, or the index of the first tampered entry):

  ```bash
  docker exec dioscuri node -e "
  import('/app/dist/audit.js').then(async ({ FileAuditLog }) => {
    const log = { debug(){}, info(){}, warn(){}, error(){}, child() { return log; } };
    const broken = await new FileAuditLog(process.env.DIOSCURI_DATA_DIR || '/data', log).verify();
    console.log(broken === -1 ? 'audit chain intact' : 'chain broken at entry ' + broken);
    process.exit(broken === -1 ? 0 : 1);
  });"
  ```
- Monitor: `GET :8790/health` (alert on `ok:false` or `adapters.*` dropping to
  `false`), and `error`-level JSON logs.

### Updating & backup
```bash
git pull && docker compose up -d --build     # update
docker run --rm -v dioscuri_dioscuri-data:/data -v $PWD:/backup alpine \
  tar czf /backup/dioscuri-data.tgz /data    # back up the volume (KB, audit, state)
```

## 7. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `Used disallowed intents` on start | intents not enabled on the Bot tab (step 4.2) |
| Bot can't create channels/role | missing Manage Channels/Roles, or the bot's role is too low — move it up |
| Telegram moderation is silent | the bot is not a group admin |
| `GitHub rate limited` in logs | add a read-only `GITHUB_TOKEN` |
| LLM 401 | key doesn't match the provider: check `DIOSCURI_LLM_PROVIDER` vs the key |
| Port 8790 busy | change `DIOSCURI_HTTP_PORT` (and the compose mapping) |
| Provider name typo | an unknown name silently falls back to `deepseek` — check the `waking the twins` log line |

## 8. Red lines (never do this)

- DISBOARD auto-bump, self-bots, user-account automation — account bans.
- Buying members/subscribers/boosts, join4join — Discord removes servers,
  Telegram bans numbers, engagement metrics die.
- Unsolicited DMs/invites to strangers — spam under both platforms' rules.
- Secrets go in `.env` only; `dioscuri.config.json` must contain no secrets
  (it is mounted read-only and not treated as confidential).
