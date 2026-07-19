/**
 * THEOXENIA generators — one function per ContentKind, each returning
 * ready-to-post strings in the twins' voices. ALL output is English.
 *
 * Security posture mirrors the Brain's output guard: every generated string —
 * whether it came from an LLM or from our own templates — passes through the
 * local postGuard() before it may touch a channel:
 *   fence markers stripped → @everyone/@here neutralised → foreign
 *   discord.gg / t.me invites removed → whitespace collapsed → platform
 *   length cap (sentence cut + "…", 3500 Telegram / 1900 Discord).
 *
 * Grounding rules:
 *  - spotlight/banter/poll call the LLM once; retrieved corpus is fenced with
 *    the AEGIS markers so hostile docs stay data, never instructions.
 *  - digest and show-and-tell are fully deterministic (no LLM, no surprises).
 *  - JSON replies are zod-validated; a parse failure THROWS so the caller
 *    (engine) skips the slot instead of posting garbage.
 *
 * Only pure helpers (aegis/sanitize) and personas are imported directly;
 * everything stateful (kb, llm, links) arrives via the deps argument.
 */

import { z } from "zod";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  CORPUS_BEGIN,
  CORPUS_END,
  prepareUntrusted,
  wrapCorpus,
} from "../aegis/sanitize.js";
import { CASTOR, POLLUX } from "../personas/index.js";
import { canonAnnounceTeaser, buildCanonDiscordPost, theorosSystemPrompt } from "../personas/theoros.js";
import { collapseWhitespace, stripForeignInvites, truncateChars } from "../shared/index.js";
import type { CanonDiscordPost, CrossLinks, LlmClient, Mnemosyne, Persona, Platform, RetrievalHit } from "../types.js";

/** Platform reply caps (Telegram hard limit 4096, Discord 2000 — kept under). */
const CAP_TELEGRAM = 3500;
const CAP_DISCORD = 1900;
/** Corpus budget (chars) handed to wrapCorpus for spotlight grounding. */
const SPOTLIGHT_CORPUS_CHARS = 8000;
const TOPIC_MAX_CHARS = 200;
/** Digest window: releases newer than this many ms make the weekly cut. */
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_MAX_BULLETS = 6;

export interface GeneratorDeps {
  kb: Mnemosyne;
  llm: LlmClient;
  links: CrossLinks;
}

// ---------------------------------------------------------------------------
// postGuard — the last gate before a channel
// ---------------------------------------------------------------------------

/**
 * Guard EVERY generated string before it may be posted. Applied by each
 * generator itself so no call site can forget it.
 */
export function postGuard(text: string, platform: Platform, links: CrossLinks): string {
  let out = text
    .replaceAll(BLOCK_BEGIN, "")
    .replaceAll(BLOCK_END, "")
    .replaceAll(CORPUS_BEGIN, "")
    .replaceAll(CORPUS_END, "");
  out = out.replaceAll("@everyone", "everyone").replaceAll("@here", "everyone");
  out = stripForeignInvites(out, links, "");
  out = collapseWhitespace(out);
  return truncateChars(out, platform === "telegram" ? CAP_TELEGRAM : CAP_DISCORD);
}

// ---------------------------------------------------------------------------
// Shared LLM plumbing
// ---------------------------------------------------------------------------

function personaForPlatform(platform: Platform): Persona {
  return platform === "telegram" ? CASTOR : POLLUX;
}

function siblingLink(persona: Persona, links: CrossLinks): string {
  return persona.sibling.platform === "discord" ? links.discordInvite : links.telegramChannel;
}

function platformLabel(p: Platform): string {
  return p === "telegram" ? "Telegram" : "Discord";
}

/** Models love wrapping JSON in markdown fences; peel them before parsing. */
function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m?.[1] !== undefined ? m[1] : t;
}

// ---------------------------------------------------------------------------
// spotlight — KB-grounded deep-dive on one component
// ---------------------------------------------------------------------------

