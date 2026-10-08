/**
 * BULLETIN — the twins carrying MOMUS's security bulletin to the community.
 *
 * MOMUS (the adversarial-audit satellite) publishes advisories; DIOSCURI reads the
 * signed index on a timer, verifies it against a PINNED key, diffs it against what
 * it already announced, and posts the new ones. That is the whole feature.
 *
 * ── DECIDED, AND NOT UP FOR RE-LITIGATION ──────────────────────────────────────
 *
 * **The bulletin channel is PUBLIC.** A security bulletin's value is that affected
 * people read it. Gating advisories behind any kind of loyalty test means somebody
 * running our code does not learn their component has an open hole. MOMUS's
 * disclosure design already makes `open` advisories non-actionable — no reproducer,
 * no evidence, no target — precisely so they CAN be public.
 *
 * **Exclusivity is TIMING and COMMENTARY, never information.** Insiders get the
 * write-up, the deep dive and the Q&A first (`writeupBaseUrl`, off by default). The
 * advisory itself is public the moment it is published.
 *
 * **No stars are read. Anywhere.** There is no GitHub star API call in this
 * feature, not for access, not for a badge, not once. Nothing here notices,
 * records or rewards whether anyone endorsed the project.
 *
 * **This module stores nothing about a person** — see ./state.ts. It remembers
 * advisory ids and message ids, and that is all it is allowed to remember.
 *
 * ── FAILURE PHILOSOPHY (this class NEVER throws) ────────────────────────────────
 *
 * Modelled on src/provision/discord.ts, for the same reason: a publisher that
 * crashes the bot because a feed was down is worse than one that skips a cycle.
 *
 *  - {@link BulletinPublisher.runOnce} catches everything and returns a result
 *    object. The scheduled path can therefore never take the process down.
 *  - Verification failure (unverified, unparseable, oversized, stale) posts
 *    NOTHING and logs why. Fail-closed, exactly like WARDEN's threat feed: an
 *    advisory posted under our own bot without a valid signature would let whoever
 *    controls the network path publish accusations in our name.
 *  - An advisory whose own text imitates our bulletin header is REFUSED by the
 *    renderer (./render.ts) and dropped with a warning: a post carrying a second,
 *    attacker-written header is a phishing post wearing this bot's identity.
 *  - A sink that throws is logged and skipped; the other sink still posts, and the
 *    failed one is retried on the next cycle (bounded — see ./state.ts).
 *  - State is saved after EVERY successful post, so a crash mid-run cannot cause a
 *    re-announcement of what already went out.
 *  - `maxPostsPerRun` bounds a single cycle, so a cold start (or a publisher that
 *    suddenly serves 200 advisories) drips instead of flooding the channel.
 *
 * Nothing in here is wired up unless an operator sets a pinned key AND a channel:
 * see `tuning.bulletin` in src/config.ts, off by default.
 */

import { auditSafe } from "../shared/index.js";
import type { AuditLog, Logger } from "../types.js";
import { headerImpersonation, renderAdvisory, type RenderedAdvisory } from "./render.js";
import { BulletinState } from "./state.js";
import { DEFAULT_BULLETIN_MAX_AGE_MS, fetchBulletinIndex, originOf } from "./verify.js";

export {
  DEFAULT_BULLETIN_MAX_AGE_MS,
  BULLETIN_CLOCK_SKEW_MS,
  fetchBulletinIndex,
  verifyBulletinPayload,
  isAllowedAdvisoryUrl,
  type Advisory,
  type AdvisorySeverity,
  type AdvisoryStatus,
  type BulletinRefusalCode,
  type VerifyResult,
} from "./verify.js";
export {
  renderAdvisory,
  defangLinks,
  defangMentions,
  headerImpersonation,
  neutralise,
  writeupLink,
  BULLETIN_HEADER_MARKER,
  STATUS_BADGE,
  type BulletinEmbed,
  type BulletinEmbedField,
  type RenderedAdvisory,
  type RenderKind,
} from "./render.js";
export { BulletinState, SINK_RETRY_WINDOW_MS, type PostPlan, type PostedRecord } from "./state.js";
export { canonicalize, parseJsonStrict, CanonicalizationError } from "./jcs.js";

/** Minimal timer handle — NodeJS.Timeout satisfies it; fakes may omit unref. */
export interface TimerHandle {
  unref?: () => unknown;
}

/**
 * One place an advisory gets posted (the public Discord bulletin channel, the
 * public Telegram channel).
 *
 * `name` is the state-file key for per-sink idempotence, so it must be stable
 * across restarts — "discord" / "telegram", not something derived from a channel
 * id that an operator may change.
 *
 * Implementations own the platform API and may return the created message id;
 * returning undefined is fine (the advisory is still recorded as announced).
 */
