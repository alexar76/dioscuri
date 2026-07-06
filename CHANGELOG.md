# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-04

### Added

- Twin personas: CASTOR (Telegram, grammY long-polling) and POLLUX (Discord,
  discord.js gateway) — one process, one voice contract, mutual cross-promotion.
- MNEMOSYNE knowledge base: periodic self-sync from the AICOM GitHub org
  (READMEs, releases, repo metadata, and a 14-day recent-commits digest per
  repo) with ETag-aware fetching, poisoned-document filtering on ingestion,
  and deterministic lexical retrieval (no model calls).
- Live project showcase: read-only polling of the ecosystem's public demo
  endpoints (config-driven) → bounded JSON flattening with secret-key
  skipping → AEGIS-gated "LIVE snapshot" chunks in the knowledge base.
- THEOXENIA content calendar: weekly slots (spotlight / cross-platform banter
  / poll / deterministic release digest / show-and-tell), author topic queue
  (`content-queue.json`), quiet hours, daily caps, topic dedup.
- Branded PNG cards (SVG → sharp) for releases/digests/banter; optional AI
  meme providers (openai / together / self-hosted ComfyUI), off by default and
  capped, with template-only prompts (user text never reaches image prompts).
- Discord auto-provisioning: idempotent server structure (categories,
  channels, Keeper role, permission overwrites, pinned welcome manifest) —
  never deletes or renames; Telegram auto-setup (command menu, pinned links);
  first-boot "opening feast" posts.
- Multi-provider LLM client: deepseek (default), anthropic(-compatible),
  openai(-compatible) and local presets (ollama / lmstudio / llama.cpp) with
  retries, timeouts, a daily budget, and a circuit-breaker failover chain
  (`DIOSCURI_LLM_FALLBACK_PROVIDER`).
- KERYX (the herald): post-only syndication of release announcements to
  Bluesky and Mastodon (free, bot-friendly APIs) and optionally X (explicit
  `X_SYNDICATION=1` pay-per-use opt-in; OAuth 1.0a hand-rolled on
  node:crypto); deterministic monthly digest article on dev.to (quiet months
  publish nothing). No engagement automation by charter — own accounts only.
- Discord growth mechanics: announcements auto-crosspost when the channel is
  an Announcement channel (other servers can Follow it; the provisioner
  creates/upgrades the channel type on Community servers), and an optional
  DISBOARD bump *reminder* that pings Keepers when the 2-hour cooldown ends —
  the bot never bumps by itself (auto-bumping violates DISBOARD guidelines).
- AEGIS injection shield: NFKC normalisation, control/zero-width stripping,
  internal-marker neutralisation, EN+RU signature firewall, fenced-data
  prompting, and an output guard on everything the twins post.
- Tool-less Q&A brain: deterministic retrieval before the model call; the model
  can only produce text — the public path executes nothing by construction.
- Deterministic-first moderation with hard action ceilings: warn / delete /
  timeout (capped, 10 min default) / escalate to human mods — automatic bans do
  not exist in the action space; the LLM classifier is advisory-only.
- Hash-chained audit log (`audit.jsonl`): every entry commits to its
  predecessor via SHA-256; `verify()` pinpoints the first tampered line.
- Cost & rate guards: per-user and per-channel rate limits plus a daily LLM
  call budget.
- Health endpoint (`GET /health` on :8790) reporting adapter readiness,
  knowledge-base stats and dry-run state.
- Dry-run mode (`DIOSCURI_DRY_RUN=1`): full boot with zero platform/LLM tokens
  — KB sync and health endpoint only.
- Hardened Docker deployment: multi-stage image, non-root user, read-only
  rootfs, `cap_drop: ALL`, `no-new-privileges`, memory/CPU limits, healthcheck.
- CI workflow (typecheck, unit tests, no-push Docker build), MIT license,
  English + Russian READMEs, security and architecture documentation.