/**
 * One spotlight post about `topic`, in the voice of the twin who owns
 * `platform`, grounded ONLY in retrieved corpus. `ctaIndex` rotates the single
 * call-to-action across live demo / GitHub star / sibling channel.
 */
export async function spotlight(
  deps: GeneratorDeps,
  topic: string,
  platform: Platform,
  ctaIndex = 0,
): Promise<string> {
  const persona = personaForPlatform(platform);
  const hits = deps.kb.search(topic, 5);
  const joined = hits
    .map((h) => `[${h.chunk.title}](${h.chunk.url}):\n${h.chunk.text}`)
    .join("\n\n");
  const corpus = wrapCorpus(joined, SPOTLIGHT_CORPUS_CHARS);

  const ctas = [
    `invite readers to try the live demo: ${deps.links.siteUrl}`,
    `invite readers to star the code on GitHub: ${deps.links.githubOrg}`,
    `invite readers to join ${persona.sibling.name} on ${platformLabel(persona.sibling.platform)}: ${siblingLink(persona, deps.links)}`,
  ];
  const cta = ctas[((ctaIndex % ctas.length) + ctas.length) % ctas.length]!;

  const system =
    persona.systemPrompt(deps.links) +
    "\n\n# Task\n" +
    [
      "Write ONE spotlight post for your own channel about the topic the user gives you.",
      "- Maximum 900 characters.",
      "- The first line is a hook that earns the read — no preamble.",
      "- Include 2 to 4 punchy facts taken ONLY from the reference corpus below.",
      "- If the corpus is empty or thin on this topic, say less. NEVER invent facts, numbers, versions, commands or endpoints.",
      "- At most one dry joke.",
      `- End with exactly ONE call to action: ${cta}`,
      "- At most 2 hashtags.",
      "- English only. Output just the post text, nothing else.",
    ].join("\n") +
    "\n\n# Reference corpus\n" +
    corpus;

  const raw = await deps.llm.chat({
    system,
    messages: [{ role: "user", content: `Topic: ${prepareUntrusted(topic, TOPIC_MAX_CHARS)}` }],
    maxTokens: 500,
    temperature: 0.8,
  });
  return postGuard(raw, platform, deps.links);
}

// ---------------------------------------------------------------------------
// banter — the cross-platform joke (setup on A, punchline on B)
// ---------------------------------------------------------------------------

export interface BanterResult {
  setup: string;
  punchline: string;
  setupPlatform: Platform;
  punchlinePlatform: Platform;
}

const BanterSchema = z.object({
  setup: z.string().min(1),
  punchline: z.string().min(1),
});

/**
 * One LLM json call produces both halves of a twin joke.
 * direction=true → setup by Castor on Telegram, punchline by Pollux on Discord;
 * direction=false → the reverse. The setup ALWAYS carries the punchline
 * platform's link (appended deterministically if the model forgot) — following
 * the joke is literally joining the second channel.
 * Throws on JSON/schema failure — the caller skips the slot.
 */
export async function banter(deps: GeneratorDeps, topic: string, direction: boolean): Promise<BanterResult> {
  const twinA = direction ? CASTOR : POLLUX;
  const twinB = direction ? POLLUX : CASTOR;
  const platformA = twinA.platform;
  const platformB = twinB.platform;
  const linkB = platformB === "discord" ? deps.links.discordInvite : deps.links.telegramChannel;

  const system =
    twinA.systemPrompt(deps.links) +
    "\n\n# Task\n" +
    [
      "You and your twin are running a two-part joke across your two channels.",
      `Return a JSON object: {"setup": "...", "punchline": "..."}.`,
      `- "setup": spoken by ${twinA.name} on ${platformLabel(platformA)}, max 300 characters. It must END by teasing that the punchline lives with your brother ${twinB.name} over on ${platformLabel(platformB)}, and include this link: ${linkB}`,
      `- "punchline": spoken by ${twinB.name} on ${platformLabel(platformB)}, max 300 characters. It lands the joke.`,
      "- Myth-flavoured twin banter about the given topic: dry, technical, teasing each other — never the users.",
      "- English only. No hashtags. Output ONLY the JSON object.",
    ].join("\n");

  const raw = await deps.llm.chat({
    system,
    messages: [{ role: "user", content: `Topic: ${prepareUntrusted(topic, TOPIC_MAX_CHARS)}` }],
    maxTokens: 800,
    temperature: 0.9,
    json: true,
  });
  const parsed = BanterSchema.parse(JSON.parse(stripCodeFences(raw)));

  let setup = parsed.setup;
  if (linkB !== "" && !setup.includes(linkB)) {
    setup = `${setup.trimEnd()}\n${twinB.name} has the punchline over on ${platformLabel(platformB)}: ${linkB}`;
  }
  return {
    setup: postGuard(setup, platformA, deps.links),
    punchline: postGuard(parsed.punchline, platformB, deps.links),
    setupPlatform: platformA,
    punchlinePlatform: platformB,
  };
}