export interface BulletinSink {
  readonly name: string;
  post(rendered: RenderedAdvisory): Promise<string | undefined>;
}

export interface BulletinPublisherOpts {
  /** MOMUS's signed bulletin index. */
  indexUrl: string;
  /** PINNED Ed25519 publisher key, hex SPKI DER. Empty = feature refuses to run. */
  publicKeyHex: string;
  /** Freshness window for the signed snapshot (default 24 h). */
  maxAgeMs?: number;
  /** Minutes between polls (default 30). */
  pollIntervalMin?: number;
  /** Ceiling on advisories posted in one cycle (default 5). */
  maxPostsPerRun?: number;
  /** Insiders' write-up base URL, from config. Empty = no write-up line. */
  writeupBaseUrl?: string;
  sinks: BulletinSink[];
  dataDir: string;
  log: Logger;
  audit?: AuditLog;
  fetchFn?: typeof fetch;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
}

export interface BulletinRunResult {
  /** New advisories announced (counted once, not per sink). */
  posted: number;
  /** Updates announced. */
  updated: number;
  /** Advisories held back by `maxPostsPerRun` — next cycle picks them up. */
  deferred: number;
  /** Per-sink post failures in this cycle. */
  failures: number;
  /** Refusal code when the cycle posted nothing on purpose. */
  refused?: string;
}

const DEFAULT_POLL_INTERVAL_MIN = 30;
const MIN_POLL_INTERVAL_MIN = 5;
const DEFAULT_MAX_POSTS_PER_RUN = 5;

export class BulletinPublisher {
  private readonly state: BulletinState;
  private readonly now: () => number;
  private timer: TimerHandle | null = null;
  private running = false;

  constructor(private readonly opts: BulletinPublisherOpts) {
    this.now = opts.now ?? (() => Date.now());
    this.state = new BulletinState(opts.dataDir, opts.log.child("state"), this.now);
  }

  /**
   * Start polling. One immediate pass, then every `pollIntervalMin`. The timer is
   * unref'd so it never holds the process open, and every pass is caught — the
   * scheduled path cannot throw.
   */
  start(): void {
    if (this.timer !== null) return;
    if (this.opts.sinks.length === 0) {
      this.opts.log.warn("bulletin publisher not started — no channel configured");
      return;
    }
    if (this.opts.publicKeyHex.trim() === "") {
      // Loud, once, at startup: a missing pin is a configuration mistake that
      // otherwise looks exactly like "MOMUS has published nothing yet".
      this.opts.log.warn(
        "bulletin publisher not started — no pinned publisher key; an unverified advisory is never posted",
      );
      return;
    }
    void this.runOnce();
    const intervalMin = Math.max(MIN_POLL_INTERVAL_MIN, this.opts.pollIntervalMin ?? DEFAULT_POLL_INTERVAL_MIN);
    const setIntervalFn = this.opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setIntervalFn(() => {
      void this.runOnce();
    }, intervalMin * 60_000);
    this.timer.unref?.();
    this.opts.log.info("bulletin publisher started", {
      indexUrl: this.opts.indexUrl,
      intervalMin,
      sinks: this.opts.sinks.map((s) => s.name),
    });
  }

  stop(): void {
    if (this.timer === null) return;
    const clearFn = this.opts.clearIntervalFn ?? ((h) => clearInterval(h as unknown as NodeJS.Timeout));
    clearFn(this.timer);
    this.timer = null;
  }

  /**
   * One full cycle: fetch → verify → diff → render → post. Resolves with a
   * result and NEVER rejects.
   */
  async runOnce(): Promise<BulletinRunResult> {
    const empty: BulletinRunResult = { posted: 0, updated: 0, deferred: 0, failures: 0 };
    // Overlapping cycles would double-post: the state is only written after a
    // successful post, so two concurrent runs would both see the same gap.
    if (this.running) return { ...empty, refused: "ALREADY_RUNNING" };
    this.running = true;
    try {
      return await this.cycle(empty);
    } catch (err) {
      // Belt and braces: the body below is already defensive, but this method is
      // called from a timer, and an unhandled rejection there kills the process.
      this.opts.log.error("bulletin cycle failed unexpectedly — nothing posted", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ...empty, refused: "INTERNAL_ERROR" };
    } finally {
      this.running = false;
    }
  }

