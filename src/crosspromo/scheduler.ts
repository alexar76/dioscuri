/**
 * CrossPromo — the twins pointing at each other's heaven, on a clock.
 *
 * CASTOR posts rotating promo lines into Telegram (they advertise POLLUX's
 * Discord); POLLUX posts into Discord (advertising CASTOR's Telegram). Each
 * side fires every `intervalHours` with ±20% jitter so the cadence never
 * looks robotic; the Pollux side starts offset by HALF an interval so the two
 * promos interleave instead of landing together. attachReleases() additionally
 * announces every new MNEMOSYNE release event on both platforms in each
 * persona's own voice.
 *
 * Constraints:
 *  - Sides without an adapter (or intervalHours <= 0) are skipped silently.
 *  - Timers, clock and randomness are injectable for deterministic tests;
 *    real timers are .unref?.()'d so they never hold the process open.
 *  - Adapter/audit failures are caught and logged — a dead channel must not
 *    kill the scheduler (it simply tries again next interval).
 *  - Persona text comes from ../personas/index.js (pure data, allowed import);
 *    everything else arrives via interfaces from ../types.js (DI).
 */

import { CASTOR, POLLUX } from "../personas/index.js";
import { auditSafe } from "../shared/index.js";
import type {
  AuditLog,
  ChannelAdapter,
  CrossLinks,
  Logger,
  Mnemosyne,
  Persona,
  ReleaseEvent,
} from "../types.js";

/** Minimal timer handle — NodeJS.Timeout satisfies it; fakes may omit unref. */
export interface TimerHandle {
  unref?: () => unknown;
}

export interface CrossPromoOpts {
  telegram?: ChannelAdapter;
  discord?: ChannelAdapter;
  links: CrossLinks;
  intervalHours: number;
  log: Logger;
  audit?: AuditLog;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  now?: () => number;
  random?: () => number;
}

type Side = "castor" | "pollux";

/** Jitter fraction: delays land in [ms * 0.8, ms * 1.2]. */
const JITTER = 0.2;

export class CrossPromo {
  private readonly setTimeoutFn: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutFn: (handle: TimerHandle) => void;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly timers: Partial<Record<Side, TimerHandle>> = {};
  private readonly promoIndex: Record<Side, number> = { castor: 0, pollux: 0 };
  private running = false;

  constructor(private readonly opts: CrossPromoOpts) {
    // Late-bound globals so vitest fake timers (which patch globalThis) work.
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.opts.intervalHours <= 0) {
      this.opts.log.info("cross-promo disabled (intervalHours <= 0)");
      return;
    }
    const intervalMs = this.opts.intervalHours * 60 * 60 * 1000;
    if (this.opts.telegram) {
      this.schedule("castor", this.jitter(intervalMs));
    } else {
      this.opts.log.debug("cross-promo: no telegram adapter — castor side skipped");
    }
    if (this.opts.discord) {
      // Half-interval offset: the two promos interleave instead of colliding.
      this.schedule("pollux", this.jitter(intervalMs) / 2);
    } else {
      this.opts.log.debug("cross-promo: no discord adapter — pollux side skipped");
    }
  }

  stop(): void {
    this.running = false;
    for (const side of ["castor", "pollux"] as const) {
      const h = this.timers[side];
      if (h !== undefined) {
        this.clearTimeoutFn(h);
        delete this.timers[side];
      }
    }
  }

  /** New KB releases → both twins announce in their own voice, errors contained. */
  attachReleases(kb: Mnemosyne): void {
    kb.onRelease((ev) => {
      void this.postRelease(ev);
    });
  }

  /** Exposed for tests: announce one release on every attached adapter. */
  async postRelease(ev: ReleaseEvent): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (this.opts.telegram) {
      jobs.push(this.safeAnnounce(this.opts.telegram, CASTOR.releaseAnnouncement(this.opts.links, ev), "release"));
    }
    if (this.opts.discord) {
      jobs.push(this.safeAnnounce(this.opts.discord, POLLUX.releaseAnnouncement(this.opts.links, ev), "release"));
    }
    await Promise.all(jobs);
    await auditSafe(this.opts.audit, {
      ts: new Date(this.now()).toISOString(),
      platform: "system",
      kind: "promo.release",
      actor: "system",
      subject: "announce",
      data: { repo: ev.repo, tag: ev.tag },
    }, this.opts.log);
  }

  // -- internals -------------------------------------------------------------

  private schedule(side: Side, delayMs: number): void {
    const handle = this.setTimeoutFn(() => {
      this.tick(side);
    }, delayMs);
    handle.unref?.();
    this.timers[side] = handle;
  }

  private tick(side: Side): void {
    if (!this.running) return;
    // Reschedule BEFORE posting so a slow adapter cannot stall the cadence.
    const intervalMs = this.opts.intervalHours * 60 * 60 * 1000;
    this.schedule(side, this.jitter(intervalMs));
    void this.postPromo(side);
  }

  /** Round-robin promo line for one side; failures logged, never thrown. */
  private async postPromo(side: Side): Promise<void> {
    const adapter = side === "castor" ? this.opts.telegram : this.opts.discord;
    if (adapter === undefined) return;
    const persona: Persona = side === "castor" ? CASTOR : POLLUX;
    const lines = persona.promoLines(this.opts.links);
    if (lines.length === 0) return;
    const index = this.promoIndex[side] % lines.length;
    this.promoIndex[side]++;
    await this.safeAnnounce(adapter, lines[index]!, "promo");
    await auditSafe(this.opts.audit, {
      ts: new Date(this.now()).toISOString(),
      platform: "system",
      kind: "promo.post",
      actor: persona.id,
      subject: "announce",
      data: { platform: adapter.platform, index },
    }, this.opts.log);
  }

  private async safeAnnounce(adapter: ChannelAdapter, text: string, what: string): Promise<void> {
    try {
      await adapter.announce(text);
    } catch (err) {
      this.opts.log.error(`cross-promo ${what} announce failed`, {
        platform: adapter.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** delayMs ±20%, injectable randomness (random() = 0.5 → exactly delayMs). */
  private jitter(ms: number): number {
    return Math.max(1, Math.round(ms * (1 + (this.random() * 2 - 1) * JITTER)));
  }
}
