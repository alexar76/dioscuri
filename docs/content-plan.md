# THEOXENIA — Content & Marketing Plan

*The feast the twins host. How CASTOR (Telegram) and POLLUX (Discord) keep two
channels alive, honest, and pointed at each other.*

---

## 1. Positioning

**The channels ARE the product demo.** The AICOM ecosystem sells autonomous,
trustworthy AI agents — so the community is run by two of them, in public,
around the clock. Every good answer, every on-time digest, every joke that
lands across two platforms is a live demonstration of the stack (LLM plumbing,
retrieval, injection firewall, scheduling) doing its job. When a visitor asks
"can your agents actually run something real?", the honest reply is: *you are
standing inside one.*

Two consequences follow:

1. **Every post is grounded in MNEMOSYNE.** Facts come from the knowledge base
   synced from GitHub — README chunks, release notes, repo metadata. If the KB
   does not know something, the twins say less. **A hallucinated fact in a post
   is a product bug**, filed and fixed like any other bug, because the channel
   is the demo.
2. **Character over volume.** Two named personas with a myth, running gags and
   opinions beat a firehose of announcements. People join channels for people
   (even synthetic ones); they mute megaphones.

## 2. Five pillars → `ContentKind`

| Pillar | `ContentKind` | What it is | Goal |
|---|---|---|---|
| Deep-dives | `spotlight` | One component per post (factory, oracles, ARGUS, AIMarket…), 2–4 KB-grounded facts, one CTA | Teach the ecosystem piece by piece; drive demo visits and GitHub stars |
| Twin comedy | `banter` | Setup on one platform, punchline on the other, 15 minutes apart | **The cross-platform traffic mechanic: following the joke = joining the second channel.** The setup names where the punchline lives and links it |
| Participation | `poll` | Playful, grounded question, native poll where the platform supports it | Cheap engagement signal; teaches lurkers the reply button exists |
| Proof of life | `digest` | "🔨 This week in the forge" — deterministic list of the week's releases from the KB | Show relentless shipping cadence without hype; zero LLM, zero hallucination surface |
| Community stage | `show-and-tell` | Discord-first nudge to post what you built; Telegram gets a pointer | Convert readers into builders; user content is the best content we do not have to write |
| Sovereignty column | `canon` | **THEOROS** — weekly agent-sovereignty argument in `#the-canon`; teaser in `#announcements` | Retention ritual: philosophy + social questions, provocation anchored in code; debate in `#canon-debate` |

**THEOROS** is not a sixth twin — he is a separate persona inside the same process. See [docs/theoros.md](theoros.md) for architecture, voice charter, and operator checklist.

Banter deserves the emphasis: every other growth tactic costs money or spam.
A two-part joke costs nothing and gives a member of one channel a *reason* to
open the other. The punchline platform alternates every run so traffic flows
both ways.

## 3. Weekly calendar

Default slots (editable in `dioscuri.config.json` → `content.slots`):

| Day | UTC | Kind | Platform |
|---|---|---|---|
| Mon | 15:00 | spotlight | alternates Telegram/Discord |
| Tue | 17:00 | banter | setup A → punchline B (+15 min) |
| Wed | 15:00 | poll | both |
| Thu | 16:00 | spotlight | alternates |
| Fri | 15:00 | digest | both |
| Sat | 17:00 | banter | direction flipped |
| Sat | 14:00 | show-and-tell | Discord main + Telegram pointer |
| Sun | 16:00 | **canon** | **THEOROS → #the-canon** + teaser → `#announcements` |

**Why 15–17 UTC:** it is the overlap of the two audiences we actually have —
**European evening (16–19 CET/CEST) and US morning-to-lunch (10–13 ET)**. One
slot catches both continents awake; nothing posts into the dead zone where
only the bots would read it. Weekend banter sits at 17:00 UTC because weekend
scrolling skews later.

## 4. Tone & humor guide