  private async cycle(empty: BulletinRunResult): Promise<BulletinRunResult> {
    const log = this.opts.log;
    if (this.opts.sinks.length === 0) {
      log.debug("bulletin cycle skipped — no channel configured");
      return { ...empty, refused: "NO_SINKS" };
    }

    const verified = await fetchBulletinIndex(this.opts.indexUrl, {
      publicKeyHex: this.opts.publicKeyHex,
      maxAgeMs: this.opts.maxAgeMs ?? DEFAULT_BULLETIN_MAX_AGE_MS,
      allowedUrlOrigin: originOf(this.opts.indexUrl),
      now: this.now,
      fetchFn: this.opts.fetchFn,
      log,
    });
    if (!verified.ok) {
      // FAIL CLOSED. One warn line naming the code and the reason; nothing posted.
      log.warn("bulletin index REFUSED — nothing posted", {
        code: verified.code,
        reason: verified.detail,
      });
      await auditSafe(
        this.opts.audit,
        {
          ts: new Date(this.now()).toISOString(),
          platform: "system",
          kind: "bulletin.refused",
          actor: "dioscuri",
          subject: this.opts.indexUrl,
          data: { code: verified.code, reason: verified.detail },
        },
        log,
      );
      return { ...empty, refused: verified.code };
    }

    const { advisories, dropped, droppedLinks } = verified.bulletin;
    if (dropped > 0) {
      log.warn("bulletin: advisories dropped for failing shape validation", { dropped });
    }
    if (droppedLinks > 0) {
      // Worth a warning rather than a debug line: it means a SIGNED index pointed
      // the community off MOMUS's own origin.
      log.warn("bulletin: advisory links dropped for pointing off the index origin", { droppedLinks });
    }

    const sinkNames = this.opts.sinks.map((s) => s.name);
    const plans = this.state.plan(advisories, sinkNames);
    if (plans.length === 0) {
      log.debug("bulletin: nothing new", { advisories: advisories.length });
      return empty;
    }

    const maxPerRun = Math.max(1, this.opts.maxPostsPerRun ?? DEFAULT_MAX_POSTS_PER_RUN);
    const batch = plans.slice(0, maxPerRun);
    const deferred = plans.length - batch.length;
    if (deferred > 0) {
      log.info("bulletin: batch capped — remaining advisories wait for the next cycle", {
        posting: batch.length,
        deferred,
      });
    }

    let posted = 0;
    let updated = 0;
    let failures = 0;
    for (const plan of batch) {
      const rendered = renderAdvisory(plan.advisory, plan.kind, {
        writeupBaseUrl: this.opts.writeupBaseUrl,
      });
      if (rendered === null) {
        // The renderer refuses text that imitates our own bulletin header. A post
        // carrying a second header is a phishing post wearing this bot's identity,
        // and no amount of quoting makes it safe to publish — so it is dropped,
        // loudly. Not recorded as announced either: if MOMUS fixes the advisory's
        // text, the next cycle posts it normally.
        const reason = headerImpersonation(plan.advisory) ?? "renderer refused the advisory";
        log.warn("bulletin advisory REFUSED — nothing posted", {
          advisory: plan.advisory.id,
          reason,
        });
        await auditSafe(
          this.opts.audit,
          {
            ts: new Date(this.now()).toISOString(),
            platform: "system",
            kind: "bulletin.refused",
            actor: "dioscuri",
            subject: plan.advisory.id,
            data: { code: "HEADER_IMPERSONATION", reason },
          },
          log,
        );
        continue;
      }
      let anyDelivered = false;
      for (const sink of this.opts.sinks) {
        if (!plan.sinks.includes(sink.name)) continue;
        try {
          const messageId = await sink.post(rendered);
          this.state.record(plan.advisory, sink.name, messageId);
          anyDelivered = true;
          log.info("bulletin advisory posted", {
            advisory: plan.advisory.id,
            status: plan.advisory.status,
            kind: plan.kind,
            sink: sink.name,
          });
        } catch (err) {
          // Not recorded → retried next cycle (inside the retry window).
          failures++;
          log.warn("bulletin sink failed — advisory will be retried", {
            advisory: plan.advisory.id,
            sink: sink.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!anyDelivered) continue;
      if (plan.kind === "update") updated++;
      else posted++;
      // Persist per advisory, not per run: a crash between two advisories must not
      // re-announce the one that already went out.
      try {
        await this.state.save();
      } catch (err) {
        log.error("bulletin state save failed — an advisory may be re-announced once", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await auditSafe(
        this.opts.audit,
        {
          ts: new Date(this.now()).toISOString(),
          platform: "system",
          kind: `bulletin.${plan.kind === "update" ? "update" : "post"}`,
          actor: "dioscuri",
          subject: plan.advisory.id,
          data: {
            status: plan.advisory.status,
            severity: plan.advisory.severity,
            component: plan.advisory.component,
            sinks: plan.sinks,
          },
        },
        log,
      );
    }

    return { posted, updated, deferred, failures };
  }
}