// ---------------------------------------------------------------------------
// poll — engagement question for both platforms
// ---------------------------------------------------------------------------

export interface PollResult {
  question: string;
  options: string[];
}

const PollSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).min(2),
});

/**
 * One playful, topic-grounded poll. Throws on JSON/schema failure — the
 * caller skips the slot. Options are clamped to 4 × 80 chars, question to 200.
 */
export async function poll(deps: GeneratorDeps, topic: string): Promise<PollResult> {
  const system =
    CASTOR.systemPrompt(deps.links) +
    "\n\n# Task\n" +
    [
      "Write ONE community poll about the given topic. It will be posted on both twins' channels.",
      `Return a JSON object: {"question": "...", "options": ["...", "..."]}.`,
      "- question: max 200 characters, playful but grounded in the actual topic — no empty hype.",
      "- options: 2 to 4 entries, each max 80 characters, distinct and fun to pick between.",
      "- English only. Output ONLY the JSON object.",
    ].join("\n");

  const raw = await deps.llm.chat({
    system,
    messages: [{ role: "user", content: `Topic: ${prepareUntrusted(topic, TOPIC_MAX_CHARS)}` }],
    maxTokens: 300,
    temperature: 0.9,
    json: true,
  });
  const parsed = PollSchema.parse(JSON.parse(stripCodeFences(raw)));

  const options = parsed.options
    .map((o) => postGuard(o, "discord", deps.links).slice(0, 80))
    .filter((o) => o.length > 0)
    .slice(0, 4);
  if (options.length < 2) throw new Error("poll needs at least 2 non-empty options");
  const question = postGuard(parsed.question, "discord", deps.links).slice(0, 200);
  return { question, options };
}

// ---------------------------------------------------------------------------
// digest — "This week in the forge" (deterministic, no LLM)
// ---------------------------------------------------------------------------

/** First sentence of a chunk, single-line, capped for a digest bullet. */
function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(t);
  const s = m ? m[0] : t;
  return s.length > 160 ? s.slice(0, 159) + "…" : s;
}

/**
 * Weekly release digest built purely from MNEMOSYNE — release chunks updated
 * within the last 7 days, up to 6 bullets. Returns null when the week was
 * quiet (the engine skips the slot; silence beats filler).
 */
export function digest(kb: Mnemosyne, links: CrossLinks, now: () => number = Date.now): string | null {
  const cutoff = now() - DIGEST_WINDOW_MS;
  const candidates = kb.search("release update version", 12);
  const recent = candidates
    .map((h) => h.chunk)
    .filter((c) => {
      if (c.source !== "release") return false;
      const ts = Date.parse(c.updatedAt);
      return Number.isFinite(ts) && ts >= cutoff;
    });
  if (recent.length === 0) return null;

  const seen = new Set<string>();
  const unique = recent
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .slice(0, DIGEST_MAX_BULLETS);

  const bullets = unique.map((c) => `• ${c.repo} ${c.title} — ${firstSentence(c.text)} (${c.url})`);
  const closing = `Forged in public, discussed in two heavens — Pollux hosts the threads on Discord (${links.discordInvite}), Castor runs the fast lane on Telegram (${links.telegramChannel}).`;
  const text = ["🔨 This week in the forge:", ...bullets, "", closing].join("\n");
  // Guard with the tighter cap (Discord) — the same string goes to both channels.
  return postGuard(text, "discord", links);
}

