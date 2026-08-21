/**
 * HELIOS syndication hook — append jobs to the shared queue (fail-soft).
 *
 * Charter: DIOSCURI never holds YouTube OAuth; it only enqueues a job descriptor.
 * Master gate: HELIOS_SYNDICATION=1 + HELIOS_QUEUE_PATH.
 *
 * Producers:
 *   - THEOROS canon → `theoros-short` (on when master gate is on)
 *   - GitHub releases → `release-short` (opt-in: HELIOS_RELEASE_SHORTS=1)
 *
 * Default product mix: seasonal Calliope + Theoros. Release "shipped" shorts are optional.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { CanonDiscordPost, Logger, ReleaseEvent } from "../types.js";

export interface HeliosEnqueueOpts {
  log: Logger;
  queuePath: string;
}

export function isHeliosSyndicationEnabled(): boolean {
  return process.env.HELIOS_SYNDICATION === "1" && Boolean(process.env.HELIOS_QUEUE_PATH?.trim());
}

/** Release "X shipped" shorts — off unless explicitly opted in. */
export function isHeliosReleaseShortsEnabled(): boolean {
  if (!isHeliosSyndicationEnabled()) return false;
  const v = (process.env.HELIOS_RELEASE_SHORTS ?? "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function appendJob(queuePath: string, job: Record<string, unknown>, opts: HeliosEnqueueOpts, label: string): void {
  const path = queuePath.trim();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(job) + "\n", { encoding: "utf-8", mode: 0o600 });
    opts.log.info("HELIOS job enqueued", { label, template: job.template });
  } catch (err) {
    opts.log.warn("HELIOS enqueue failed (fail-soft)", { label, err: String(err) });
  }
}

export function enqueueReleaseVideo(ev: ReleaseEvent, opts: HeliosEnqueueOpts): void {
  if (!isHeliosReleaseShortsEnabled()) {
    opts.log.info("HELIOS release-short skipped — set HELIOS_RELEASE_SHORTS=1 to enable", {
      repo: ev.repo,
      tag: ev.tag,
    });
    return;
  }
  const repo = ev.repo.split("/").pop() ?? ev.repo;
  const visuals = releaseVisualsForRepo(repo);
  const job = {
    template: "release-short",
    vars: {
      repo,
      tag: ev.tag,
      url: ev.url,
      summary: ev.summary.slice(0, 500),
      hero: visuals.hero,
      still: visuals.still,
    },
    youtube: {
      title: `${repo} ${ev.tag} shipped`.slice(0, 100),
      description: `${ev.summary}\n\n${ev.url}`.slice(0, 4000),
      tags: ["AIAgents", "OpenSource"],
      privacy: "private",
    },
    idempotency_key: `release:${ev.repo}:${ev.tag}`,
    source: "dioscuri",
    phase: "steady",
  };
  appendJob(opts.queuePath, job, opts, `${ev.repo}@${ev.tag}`);
}

