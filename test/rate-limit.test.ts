/**
 * TokenBucket tests — deterministic time via an injected fake clock.
 *
 * Covers: capacity is spent then blocked; refill after elapsed time; the
 * retryAfterMs estimate actually unblocks; per-key isolation; idle pruning
 * bounds memory; and the constructor rejects impossible configs.
 */

import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/aegis/rate-limit.js";

/** Controllable clock: t is in ms, advanced explicitly by the test. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TokenBucket", () => {
  it("allows up to capacity, then blocks with a retryAfterMs", () => {
    const clk = fakeClock();
    const b = new TokenBucket(4, 4, { now: clk.now }); // 4 tokens, +4/min

    for (let i = 0; i < 4; i++) {
      const d = b.check("tg:1");
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(3 - i);
    }
    const blocked = b.check("tg:1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // 4 tokens/min ⇒ 1 token per 15_000 ms.
    expect(blocked.retryAfterMs).toBe(15_000);
  });

  it("refills lazily after time passes, capped at capacity", () => {
    const clk = fakeClock();
    const b = new TokenBucket(4, 4, { now: clk.now });

    for (let i = 0; i < 4; i++) b.check("k"); // drain
    expect(b.check("k").allowed).toBe(false);

    clk.advance(15_000); // exactly one token back
    const d = b.check("k");
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(0);

    clk.advance(10 * 60_000); // long idle → refills but clamps at capacity
    const d2 = b.check("k");
    expect(d2.allowed).toBe(true);
    expect(d2.remaining).toBe(3); // capacity(4) - 1 consumed
  });

  it("honours its own retryAfterMs: waiting exactly that long unblocks", () => {
    const clk = fakeClock();
    const b = new TokenBucket(2, 6, { now: clk.now }); // +6/min = 1 per 10s
    b.check("k");
    b.check("k");
    const blocked = b.check("k");
    expect(blocked.allowed).toBe(false);
    clk.advance(blocked.retryAfterMs ?? 0);
    expect(b.check("k").allowed).toBe(true);
  });

  it("isolates buckets per key", () => {
    const clk = fakeClock();
    const b = new TokenBucket(1, 60, { now: clk.now });
    expect(b.check("a").allowed).toBe(true);
    expect(b.check("a").allowed).toBe(false); // a is drained
    expect(b.check("b").allowed).toBe(true); // b is fresh
  });

  it("does not mint tokens if the clock rewinds", () => {
    const clk = fakeClock(1_000_000);
    const b = new TokenBucket(2, 60, { now: clk.now });
    b.check("k");
    b.check("k");
    clk.advance(-500_000); // clock goes backwards
    expect(b.check("k").allowed).toBe(false);
  });

  it("prunes buckets idle longer than an hour to bound memory", () => {
    const clk = fakeClock();
    const b = new TokenBucket(2, 60, { now: clk.now });
    b.check("stale");
    expect(b.size).toBe(1);

    clk.advance(60 * 60 * 1000 + 1); // just over the idle window
    b.check("fresh"); // this check triggers the prune sweep
    expect(b.size).toBe(1); // "stale" gone, only "fresh" remains
  });

  it("rejects impossible configurations", () => {
    expect(() => new TokenBucket(0, 10)).toThrow(RangeError);
    expect(() => new TokenBucket(5, 0)).toThrow(RangeError);
    expect(() => new TokenBucket(5, -1)).toThrow(RangeError);
  });
});