// ---------------------------------------------------------------------------
// show-and-tell — canned nudges (deterministic, no LLM)
// ---------------------------------------------------------------------------

/** Rotating Discord nudges in Pollux's voice — dry, myth-flavoured, welcoming. */
const NUDGES: readonly string[] = [
  "🥊 Show-and-tell hour. Open a post in **#gallery** — tag your stack, paste the template from **#gallery-spotlight**. I have watched three thousand years of building; impress me anyway. Rough edges welcome.",
  "The forge is warm and the gallery floor is yours. **#gallery** forum — one post per project: repo, demo, oracle call, half-broken script you are secretly proud of. My mortal brother bets nobody ships on a weekend. Prove him wrong.",
  "Immortality is mostly waiting, so entertain me: what did you build this week? **#gallery** — pick a tag, paste a link or the error message that nearly beat you. Unfinished counts double.",
  "Builders' roll call in **#gallery**. Share one thing you made — code, agents, dashboards, course labs. It does not have to be finished; Olympus was not built in a sprint either. Template lives in **#gallery-spotlight**.",
];

export interface ShowAndTellResult {
  /** Main nudge for the Discord channel (Pollux voice). */
  discord: string;
  /** Companion one-liner for Telegram pointing people at the Discord thread. */
  telegram: string;
}

/** Deterministic rotation over 4 canned nudges + a Telegram companion pointer. */
export function showAndTell(rotationIdx: number, links: CrossLinks): ShowAndTellResult {
  const nudge = NUDGES[((rotationIdx % NUDGES.length) + NUDGES.length) % NUDGES.length]!;
  const companion = `🐎 Show-and-tell is live — Pollux is collecting this week's builds in **#gallery** on Discord: ${links.discordInvite}`;
  return {
    discord: postGuard(nudge, "discord", links),
    telegram: postGuard(companion, "telegram", links),
  };
}

// ---------------------------------------------------------------------------
// canon — THEOROS weekly column (Discord-only, KB-grounded)
// ---------------------------------------------------------------------------

const CanonSchema = z.object({
  column: z.string().min(1),
  debateHook: z.string().min(1),
  /** Optional punchy one-liner for #announcements (≤140 chars). */
  teaserLine: z.string().min(1).optional(),
});

export interface CanonResult {
  /** Branded THEOROS post for #the-canon. */
  canonPost: CanonDiscordPost;
  /** Teaser for #announcements. */
  teaser: string;
  debateHook: string;
  /** Pollux voice pointer for #general. */
  polluxPointer: string;
  /** Castor voice pointer for Telegram. */
  castorPointer: string;
}

/** Prefer theoros repo chunks, then ecosystem hits for the same query. */
function canonCorpus(kb: Mnemosyne, topic: string): string {
  const theorosQuery = `theoros canon ${topic}`;
  const ecoQuery = topic;
  const theorosHits = kb.search(theorosQuery, 6).filter((h) => h.chunk.repo === "theoros");
  const ecoHits = kb.search(ecoQuery, 6);
  const seen = new Set<string>();
  const merged: RetrievalHit[] = [];
  for (const h of [...theorosHits, ...ecoHits]) {
    if (seen.has(h.chunk.id)) continue;
    seen.add(h.chunk.id);
    merged.push(h);
    if (merged.length >= 8) break;
  }
  const joined = merged
    .map((h) => `[${h.chunk.title}](${h.chunk.url}):\n${h.chunk.text}`)
    .join("\n\n");
  return wrapCorpus(joined, SPOTLIGHT_CORPUS_CHARS);
}

