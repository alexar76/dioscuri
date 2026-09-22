/**
 * Tests for the LLM failover module (src/core/failover.ts).
 *
 * Fully deterministic: scriptable stub LlmClients (success/fail sequences),
 * an injected clock for the circuit breaker, and an in-memory logger. No real
 * timers, no network, no dependence on any concrete llm.ts implementation.
 */

import { describe, expect, it } from "vitest";

import { CircuitBreaker, FailoverLlmClient } from "../src/core/failover.js";
import type { ChatOptions, LlmClient, Logger } from "../src/types.js";
import { LlmBudgetError, LlmError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Scriptable LlmClient: each entry is a reply or an error; last entry repeats. */
class StubLlm implements LlmClient {
  readonly calls: ChatOptions[] = [];
  constructor(
    private readonly script: Array<string | Error>,
    readonly provider: string = "stub",
  ) {}

  async chat(opts: ChatOptions): Promise<string> {
    this.calls.push(opts);
    const step = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (step === undefined) throw new LlmError("stub script empty");
    if (step instanceof Error) throw step;
    return step;
  }
}

function memLogger(): { log: Logger; lines: Array<{ level: string; msg: string }> } {
  const lines: Array<{ level: string; msg: string }> = [];
  const log: Logger = {
    debug: (msg) => lines.push({ level: "debug", msg }),
    info: (msg) => lines.push({ level: "info", msg }),
    warn: (msg) => lines.push({ level: "warn", msg }),
    error: (msg) => lines.push({ level: "error", msg }),
    child: () => log,
  };
  return { log, lines };
}

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const ASK: ChatOptions = { system: "sys", messages: [{ role: "user", content: "hi" }] };

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  it("starts closed and passes traffic", () => {
    const b = new CircuitBreaker();
    expect(b.state()).toBe("closed");
    expect(b.canPass()).toBe(true);
  });

  it("opens after N consecutive failures and blocks until cooldown", () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: c.now });

    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe("closed"); // 2 < 3
    b.onFailure();
    expect(b.state()).toBe("open");
    expect(b.canPass()).toBe(false);

    c.advance(999);
    expect(b.canPass()).toBe(false);
  });

  it("a success while closed resets the consecutive-failure count", () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.onFailure();
    b.onFailure();
    b.onSuccess(); // reset
    b.onFailure();
    b.onFailure();
    expect(b.state()).toBe("closed");
  });

  it("goes half-open after cooldown and admits exactly one probe", () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now });
    b.onFailure();
    expect(b.state()).toBe("open");

    c.advance(1000);
    expect(b.state()).toBe("half-open");
    expect(b.canPass()).toBe(true); // the single probe
    expect(b.canPass()).toBe(false); // everyone else waits
  });

  it("probe success closes the breaker; probe failure reopens it", () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: c.now });

    b.onFailure();
    c.advance(1000);
    expect(b.canPass()).toBe(true);
    b.onSuccess();
    expect(b.state()).toBe("closed");
    expect(b.canPass()).toBe(true);

    // Trip again, fail the probe this time.
    b.onFailure();
    c.advance(1000);
    expect(b.canPass()).toBe(true);
    b.onFailure();
    expect(b.state()).toBe("open");
    expect(b.canPass()).toBe(false);

    // Cooldown restarts from the failed probe — a new probe is allowed later.
    c.advance(1000);
    expect(b.canPass()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FailoverLlmClient
// ---------------------------------------------------------------------------

interface Rig {
  client: FailoverLlmClient;
  primary: StubLlm;
  fallback?: StubLlm;
  breaker: CircuitBreaker;
  fallbackBreaker: CircuitBreaker;
  lines: Array<{ level: string; msg: string }>;
  advance: (ms: number) => void;
}

function rig(opts: {
  primaryScript: Array<string | Error>;
  fallbackScript?: Array<string | Error>;
  threshold?: number;
  cooldownMs?: number;
}): Rig {
  const c = clock();
  const { log, lines } = memLogger();
  const primary = new StubLlm(opts.primaryScript, "deepseek");
  const fallback = opts.fallbackScript ? new StubLlm(opts.fallbackScript, "anthropic") : undefined;
  const breaker = new CircuitBreaker({
    failureThreshold: opts.threshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 60_000,
    now: c.now,
  });
  const fallbackBreaker = new CircuitBreaker({
    failureThreshold: opts.threshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 60_000,
    now: c.now,
  });
  const client = new FailoverLlmClient({ primary, fallback, log, breaker, fallbackBreaker });
  return { client, primary, fallback, breaker, fallbackBreaker, lines, advance: c.advance };
}

describe("FailoverLlmClient", () => {
  it("healthy primary serves; fallback is never called", async () => {
    const r = rig({ primaryScript: ["pong"], fallbackScript: ["never"] });
    await expect(r.client.chat(ASK)).resolves.toBe("pong");
    expect(r.primary.calls.length).toBe(1);
    expect(r.fallback!.calls.length).toBe(0);
    expect(r.lines.filter((l) => l.level === "warn").length).toBe(0);
  });

  it("single primary failure fails over; breaker stays closed (1 < threshold)", async () => {
    const r = rig({
      primaryScript: [new LlmError("boom"), "recovered"],
      fallbackScript: ["from-fallback"],
    });
    await expect(r.client.chat(ASK)).resolves.toBe("from-fallback");
    expect(r.breaker.state()).toBe("closed");
    const warns = r.lines.filter((l) => l.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0]!.msg).toContain("primary down — served by fallback anthropic");

    // Next call goes back to the (still-closed) primary.
    await expect(r.client.chat(ASK)).resolves.toBe("recovered");
    expect(r.fallback!.calls.length).toBe(1);
  });

  it("opens after 3 consecutive failures; then routes straight to fallback without touching primary", async () => {
    const r = rig({ primaryScript: [new LlmError("down")], fallbackScript: ["fb"] });

    for (let i = 0; i < 3; i++) {
      await expect(r.client.chat(ASK)).resolves.toBe("fb");
    }
    expect(r.primary.calls.length).toBe(3);
    expect(r.breaker.state()).toBe("open");
    expect(r.lines.some((l) => l.level === "info" && l.msg.includes("closed -> open"))).toBe(true);

    // Breaker open: primary must NOT be touched.
    await expect(r.client.chat(ASK)).resolves.toBe("fb");
    await expect(r.client.chat(ASK)).resolves.toBe("fb");
    expect(r.primary.calls.length).toBe(3);
    expect(r.fallback!.calls.length).toBe(5);
  });

  it("after cooldown a half-open probe hits primary; success closes the breaker", async () => {
    const r = rig({
      primaryScript: [new LlmError("down"), new LlmError("down"), new LlmError("down"), "healed"],
      fallbackScript: ["fb"],
      cooldownMs: 60_000,
    });

    for (let i = 0; i < 3; i++) await r.client.chat(ASK);
    expect(r.breaker.state()).toBe("open");

    r.advance(60_000);
    await expect(r.client.chat(ASK)).resolves.toBe("healed"); // the probe
    expect(r.primary.calls.length).toBe(4);
    expect(r.breaker.state()).toBe("closed");
    expect(r.lines.some((l) => l.level === "info" && l.msg.includes("sending probe"))).toBe(true);
    expect(
      r.lines.some((l) => l.level === "info" && l.msg.includes("half-open -> closed")),
    ).toBe(true);

    // Fully recovered: subsequent calls stay on primary.
    await expect(r.client.chat(ASK)).resolves.toBe("healed");
    expect(r.fallback!.calls.length).toBe(3);
  });

  it("failed probe reopens the breaker; fallback keeps serving", async () => {
    const r = rig({ primaryScript: [new LlmError("still down")], fallbackScript: ["fb"] });

    for (let i = 0; i < 3; i++) await r.client.chat(ASK);
    r.advance(60_000);
    await expect(r.client.chat(ASK)).resolves.toBe("fb"); // probe fails → fallback
    expect(r.primary.calls.length).toBe(4);
    expect(r.breaker.state()).toBe("open");

    await expect(r.client.chat(ASK)).resolves.toBe("fb"); // straight to fallback again
    expect(r.primary.calls.length).toBe(4);
  });

  it("LlmBudgetError is rethrown immediately: no fallback, no breaker accounting", async () => {
    const r = rig({
      primaryScript: [
        new LlmBudgetError("daily budget exhausted"),
        new LlmError("f1"),
        new LlmError("f2"),
        new LlmError("f3"),
      ],
      fallbackScript: ["fb"],
    });

    await expect(r.client.chat(ASK)).rejects.toBeInstanceOf(LlmBudgetError);
    expect(r.fallback!.calls.length).toBe(0);
    expect(r.breaker.state()).toBe("closed");

    // The budget error did NOT count: it still takes 3 real failures to open.
    await r.client.chat(ASK);
    await r.client.chat(ASK);
    expect(r.breaker.state()).toBe("closed");
    await r.client.chat(ASK);
    expect(r.breaker.state()).toBe("open");
  });

  it("LlmBudgetError from the fallback is rethrown without breaker accounting", async () => {
    const r = rig({
      primaryScript: [new LlmError("down")],
      fallbackScript: [new LlmBudgetError("budget"), "fb-ok"],
    });
    await expect(r.client.chat(ASK)).rejects.toBeInstanceOf(LlmBudgetError);
    expect(r.fallbackBreaker.state()).toBe("closed");
    await expect(r.client.chat(ASK)).resolves.toBe("fb-ok");
  });

  it("both providers down: the last error propagates", async () => {
    const fbErr = new LlmError("fallback exploded");
    const r = rig({ primaryScript: [new LlmError("primary dead")], fallbackScript: [fbErr] });
    await expect(r.client.chat(ASK)).rejects.toBe(fbErr);
  });

  it("both breakers open: rejects without touching either provider", async () => {
    const fbErr = new LlmError("fb dead");
    const r = rig({ primaryScript: [new LlmError("dead")], fallbackScript: [fbErr] });
    for (let i = 0; i < 3; i++) {
      await expect(r.client.chat(ASK)).rejects.toBe(fbErr);
    }
    expect(r.breaker.state()).toBe("open");
    expect(r.fallbackBreaker.state()).toBe("open");

    const pCalls = r.primary.calls.length;
    const fCalls = r.fallback!.calls.length;
    await expect(r.client.chat(ASK)).rejects.toBeInstanceOf(LlmError);
    expect(r.primary.calls.length).toBe(pCalls);
    expect(r.fallback!.calls.length).toBe(fCalls);
  });

  it("no fallback configured: plain breaker wrapper around primary", async () => {
    const err = new LlmError("down");
    const r = rig({ primaryScript: [err, "back"] });

    // Failures propagate directly...
    await expect(r.client.chat(ASK)).rejects.toBe(err);
    expect(r.breaker.state()).toBe("closed");

    // ...successes flow through...
    await expect(r.client.chat(ASK)).resolves.toBe("back");

    // ...and once open, the primary is not touched until cooldown.
    const dead = () => new LlmError("dead");
    const r2 = rig({ primaryScript: [dead(), dead(), dead(), "probe-ok"] });
    for (let i = 0; i < 3; i++) await expect(r2.client.chat(ASK)).rejects.toThrow("dead");
    expect(r2.breaker.state()).toBe("open");
    await expect(r2.client.chat(ASK)).rejects.toThrow(/unavailable/);
    expect(r2.primary.calls.length).toBe(3);

    r2.advance(60_000);
    await expect(r2.client.chat(ASK)).resolves.toBe("probe-ok");
    expect(r2.breaker.state()).toBe("closed");
  });

  it("uses default breakers when none are injected", async () => {
    const { log } = memLogger();
    const primary = new StubLlm(["ok"]);
    const client = new FailoverLlmClient({ primary, log });
    await expect(client.chat(ASK)).resolves.toBe("ok");
  });
});
