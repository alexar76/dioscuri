/**
 * THEOXENIA state — the content engine's persistent memory + the author queue.
 *
 * Two small JSON files under dataDir:
 *
 *  - theoxenia.json      engine state: recently posted topic hashes (14-day
 *                        dedup window), per-kind rotation indices, per-platform
 *                        daily post counters (UTC date), and the two alternation
 *                        toggles (banter direction, spotlight platform).
 *  - content-queue.json  author-editable array of QueuedTopic — hand-dropped
 *                        topics that are consumed BEFORE the rotating config
 *                        topics. Humans edit this file by hand, so it is parsed
 *                        defensively: malformed → warn + treated as empty.
 *
 * Constraints:
 *  - All writes are atomic (tmp file + rename) so a crash mid-write can never
 *    leave a half-written file behind.
 *  - Missing or corrupt state is tolerated: the engine must come up from any
 *    disk condition; it just starts with fresh defaults.
 *  - The clock is injectable (pruning, daily rollover) for deterministic tests.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ContentKind, Logger, QueuedTopic } from "../types.js";

const STATE_FILE = "theoxenia.json";
const QUEUE_FILE = "content-queue.json";
/** Posted-topic hashes older than this are pruned (dedup window). */
const HASH_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** sha256 over kind+topic — the dedup key for "posted recently". */
export function topicHash(kind: ContentKind, topic: string): string {
  return createHash("sha256").update(`${kind}\n${topic}`).digest("hex");
}

/** Atomic JSON write: write tmp sibling, then rename over the target. */
export function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

/** Async version — use on hot paths to avoid blocking the event loop. */
export async function atomicWriteJsonAsync(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

const StateSchema = z.object({
  postedHashes: z
    .array(
      z
        .object({
          // Accept old "h" key for backward compat on disk; canonicalise to "hash".
          h: z.string().optional(),
          hash: z.string().optional(),
          ts: z.number(),
        })
        .transform((v) => ({ hash: v.hash ?? v.h ?? "", ts: v.ts })),
    )
    .catch([]),
  rotation: z.record(z.number()).catch({}),
  dailyCounts: z
    .object({ date: z.string(), perPlatform: z.record(z.number()) })
    .catch({ date: "", perPlatform: {} }),
  banterDirection: z.boolean().catch(true),
  spotlightPlatform: z.boolean().catch(true),
  /** AI-meme budget: ISO date of the UTC week's Monday + memes posted since. */
  weeklyMemes: z.object({ week: z.string(), count: z.number() }).catch({ week: "", count: 0 }),
});

export type TheoxeniaStateData = z.infer<typeof StateSchema>;

function defaults(): TheoxeniaStateData {
  return {
    postedHashes: [],
    rotation: {},
    dailyCounts: { date: "", perPlatform: {} },
    banterDirection: true,
    spotlightPlatform: true,
    weeklyMemes: { week: "", count: 0 },
  };
}

/** UTC calendar date for the daily counters. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class TheoxeniaState {
  readonly data: TheoxeniaStateData;
  private readonly file: string;

  constructor(
    private readonly dataDir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, STATE_FILE);
    this.data = this.load();
    this.pruneHashes();
  }

  /** Missing file → defaults; unparseable file → warn + defaults. */
  private load(): TheoxeniaStateData {
    if (!existsSync(this.file)) return defaults();
    try {
      return StateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (err) {
      this.log.warn("theoxenia state unreadable — starting fresh", {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      return defaults();
    }
  }

  /** Non-blocking save for hot paths (every content post). */
  async save(): Promise<void> {
    await atomicWriteJsonAsync(this.file, this.data);
  }

  /** Drop dedup hashes older than the 14-day window. */
  pruneHashes(): void {
    const cutoff = this.now() - HASH_TTL_MS;
    this.data.postedHashes = this.data.postedHashes.filter((e) => e.ts >= cutoff);
  }

  hasRecentHash(h: string): boolean {
    this.pruneHashes();
    return this.data.postedHashes.some((e) => e.hash === h);
  }

  /** Timestamp a hash was last posted at (for least-recent fallback), or undefined. */
  hashTs(h: string): number | undefined {
    return this.data.postedHashes.find((e) => e.hash === h)?.ts;
  }

  recordHash(h: string): void {
    this.pruneHashes();
    this.data.postedHashes = this.data.postedHashes.filter((e) => e.hash !== h);
    this.data.postedHashes.push({ hash: h, ts: this.now() });
  }

  /** Reset counters when the UTC day rolled over since the last touch. */
  private rolloverDaily(): void {
    const today = utcDate(this.now());
    if (this.data.dailyCounts.date !== today) {
      this.data.dailyCounts = { date: today, perPlatform: {} };
    }
  }

  countToday(platform: string): number {
    this.rolloverDaily();
    return this.data.dailyCounts.perPlatform[platform] ?? 0;
  }

  bumpToday(platform: string): void {
    this.rolloverDaily();
    this.data.dailyCounts.perPlatform[platform] = (this.data.dailyCounts.perPlatform[platform] ?? 0) + 1;
  }

  /** Monday (UTC) of the current week — the AI-meme budget window key. */
  private weekKey(): string {
    const d = new Date(this.now());
    const shift = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    d.setUTCDate(d.getUTCDate() - shift);
    return d.toISOString().slice(0, 10);
  }

  private rolloverWeekly(): void {
    const week = this.weekKey();
    if (this.data.weeklyMemes.week !== week) {
      this.data.weeklyMemes = { week, count: 0 };
    }
  }

  memesThisWeek(): number {
    this.rolloverWeekly();
    return this.data.weeklyMemes.count;
  }

  bumpMemes(): void {
    this.rolloverWeekly();
    this.data.weeklyMemes.count += 1;
  }

  /** Rotation indices are keyed by ContentKind (plus internal keys like "spotlight-cta"). */
  getRotation(key: string): number {
    return this.data.rotation[key] ?? 0;
  }

  setRotation(key: string, value: number): void {
    this.data.rotation[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Author topic queue (content-queue.json)
// ---------------------------------------------------------------------------

const QueuedTopicSchema = z.object({
  kind: z.enum(["spotlight", "banter", "poll", "digest", "show-and-tell", "canon"]).optional(),
  topic: z.string().min(1),
  note: z.string().optional(),
});
const QueueSchema = z.array(QueuedTopicSchema);

/** Read the whole author queue. Missing → []; malformed → warn + []. */
export function readQueue(dataDir: string, log: Logger): QueuedTopic[] {
  const file = join(dataDir, QUEUE_FILE);
  if (!existsSync(file)) return [];
  try {
    return QueueSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    log.warn("content queue malformed — treating as empty", {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Pop the first queued topic usable for `kind` (matching kind, or no kind at
 * all = usable anywhere) and atomically rewrite the queue without it.
 * Returns null when nothing matches.
 */
export function consumeQueue(dataDir: string, kind: ContentKind, log: Logger): QueuedTopic | null {
  const items = readQueue(dataDir, log);
  const idx = items.findIndex((it) => it.kind === undefined || it.kind === kind);
  if (idx === -1) return null;
  const [item] = items.splice(idx, 1);
  atomicWriteJson(join(dataDir, QUEUE_FILE), items);
  return item ?? null;
}
