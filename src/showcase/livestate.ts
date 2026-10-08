/**
 * SHOWCASE — the project's live face, fed into the twins' shared memory.
 *
 * Polls the ecosystem's PUBLIC demo endpoints (config-driven, read-only) and
 * ingests compact "LIVE snapshot" chunks into MNEMOSYNE. The twins then answer
 * "what's running right now?" from facts minutes old — the channels double as
 * a living demo of the project itself.
 *
 * Security posture is identical to GitHub syncing: this is UNTRUSTED input.
 * JSON is flattened defensively (bounded depth/size, secret-looking keys
 * skipped), every snapshot passes the AEGIS gate, and rejected text is
 * dropped, never stored. The Q&A path stays tool-less: fetching happens on a
 * timer here — never in response to a user message.
 */

import type { AegisGate, KnowledgeChunk, Logger, Mnemosyne } from "../types.js";

export interface ShowcaseSource {
  name: string;
  url: string;
  kind: "json" | "text";
}

export interface LiveStateOptions {
  sources: ShowcaseSource[];
  kb: Mnemosyne;
  aegis: AegisGate;
  log: Logger;
  intervalMin: number;
  fetchFn?: typeof fetch;
  now?: () => Date;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => unknown };
  clearIntervalFn?: (handle: unknown) => void;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** Keys whose values must never enter the knowledge base. */
const SECRETISH_KEY = /(secret|token|password|passwd|api[-_]?key|private[-_]?key|mnemonic|seed|auth|cookie|bearer)/i;

const MAX_LINES = 40;
const MAX_VALUE_LEN = 120;
const MAX_DEPTH = 3;
const MAX_TEXT_LEN = 1500;

/**
 * Flatten a JSON payload into "path: value" fact lines. Bounded everywhere:
 * depth, line count, value length — a hostile or bloated payload degrades
 * into a short, harmless fact sheet instead of a prompt-stuffing vector.
 */
export function flattenJson(value: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (out.length >= MAX_LINES) return out;

  if (value === null || typeof value !== "object") {
    const rendered = String(value).slice(0, MAX_VALUE_LEN);
    out.push(prefix === "" ? rendered : `${prefix}: ${rendered}`);
    return out;
  }
  if (depth >= MAX_DEPTH) {
    out.push(`${prefix}: [nested]`);
    return out;
  }
  if (Array.isArray(value)) {
    out.push(`${prefix || "items"}: ${value.length} item(s)`);
    for (const [i, item] of value.slice(0, 5).entries()) {
      if (out.length >= MAX_LINES) break;
      flattenJson(item, `${prefix}[${i}]`, depth + 1, out);
    }
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (out.length >= MAX_LINES) break;
    if (SECRETISH_KEY.test(key)) continue;
    flattenJson(v, prefix === "" ? key : `${prefix}.${key}`, depth + 1, out);
  }
  return out;
}

export class LiveStateSync {
  private readonly opts: LiveStateOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private timer: { unref?: () => unknown } | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(opts: LiveStateOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer || this.opts.sources.length === 0) return;
    if (!this.opts.kb.ingest) {
      this.opts.log.warn("showcase disabled — knowledge base has no ingest()");
      return;
    }
    void this.syncOnce().catch((err) => {
      this.opts.log.warn("showcase initial sync failed", { err: String(err) });
    });
    const setIntervalFn = this.opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setIntervalFn(
      () => {
        void this.syncOnce().catch((err) => {
          this.opts.log.warn("showcase sync failed", { err: String(err) });
        });
      },
      Math.max(2, this.opts.intervalMin) * 60_000,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    const clearFn = this.opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clearFn(this.timer);
    this.timer = null;
  }

  /** One pass over all sources; a broken source never breaks the others. */
  syncOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runPass().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runPass(): Promise<void> {
    for (const source of this.opts.sources) {
      try {
        await this.syncSource(source);
      } catch (err) {
        this.opts.log.warn("showcase source failed — keeping previous snapshot", {
          source: source.name,
          err: String(err),
        });
      }
    }
  }

  private async syncSource(source: ShowcaseSource): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    let body: string;
    try {
      const res = await this.fetchFn(source.url, {
        signal: controller.signal,
        headers: { "User-Agent": "dioscuri-showcase/0.1", Accept: "application/json, text/plain" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.text();
    } finally {
      clearTimeout(timeout);
    }

    const stamp = this.now().toISOString();
    let facts: string;
    if (source.kind === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("payload is not valid JSON");
      }
      facts = flattenJson(parsed).join("\n");
    } else {
      facts = body.slice(0, MAX_TEXT_LEN);
    }

    const text = `LIVE snapshot of ${source.name} at ${stamp} (public demo endpoint):\n${facts}`;
    const verdict = this.opts.aegis.inspect(text, { maxLen: MAX_TEXT_LEN + 200 });
    if (verdict.action === "reject") {
      this.opts.log.warn("poisoned live snapshot dropped", {
        source: source.name,
        codes: verdict.findings.map((f) => f.code),
      });
      return;
    }

    const chunk: KnowledgeChunk = {
      id: `live:${source.name}#0`,
      repo: `live:${source.name}`,
      source: "live",
      title: `${source.name} — live status`,
      url: source.url,
      text: verdict.sanitizedText,
      updatedAt: stamp,
    };
    this.opts.kb.ingest?.(chunk.repo, [chunk]);
    this.opts.log.debug("live snapshot ingested", { source: source.name });
  }
}