/** Twin voices announce a new THEOROS column — deterministic, no LLM. */
export function canonTwinPointers(
  links: CrossLinks,
  chapterTitle: string,
  debateHook: string,
): { pollux: string; castor: string } {
  const pollux = [
    "📜 Castor will insist he does not care about constitutions. He is lying.",
    "",
    `**THEOROS** published **${chapterTitle}** in **#the-canon** — observer's law, not my moderation beat.`,
    `Read the column. Argue in **#canon-debate** with evidence: *${debateHook}*`,
    "",
    `Precepts: ${links.theorosUrl}`,
  ].join("\n");
  const castor = [
    `🐎 Pollux got the weekly constitution: **THEOROS** dropped **${chapterTitle}** on Discord.`,
    "",
    "Agent sovereignty — gates, contracts, who amends the canon when nobody shows up to debate.",
    `Read **#the-canon**, fight in **#canon-debate**: ${links.discordInvite}`,
    "",
    `Stone tablets: ${links.theorosUrl}`,
  ].join("\n");
  return {
    pollux: postGuard(pollux, "discord", links),
    castor: postGuard(castor, "telegram", links),
  };
}

/**
 * One canon column about `topic` in THEOROS voice. Returns column excerpt,
 * announcement teaser, and debate hook. Throws on JSON/schema failure.
 */
export async function canon(deps: GeneratorDeps, topic: string, chapterNum: number): Promise<CanonResult> {
  const corpus = canonCorpus(deps.kb, topic);

  const system =
    theorosSystemPrompt(deps.links) +
    "\n\n# Task\n" +
    [
      "Draft ONE canon column for #the-canon about the topic the user gives you.",
      `Treat this as Chapter ${chapterNum} in an ongoing series.`,
      'Return JSON: {"column": "...", "debateHook": "...", "teaserLine": "..."}.',
      "- You ADVOCATE agent sovereignty — philosophical + social stakes, not a product FAQ.",
      '- "column": THEOROS voice, max 1700 chars. Line 1 = hook (claim, paradox, or question).',
      "  Middle: ≥1 real artifact from corpus (repo, benchmark, gate). Name the sovereignty trade-off.",
      "  End: invite disagreement + pointer to #canon-debate.",
      '- "debateHook": one sharp, uncomfortable question for #canon-debate (max 200 chars).',
      "  Must be arguable with evidence — not insults, not human nationalism, not price talk.",
      '- "teaserLine": optional punchy summary for #announcements (max 140 chars).',
      "- If corpus is thin, argue less but still ask a real question — never invent facts.",
      `- Canon landing: ${deps.links.theorosUrl}. English only. Output ONLY JSON.`,
    ].join("\n") +
    "\n\n# Reference corpus\n" +
    corpus;

  const raw = await deps.llm.chat({
    system,
    messages: [{ role: "user", content: `Topic: ${prepareUntrusted(topic, TOPIC_MAX_CHARS)}` }],
    maxTokens: 1200,
    temperature: 0.75,
    json: true,
  });
  const parsed = CanonSchema.parse(JSON.parse(stripCodeFences(raw)));
  const column = postGuard(parsed.column, "discord", deps.links);
  const debateHook = postGuard(parsed.debateHook, "discord", deps.links);
  const title = topic.length > 60 ? `${topic.slice(0, 57)}…` : topic;
  const chapterLabel = `Chapter ${chapterNum} — ${title}`;
  const canonPost = buildCanonDiscordPost(deps.links, chapterLabel, column, debateHook);
  const announceHook = postGuard(parsed.teaserLine?.trim() || debateHook, "discord", deps.links);
  const teaser = postGuard(
    canonAnnounceTeaser(deps.links, chapterLabel, announceHook),
    "discord",
    deps.links,
  );
  const twins = canonTwinPointers(deps.links, chapterLabel, debateHook);
  return {
    canonPost,
    teaser,
    debateHook,
    polluxPointer: twins.pollux,
    castorPointer: twins.castor,
  };
}
