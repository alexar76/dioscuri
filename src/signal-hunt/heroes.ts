/** Pull-only relay for Signal Hunt's opt-in, Ed25519-signed hero feed. */

import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareUntrusted } from "../aegis/sanitize.js";
import type { AuditLog, Logger } from "../types.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const FETCH_TIMEOUT_MS = 12_000;
const STATE_FILE = "signal-hunt-heroes.json";

export interface SignalHeroEvent {
  id: string;
  schema: "aicom.signal-hunt.hero.v1";
  created_at: string;
  handle: string;
  event_type: "promotion" | "achievement";
  status: string;
  score: number;
  rounds: number;
  correct: number;
  best_streak: number;
  rewards: string[];
  url: string;
}

export interface HeroSink {
  name: "discord" | "x";
  post(event: SignalHeroEvent, text: string): Promise<void>;
}

type FeedPayload = {
  schema: "aicom.signal-hunt.heroes.v1";
  generated_at: string;
  source: string;
  events: SignalHeroEvent[];
};

type RelayState = {
  schema: 1;
  initialized: boolean;
  delivered: Record<string, Record<string, true>>;
};

function decodeUrlBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url payload");
  return Buffer.from(value, "base64url");
}

function safeString(value: unknown, max: number): string {
  return prepareUntrusted(String(value ?? ""), max)
    .replaceAll("@everyone", "everyone")
    .replaceAll("@here", "here")
    .trim();
}

export function verifyHeroFeed(
  raw: unknown,
  pinnedPublicKeyB64: string,
  nowMs = Date.now(),
  maxAgeMs = 20 * 60 * 1000,
): FeedPayload {
  if (!raw || typeof raw !== "object") throw new Error("hero feed is not an object");
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== "aicom.signal-hunt.signed-feed.v1") throw new Error("hero feed schema mismatch");
  const signed = decodeUrlBase64(String(doc.signed_payload_b64 ?? ""));
  const signatureDoc = doc.signature as Record<string, unknown> | undefined;
  if (!signatureDoc || signatureDoc.algorithm !== "ed25519") throw new Error("hero feed signature missing");
  const advertised = Buffer.from(String(signatureDoc.public_key ?? ""), "base64");
  const pinned = Buffer.from(pinnedPublicKeyB64, "base64");
  if (advertised.length !== 32 || pinned.length !== 32 || !timingSafeEqual(advertised, pinned)) {
    throw new Error("hero feed key does not match operator pin");
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pinned]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(String(signatureDoc.value ?? ""), "base64");
  if (!verify(null, signed, key, signature)) throw new Error("hero feed signature invalid");
  const payload = JSON.parse(signed.toString("utf8")) as FeedPayload;
  if (payload.schema !== "aicom.signal-hunt.heroes.v1" || !Array.isArray(payload.events)) {
    throw new Error("hero payload schema mismatch");
  }
  const generated = Date.parse(payload.generated_at);
  if (!Number.isFinite(generated) || generated > nowMs + 60_000 || nowMs - generated > maxAgeMs) {
    throw new Error("hero feed is stale or future-dated");
  }
  payload.events = payload.events
    .filter((event) => event?.schema === "aicom.signal-hunt.hero.v1")
    .map((event) => ({
      ...event,
      id: safeString(event.id, 80),
      handle: safeString(event.handle, 24),
      status: safeString(event.status, 48),
      rewards: Array.isArray(event.rewards)
        ? event.rewards.slice(0, 12).map((item) => safeString(item, 64))
        : [],
      url: safeString(event.url, 240),
    }))
    .filter((event) => event.id !== "" && event.handle !== "");
  return payload;
}

export function renderSignalHero(event: SignalHeroEvent, pageUrl: string): string {
  const primary = event.rewards[0]?.replace(/^tier:/, "STATUS ").replaceAll("_", " ") ?? "VERIFIED MILESTONE";
  return [
    `✦ **SIGNAL HUNT HERO // ${event.handle}**`,
    `Status: **${event.status.replaceAll("_", " ")}** · ${event.score} verified points`,
    `${event.correct}/${event.rounds} diagnoses · best streak ${event.best_streak}`,
    `Unlocked: **${primary}**`,
    pageUrl,
    "Proof: signed Signal Hunt feed · no self-reported scores",
  ].join("\n");
}

