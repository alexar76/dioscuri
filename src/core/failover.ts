/**
 * LLM FAILOVER — circuit breaker + provider chain.
 *
 * The twins must keep talking even when one model provider melts down. This
 * module wraps any two LlmClients (primary + optional fallback) behind classic
 * circuit-breaker discipline:
 *
 *   CLOSED --(N consecutive failures)--> OPEN --(cooldown)--> HALF-OPEN
 *   HALF-OPEN --(probe success)--> CLOSED   /   --(probe failure)--> OPEN
 *
 * While the primary's breaker is OPEN, calls route straight to the fallback
 * without touching (and re-timing-out on) the sick provider. After the
 * cooldown a single probe is allowed through; success closes the breaker.
 *
 * POLICY: LlmBudgetError is NOT a provider failure — it is the global daily
 * cost guard. It is rethrown immediately, never counts against any breaker
 * and never triggers fallback (a second provider would just burn more money).
 *
 * CONSTRAINTS
 *  - Depends ONLY on the LlmClient/Logger interfaces from ../types.js (DI);
 *    concrete clients are wired in src/index.ts.
 *  - Injectable clock (now) — no real timers, fully deterministic in tests.
 *  - No new npm dependencies.
 */

import type { ChatOptions, LlmClient, Logger } from "../types.js";
import { LlmBudgetError, LlmError } from "../types.js";

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** Consecutive failures (while closed) that trip the breaker. Default 3. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a probe. Default 60 s. */
  cooldownMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private st: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  /** In half-open, only ONE request may probe until its outcome is reported. */
  private probeInFlight = false;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Time-driven transition: OPEN → HALF-OPEN once the cooldown has elapsed. */
  private refresh(): void {
    if (this.st === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this.st = "half-open";
      this.probeInFlight = false;
    }
  }

  /** May a request pass right now? In half-open this admits exactly one probe. */
  canPass(): boolean {
    this.refresh();
    if (this.st === "closed") return true;
    if (this.st === "open") return false;
    // half-open: admit a single probe; everyone else waits for its outcome.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.refresh();
    this.st = "closed";
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  onFailure(): void {
    this.refresh();
    if (this.st === "half-open") {
      // Probe failed — reopen and restart the cooldown clock.
      this.st = "open";
      this.openedAt = this.now();
      this.probeInFlight = false;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.st === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.st = "open";
      this.openedAt = this.now();
    }
  }

  state(): BreakerState {
    this.refresh();
    return this.st;
  }
}

// ---------------------------------------------------------------------------
// Failover client
// ---------------------------------------------------------------------------

export interface FailoverLlmClientOptions {
  primary: LlmClient;
  /** Optional second provider; without it this is a plain breaker wrapper. */
  fallback?: LlmClient;
  log: Logger;
  /** Injectable breakers for tests; sensible defaults otherwise. */
  breaker?: CircuitBreaker;
  fallbackBreaker?: CircuitBreaker;
}

/** Best-effort human label for the warn log; LlmClient has no name contract. */
function providerLabel(client: LlmClient): string {
  const c = client as Partial<Record<"provider" | "name" | "model", unknown>>;
  for (const key of ["provider", "name", "model"] as const) {
    const v = c[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "unknown";
}

export class FailoverLlmClient implements LlmClient {
  private readonly primary: LlmClient;
  private readonly fallback: LlmClient | undefined;
  private readonly log: Logger;
  private readonly breaker: CircuitBreaker;
  private readonly fallbackBreaker: CircuitBreaker;

  constructor(opts: FailoverLlmClientOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.log = opts.log;
    this.breaker = opts.breaker ?? new CircuitBreaker();
    this.fallbackBreaker = opts.fallbackBreaker ?? new CircuitBreaker();
  }

  async chat(opts: ChatOptions): Promise<string> {
    // Thrown only when no provider was even attempted (all breakers open).
    let lastError: unknown = new LlmError(
      "llm unavailable: circuit open on every configured provider",
    );

    if (this.admit(this.breaker, "primary")) {
      try {
        const text = await this.primary.chat(opts);
        this.settle(this.breaker, "primary", true);
        return text;
      } catch (err) {
        // Budget exhaustion is global policy, not a provider fault: rethrow
        // untouched — no breaker accounting, no fallback.
        if (err instanceof LlmBudgetError) throw err;
        this.settle(this.breaker, "primary", false);
        lastError = err;
      }
    }

    if (this.fallback !== undefined && this.admit(this.fallbackBreaker, "fallback")) {
      try {
        const text = await this.fallback.chat(opts);
        this.settle(this.fallbackBreaker, "fallback", true);
        this.log.warn(`primary down — served by fallback ${providerLabel(this.fallback)}`);
        return text;
      } catch (err) {
        if (err instanceof LlmBudgetError) throw err;
        this.settle(this.fallbackBreaker, "fallback", false);
        lastError = err;
      }
    }

    throw lastError;
  }

  /** canPass + info log when a half-open probe is admitted. */
  private admit(breaker: CircuitBreaker, label: string): boolean {
    const before = breaker.state(); // refresh() may promote open → half-open here
    const ok = breaker.canPass();
    if (ok && before === "half-open") {
      this.log.info(`llm breaker (${label}) half-open — sending probe`);
    }
    return ok;
  }

  /** Report an outcome to a breaker and log resulting state changes at info. */
  private settle(breaker: CircuitBreaker, label: string, ok: boolean): void {
    const before = breaker.state();
    if (ok) breaker.onSuccess();
    else breaker.onFailure();
    const after = breaker.state();
    if (before !== after) {
      this.log.info(`llm breaker (${label}) ${before} -> ${after}`);
    }
  }
}