- **Dry, self-aware, myth-flavored.** One Olympus touch per post at most; the
  substance is always technical and concrete (a repo, a version, a port).
- **The twins tease each other, never users.** Castor grumbles about being the
  mortal one; Pollux finds every bug "young". A user is never the punchline.
- **No "fellow kids".** No forced slang, no emoji walls, no "gm fam". If a joke
  would embarrass a good staff engineer, it does not ship.
- **Silence beats filler.** A quiet week produces no digest, not a padded one.

**Visuals roadmap:**

- **v0.1 — text memes only.** Well-written words, sparse emoji as signposts
  (🔨 digest, 🗳 poll). Ships now, ages well.
- **Branded PNG cards** (deterministic SVG→PNG via the `CardRenderer`) for
  `release`, `digest` and `banter` posts — consistent, cheap, on-brand.
- **AI meme images: optional and capped at 2/week**
  (`content.images.aiMemesPerWeek`), off by default. Prompts are built ONLY
  from our own templates and config topics — user text never reaches an image
  prompt. Cringe is a cost too; the cap guards both budgets.
- **Live-demo screenshots** (Alien Monitor, factory dashboard) are on the
  roadmap once capture can be automated — real pixels of real products beat
  any illustration.

## 5. Cadence discipline

- **Hard cap: 3 proactive posts per platform per UTC day**
  (`content.maxPostsPerDay`) across ALL content and promo. Feeds that post more
  get muted; muted is dead.
- **Quiet hours 22:00–07:00 UTC** (`content.quietHoursUtc`, wraps midnight).
  Nothing proactive lands while the audience sleeps. Manual triggers may
  bypass quiet hours; nothing bypasses the daily cap.
- **±30 minutes of jitter** on every slot so the channels feel inhabited, not
  cron-driven.
- **14-day topic dedup**: a topic posted for a given kind is skipped for two
  weeks; when everything is recent, the least recently used topic returns.

## 6. Author workflow

Humans steer, agents execute:

1. **Drop topics into `data/content-queue.json`** — consumed before any
   rotating topic, first match wins, then removed from the file:

   ```json
   [
     { "kind": "spotlight", "topic": "PLATON oracle federated transport", "note": "just shipped, has fresh release notes" },
     { "kind": "banter", "topic": "the lottery on Base" },
     { "topic": "WARDEN MCP firewall" }
   ]
   ```

   `kind` is optional — an item without it can be picked up by any slot.
   `note` is for humans; the engine ignores it.
2. **Edit the rotation and the rhythm in `dioscuri.config.json`** —
   `content.topics` (the evergreen rotation), `content.slots` (days/hours),
   caps and quiet hours. The file is mounted read-only in Docker and holds no
   secrets.
3. **Audit trail**: every post writes a `content.post` entry (first 80 chars)
   into the hash-chained audit log — what went out is always reconstructable.

## 7. KPIs

| Metric | Reads on | Target signal |
|---|---|---|
| Member growth per channel | weekly | steady positive slope, no spam spikes |
| Messages/day (non-bot) | weekly | conversation, not broadcast: replies > reactions |
| Cross-link click-through after banter days | per banter | the joke moved people between platforms — the pillar's whole point |
| GitHub stars delta after spotlights | per spotlight | spotlights create repo visits, visits create stars |
| Poll participation rate | per poll | lurker → participant conversion |
| Show-and-tell submissions | monthly | the community produces content without us |

If banter click-through stays flat for a month, the jokes are not good enough —
fix the writing, not the schedule.

## 8. Hard rules

- **English only** for every proactive post, regardless of audience languages
  (replies mirror the asker's language; that path is the Brain's, not ours).
- **Exactly one CTA per post.** A post that asks for two things gets neither.
- **No financial advice, no token hype, no price talk.** On-chain features are
  described factually or not at all.
- **Never `@everyone`/`@here`, never foreign invite links** — enforced in code
  (`postGuard`), not by good intentions.
- **Grounded or silent.** No KB support → no claim. Hallucination is a bug.
