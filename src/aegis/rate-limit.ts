/**
 * Token-bucket rate limiter — AEGIS's flood valve.
 *
 * Per-key buckets (key = "tg:12345" / "dc:9876" / "channel:main") with lazy
 * refill: tokens accrue continuously at refillPerMinute and are computed on
 * demand from the last-touched timestamp, so there is no timer to leak.
 * Memory is bounded by pruning entries idle for over an hour on every check —
 * an hour of idleness refills any bucket to capacity anyway, so dropping the
 * entry is state-equivalent, not a loophole.
 *
 * The clock is injectable (opts.now) so tests can drive time deterministically.
 */

import type { RateDecision, RateLimiter } from "../types.js";

/** Entries untouched for this long are dropped (>= full refill for any config). */
const IDLE_PRUNE_MS = 60 * 60 * 1000;

interface Bucket {
  tokens: number;
  /** Timestamp (ms) of the last check — refill is computed lazily from here. */
  last: number;
}

export class TokenBucket implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    refillPerMinute: number,
    opts?: { now?: () => number },
  ) {
    // Fail fast: capacity < 1 can never allow, refill <= 0 never unblocks
    // (retryAfterMs would be Infinity) — both are configuration bugs.
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError(`TokenBucket capacity must be >= 1, got ${capacity}`);
    }
    if (!Number.isFinite(refillPerMinute) || refillPerMinute <= 0) {
      throw new RangeError(`TokenBucket refillPerMinute must be > 0, got ${refillPerMinute}`);
    }
    this.refillPerMs = refillPerMinute / 60_000;
    this.now = opts?.now ?? Date.now;
  }

  check(key: string): RateDecision {
    const now = this.now();
    this.prune(now);

    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    } else {
      // Lazy refill; clamp elapsed at 0 so a rewound clock cannot mint tokens.
      const elapsed = Math.max(0, now - b.last);
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerMs);
      b.last = now;
    }

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    }
    return {
      allowed: false,
      retryAfterMs: Math.ceil((1 - b.tokens) / this.refillPerMs),
      remaining: 0,
    };
  }

  /** Live bucket count — for tests and ops introspection only. */
  get size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    for (const [key, b] of this.buckets) {
      if (now - b.last > IDLE_PRUNE_MS) this.buckets.delete(key);
    }
  }
}