export class SignalHeroPublisher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastOkAt: string | null = null;
  private lastError = "";
  private readonly statePath: string;

  constructor(private readonly opts: {
    feedUrl: string;
    publicKeyB64: string;
    pageUrl: string;
    pollIntervalMin: number;
    maxPostsPerRun: number;
    sinks: HeroSink[];
    dataDir: string;
    log: Logger;
    audit?: AuditLog;
    fetchFn?: typeof fetch;
  }) {
    this.statePath = join(opts.dataDir, STATE_FILE);
  }

  start(): void {
    if (this.timer || this.opts.sinks.length === 0) return;
    void this.pollOnce();
    this.timer = setInterval(
      () => void this.pollOnce(),
      Math.max(1, this.opts.pollIntervalMin) * 60_000,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): { active: boolean; lastOkAt: string | null; lastError: string; sinks: string[] } {
    return {
      active: this.timer !== null,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      sinks: this.opts.sinks.map((sink) => sink.name),
    };
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const feed = await this.fetchFeed();
      const state = await this.loadState();
      if (!state.initialized) {
        for (const event of feed.events) {
          state.delivered[event.id] = Object.fromEntries(
            this.opts.sinks.map((sink) => [sink.name, true as const]),
          );
        }
        state.initialized = true;
        await this.saveState(state);
        this.opts.log.info("hero relay baseline recorded — historical events not posted", {
          events: feed.events.length,
        });
        this.lastOkAt = new Date().toISOString();
        this.lastError = "";
        return;
      }
      const unseen = [...feed.events].reverse().filter((event) =>
        this.opts.sinks.some((sink) => !state.delivered[event.id]?.[sink.name]),
      );
      for (const event of unseen.slice(0, Math.max(1, this.opts.maxPostsPerRun))) {
        const text = renderSignalHero(event, this.opts.pageUrl);
        for (const sink of this.opts.sinks) {
          if (state.delivered[event.id]?.[sink.name]) continue;
          try {
            await sink.post(event, text);
            state.delivered[event.id] ??= {};
            state.delivered[event.id]![sink.name] = true;
            await this.saveState(state);
            try {
              await this.opts.audit?.append({
                ts: new Date().toISOString(),
                kind: "signal-hunt.hero",
                platform: "system",
                actor: "dioscuri",
                subject: sink.name,
                data: { eventId: event.id, handle: event.handle, status: event.status },
              });
            } catch (err) {
              this.opts.log.debug("hero relay audit failed", { error: String(err) });
            }
          } catch (err) {
            this.opts.log.warn("hero relay sink failed — will retry", {
              sink: sink.name,
              eventId: event.id,
              error: String(err),
            });
          }
        }
      }
      this.lastOkAt = new Date().toISOString();
      this.lastError = "";
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.opts.log.warn("Signal Hunt hero feed unavailable", { error: this.lastError });
    } finally {
      this.running = false;
    }
  }

  private async fetchFeed(): Promise<FeedPayload> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await (this.opts.fetchFn ?? fetch)(this.opts.feedUrl, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error(`hero feed HTTP ${response.status}`);
      return verifyHeroFeed(await response.json(), this.opts.publicKeyB64);
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadState(): Promise<RelayState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as RelayState;
      return parsed?.schema === 1 && parsed.delivered
        ? parsed
        : { schema: 1, initialized: false, delivered: {} };
    } catch {
      return { schema: 1, initialized: false, delivered: {} };
    }
  }

  private async saveState(state: RelayState): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    const entries = Object.entries(state.delivered).slice(-2_000);
    const bounded: RelayState = {
      schema: 1,
      initialized: state.initialized,
      delivered: Object.fromEntries(entries),
    };
    const temporary = this.statePath + ".new";
    await writeFile(temporary, JSON.stringify(bounded), { mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}