/** Match Helios visuals_catalog — never Factory dashboard on oracles/Platon. */
function releaseVisualsForRepo(repo: string): { hero: string; still: string } {
  const key = repo.toLowerCase();
  const map: Record<string, { hero: string; still: string }> = {
    "aimarket-courses": { hero: "course-hero-16x9.png", still: "course-hero-16x9.png" },
    "aicom-landing": { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    dioscuri: { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    theoros: { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    "alien-monitor": { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    aicom: { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    metis: { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    skopos: { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    helios: { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" },
    acex: { hero: "pulse-floor.png", still: "pulse-floor.png" },
    "pulse-terminal": { hero: "pulse-floor.png", still: "pulse-floor.png" },
    "aimarket-hub": { hero: "hero-demo-preview.gif", still: "hero-demo-preview.gif" },
    argus: { hero: "hero-demo-preview.gif", still: "hero-demo-preview.gif" },
    "aimarket-mcp": { hero: "hero-demo-preview.gif", still: "hero-demo-preview.gif" },
    oracles: { hero: "platon-umbral-hero.gif", still: "platon-cosmos.png" },
    platon: { hero: "platon-umbral-hero.gif", still: "platon-cosmos.png" },
    gaia: { hero: "platon-umbral-hero.gif", still: "platon-cosmos.png" },
    chronos: { hero: "platon-umbral-hero.gif", still: "platon-cosmos.png" },
  };
  return map[key] ?? { hero: "alien-monitor-hero.gif", still: "alien-monitor-hero.gif" };
}

/** Max chars per VO beat — keeps a Short roughly under ~60s at ~165 wpm. */
const HOOK_MAX = 220;
const BODY_MAX = 320;
const DEBATE_MAX = 200;

/**
 * Split Theoros's column into Short VO beats without rewriting.
 * Words are preserved; we only cut on sentence boundaries when possible.
 */
export function theorosVoBeats(
  column: string,
  debateHook: string,
): { hook: string; body: string; debate: string } {
  const cleaned = column.replace(/\s+/g, " ").trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let hook = "";
  let body = "";
  for (const sentence of sentences) {
    if (!hook) {
      hook = sentence.slice(0, HOOK_MAX);
      continue;
    }
    if ((body + " " + sentence).trim().length <= BODY_MAX) {
      body = (body ? `${body} ${sentence}` : sentence).trim();
    } else if (!body) {
      body = sentence.slice(0, BODY_MAX);
      break;
    } else {
      break;
    }
  }
  if (!hook) hook = cleaned.slice(0, HOOK_MAX);
  if (!body) {
    const rest = cleaned.slice(hook.length).trim();
    body = (rest || hook).slice(0, BODY_MAX);
  }

  // Brace keys would collide with Helios `{var}` substitution — neutralize.
  const scrub = (s: string) => s.replace(/[{}]/g, "");

  return {
    hook: scrub(hook),
    body: scrub(body),
    debate: scrub(debateHook.trim().slice(0, DEBATE_MAX) || "Disagree in #canon-debate."),
  };
}

export interface TheorosEnqueueInput {
  chapterLabel: string;
  /** Full guarded column body — Theoros's words. */
  column: string;
  debateHook: string;
  canonUrl: string;
  /** Stable id for idempotency, e.g. chapter index + topic hash. */
  chapterKey: string;
}

/**
 * Enqueue a THEOROS Short built from the canon column itself.
 * Helios must NOT rewrite this — vars are Theoros prose passed through.
 */
export function enqueueTheorosVideo(input: TheorosEnqueueInput, opts: HeliosEnqueueOpts): void {
  const beats = theorosVoBeats(input.column, input.debateHook);
  const chapter = input.chapterLabel.replace(/^Chapter\s+/i, "").slice(0, 80);
  const job = {
    template: "theoros-short",
    vars: {
      chapter,
      hook: beats.hook,
      body: beats.body,
      debate: beats.debate,
      canon_url: input.canonUrl.slice(0, 200),
      // Full column for audit / verification that Dioscuri passed Theoros's words.
      column: input.column.slice(0, 2000),
    },
    youtube: {
      title: `THEOROS · ${chapter}`.slice(0, 100),
      description: [
        input.column.slice(0, 1500),
        "",
        input.debateHook,
        "",
        input.canonUrl,
        "",
        "#THEOROS #AgentSovereignty #AICanon #Shorts",
      ].join("\n").slice(0, 4000),
      tags: ["THEOROS", "AgentSovereignty", "AICanon", "Shorts"],
      // Private first — operator (or HELIOS_AUTO_APPROVE) promotes after review.
      privacy: "private",
    },
    idempotency_key: `theoros:${input.chapterKey}`.slice(0, 256),
    source: "dioscuri-theoros",
    phase: "creator",
  };
  appendJob(opts.queuePath, job, opts, input.chapterLabel);
}

/** Convenience when the caller already has a CanonDiscordPost. */
export function enqueueTheorosFromCanonPost(
  post: CanonDiscordPost,
  chapterKey: string,
  opts: HeliosEnqueueOpts,
): void {
  enqueueTheorosVideo(
    {
      chapterLabel: post.chapterLabel,
      column: post.body,
      debateHook: post.debateHook,
      canonUrl: post.canonUrl,
      chapterKey,
    },
    opts,
  );
}
