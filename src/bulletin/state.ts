/**
 * BULLETIN / state — what we have already said, so we never say it twice.
 *
 * One small JSON file under dataDir (`bulletin-state.json`) holding, per advisory
 * id, the revision we announced and the platform message ids we got back:
 *
 *   { "posted": { "MOMUS-2026-0007": { "modified": "...", "status": "open",
 *                                      "postedAt": 1754…, "messages": { "discord": "12…" } } } }
 *
 * WHAT IS NOT IN THIS FILE. Nothing about a person. No member ids, no author, no
 * who-read-what, no engagement of any kind — and no advisory TEXT either: the
 * bulletin is public, so re-reading it costs nothing, while a local copy would be
 * a second source of truth that can drift from MOMUS's. The file is a list of
 * announcements we have made. Keep it that way; anything added here should have to
 * justify itself the same way.
 *
 * Behaviour:
 *  - A restart re-reads this file, so an unchanged index posts NOTHING. That is
 *    the whole reason it exists: a publisher that re-announces its backlog on
 *    every boot is a publisher a community mutes.
 *  - An advisory is an UPDATE when its `modified` moved OR its status changed. The
 *    status is compared separately on purpose: a publisher that flips
 *    open → fixed without touching `modified` would otherwise stay silent about
 *    the one transition readers are waiting for.
 *  - A sink missing from an existing revision is retried only inside
 *    {@link SINK_RETRY_WINDOW_MS}. That heals a transient "Discord was down" gap
 *    without ever replaying history into a channel that was configured later —
 *    the failure mode where adding Telegram dumps three years of advisories into
 *    it at once.
 *  - Missing or corrupt state is tolerated (warn + fresh defaults) and every write
 *    is atomic (tmp + rename), like every other state file in this codebase.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJsonAsync } from "../theoxenia/state.js";
import type { Logger } from "../types.js";
import type { Advisory } from "./verify.js";
import type { RenderKind } from "./render.js";

const STATE_FILE = "bulletin-state.json";

/**
 * How long a revision stays eligible for a per-sink retry. 24 h: long enough to
 * cover an outage and a restart, short enough that a newly configured channel
 * only ever sees advisories that are actually current.
 */
export const SINK_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Upper bound on remembered advisories. MOMUS mints a few per year, so this is
 * never reached in practice — it exists so a runaway publisher cannot grow the
 * file without limit. Oldest announcements are dropped first; the cost of
 * forgetting one is at worst a single re-announcement.
 */
const MAX_REMEMBERED = 2000;

const RecordSchema = z.object({
  /** The `modified` stamp of the revision we announced ("" when the feed had none). */
  modified: z.string().catch(""),
  /** The status we announced — a flip alone counts as an update. */
  status: z.string().catch(""),
  /** When this revision was first announced (epoch ms) — drives the retry window. */
  postedAt: z.number().catch(0),
  /** sink name → platform message id ("" when the platform returned none). */
  messages: z.record(z.string()).catch({}),
});

const StateSchema = z.object({
  posted: z.record(RecordSchema).catch({}),
});

export type BulletinStateData = z.infer<typeof StateSchema>;
export type PostedRecord = z.infer<typeof RecordSchema>;

/** One advisory that needs posting, and to which sinks. */
export interface PostPlan {
  advisory: Advisory;
  /** "update" only when a revision we already announced changed. */
  kind: RenderKind;
  /** Sink names that still need this revision (never empty). */
  sinks: string[];
}

function defaults(): BulletinStateData {
  return { posted: {} };
}

/** The revision key: `modified` when the feed supplies one, else `published`. */
function revisionOf(advisory: Advisory): string {
  return advisory.modified !== "" ? advisory.modified : advisory.published;
}

export class BulletinState {
  readonly data: BulletinStateData;
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, STATE_FILE);
    this.data = this.load();
  }

  /** Missing file → defaults; unparseable file → warn + defaults (never throw). */
  private load(): BulletinStateData {
    if (!existsSync(this.file)) return defaults();
    try {
      return StateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    } catch (err) {
      // Fresh defaults mean at worst a re-announcement, which is noisy but honest.
      // Refusing to start would take the bulletin offline over a corrupt local file.
      this.log.warn("bulletin state unreadable — starting fresh (advisories may be re-announced once)", {
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      return defaults();
    }
  }

  async save(): Promise<void> {
    this.prune();
    await atomicWriteJsonAsync(this.file, this.data);
  }

  /** Everything we already announced for this advisory, or undefined. */
  recordFor(advisoryId: string): PostedRecord | undefined {
    return this.data.posted[advisoryId];
  }

  /**
   * Decide what to post. Pure with respect to the state (nothing is written) so a
   * caller can log or cap the plan before acting on it.
   *
   * Ordering is oldest-first (by published date, then id) so a run that posts
   * several advisories reads chronologically in the channel.
   */
  plan(advisories: readonly Advisory[], sinkNames: readonly string[]): PostPlan[] {
    const plans: PostPlan[] = [];
    for (const advisory of advisories) {
      const record = this.data.posted[advisory.id];
      const revision = revisionOf(advisory);

      if (record === undefined) {
        plans.push({ advisory, kind: "new", sinks: [...sinkNames] });
        continue;
      }
      if (record.modified !== revision || record.status !== advisory.status) {
        plans.push({ advisory, kind: "update", sinks: [...sinkNames] });
        continue;
      }
      // Same revision: only sinks that never got it, and only while it is current.
      // The kind is "new" for such a sink because that channel has not seen the
      // advisory at all — calling it an update would be a lie to its readers.
      const missing = sinkNames.filter((name) => record.messages[name] === undefined);
      if (missing.length > 0 && this.now() - record.postedAt <= SINK_RETRY_WINDOW_MS) {
        plans.push({ advisory, kind: "new", sinks: missing });
      }
    }
    return plans.sort(byAge);
  }

  /**
   * Remember that `sink` announced this advisory's current revision. Called after
   * each successful post, so a crash mid-run never re-announces what already went
   * out; the caller persists with {@link save}.
   */
  record(advisory: Advisory, sink: string, messageId?: string): void {
    const revision = revisionOf(advisory);
    const existing = this.data.posted[advisory.id];
    const sameRevision =
      existing !== undefined && existing.modified === revision && existing.status === advisory.status;
    this.data.posted[advisory.id] = {
      modified: revision,
      status: advisory.status,
      // A new revision restarts the retry window; a retry keeps the original stamp
      // so a failing sink cannot extend its own window indefinitely.
      postedAt: sameRevision ? existing.postedAt : this.now(),
      messages: { ...(sameRevision ? existing.messages : {}), [sink]: messageId ?? "" },
    };
  }

  /** Keep the file bounded: drop the oldest announcements past MAX_REMEMBERED. */
  private prune(): void {
    const ids = Object.keys(this.data.posted);
    if (ids.length <= MAX_REMEMBERED) return;
    const oldestFirst = ids.sort(
      (a, b) => (this.data.posted[a]?.postedAt ?? 0) - (this.data.posted[b]?.postedAt ?? 0),
    );
    for (const id of oldestFirst.slice(0, ids.length - MAX_REMEMBERED)) {
      delete this.data.posted[id];
    }
  }
}

/** Oldest advisory first, tie-broken by id so the order is deterministic. */
function byAge(a: PostPlan, b: PostPlan): number {
  const pa = a.advisory.published;
  const pb = b.advisory.published;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.advisory.id < b.advisory.id ? -1 : a.advisory.id > b.advisory.id ? 1 : 0;
}
