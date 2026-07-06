/**
 * THEOXENIA engine — the weekly feast scheduler that keeps both channels fed.
 *
 * One timer chain: compute the next upcoming slot from cfg.slots (UTC day +
 * hour, ±30 min jitter so posts never look cron-stamped), sleep until it,
 * run the slot (all errors caught — a bad slot never kills the chain), then
 * schedule the next one. stop() clears every pending timer, including a
 * banter punchline waiting in the wings.
 *
 * Discipline enforced here, not in the generators:
 *  - quiet hours (cfg.quietHoursUtc, wraps midnight) — the scheduled path
 *    skips; runSlotNow (manual trigger) bypasses quiet hours but NEVER caps;
 *  - per-platform daily post cap (cfg.maxPostsPerDay, UTC day);
 *  - topic choice: the author queue (content-queue.json) wins, else config
 *    topics rotate per-kind, skipping anything posted in the last 14 days
 *    (when everything is recent, the least recently posted wins);
 *  - every post bumps the daily counter, records the topic hash, persists
 *    state atomically and audits "content.post" (first 80 chars only — the
 *    audit chain is a flight recorder, not a content mirror).
 *
 * All collaborators arrive via constructor injection (interfaces from
 * ../types.js); clock, randomness and timers are injectable for tests.
 */

import type { Tuning } from "../config.js";
import type {
  AuditLog,
  ChannelAdapter,
  ContentEngine,
  ContentKind,
  ContentSlot,
  CrossLinks,
  ImageProvider,
  LlmClient,
  Logger,
  Mnemosyne,
  Platform,
  ScreenshotProvider,
} from "../types.js";
import { buildMemePrompt } from "../images/memes.js";
import { banter, digest, poll, showAndTell, spotlight, type GeneratorDeps, type PollResult } from "./generator.js";
import { consumeQueue, topicHash, TheoxeniaState } from "./state.js";

/** Non-secret content tuning block from dioscuri.config.json. */
export type ContentTuning = Tuning["content"];

/** Setup lands, the room leans in, the punchline crosses the bridge 15 min later. */
const PUNCHLINE_DELAY_MS = 15 * 60 * 1000;
/** Scheduling jitter: ±30 min around the slot hour. */
const SLOT_JITTER_MS = 30 * 60 * 1000;
/** Never schedule closer than this (jitter could otherwise land in the past). */
const MIN_DELAY_MS = 1000;

const DAY_INDEX: Record<ContentSlot["day"], number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

type TimeoutFn = (fn: () => void, ms: number) => unknown;
type ClearFn = (handle: unknown) => void;

export interface TheoxeniaOpts {
  telegram?: ChannelAdapter;
  discord?: ChannelAdapter;
  kb: Mnemosyne;
  llm: LlmClient;
  links: CrossLinks;
  cfg: ContentTuning;
  dataDir: string;
  log: Logger;
  audit?: AuditLog;
  /**
   * Optional AI meme generator for banter slots. Prompts come ONLY from
   * buildMemePrompt (config topics + baked templates) — never user text.
   * Budgeted by cfg.images.aiMemesPerWeek; any failure falls back to text.
   */
  memeProvider?: ImageProvider;
  /** Optional demo-page screenshots for spotlight (README-sourced URLs). */
  screenshotProvider?: ScreenshotProvider;
  now?: () => number;
  random?: () => number;
  setTimeoutFn?: TimeoutFn;
  clearTimeoutFn?: ClearFn;
}

/** Next epoch-ms occurrence of a weekly slot strictly after nowMs. */
function nextOccurrence(slot: ContentSlot, nowMs: number): number {
  const now = new Date(nowMs);
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), slot.hourUtc, 0, 0, 0),
  );
  const dayDiff = (DAY_INDEX[slot.day] - now.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + dayDiff);
  if (target.getTime() <= nowMs) target.setUTCDate(target.getUTCDate() + 7);
  return target.getTime();
}

export class Theoxenia implements ContentEngine {
  private readonly state: TheoxeniaState;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutFn: TimeoutFn;
  private readonly clearTimeoutFn: ClearFn;
  private mainTimer: unknown = null;
  private readonly pendingTimers = new Set<unknown>();
  private started = false;

  constructor(private readonly opts: TheoxeniaOpts) {
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.state = new TheoxeniaState(opts.dataDir, this.log, this.now);
  }

  // -------------------------------------------------------------------------
  // ContentEngine lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (!this.opts.cfg.enabled) {
      this.log.info("theoxenia disabled by config — content engine idle");
      return;
    }
    if (this.started) return;
    this.started = true;
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.mainTimer !== null) {
      this.clearTimeoutFn(this.mainTimer);
      this.mainTimer = null;
    }
    for (const t of this.pendingTimers) this.clearTimeoutFn(t);
    this.pendingTimers.clear();
  }

  /** Scheduled path: respects quiet hours AND daily caps. Errors are caught. */
  async runSlot(kind: ContentKind): Promise<void> {
    await this.execute(kind, false);
  }

  /** Manual trigger: bypasses quiet hours, still respects daily caps. */
  async runSlotNow(kind: ContentKind): Promise<void> {
    await this.execute(kind, true);
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private scheduleNext(): void {
    if (!this.started) return;
    const slots = this.opts.cfg.slots;
    if (slots.length === 0) {
      this.log.warn("theoxenia has no slots configured — nothing to schedule");
      return;
    }
    const nowMs = this.now();
    let best: { at: number; kind: ContentKind } | null = null;
    for (const slot of slots) {
      const at = nextOccurrence(slot, nowMs);
      if (best === null || at < best.at) best = { at, kind: slot.kind };
    }
    if (best === null) return;
    const jitter = (this.random() * 2 - 1) * SLOT_JITTER_MS;
    const delay = Math.max(MIN_DELAY_MS, best.at - nowMs + jitter);
    const kind = best.kind;
    this.log.info("theoxenia slot scheduled", { kind, inMs: Math.round(delay) });
    this.mainTimer = this.setTimeoutFn(() => {
      this.mainTimer = null;
      void this.runSlot(kind).finally(() => this.scheduleNext());
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Slot execution
  // -------------------------------------------------------------------------

  private async execute(kind: ContentKind, bypassQuiet: boolean): Promise<void> {
    try {
      if (!bypassQuiet && this.inQuietHours()) {
        this.log.info("theoxenia slot skipped — quiet hours", { kind });
        return;
      }
      switch (kind) {
        case "spotlight":
          await this.runSpotlight();
          break;
        case "banter":
          await this.runBanter();
          break;
        case "poll":
          await this.runPoll();
          break;
        case "digest":
          await this.runDigest();
          break;
        case "show-and-tell":
          await this.runShowAndTell();
          break;
      }
    } catch (err) {
      // A failed slot (LLM down, JSON garbage, adapter hiccup) is skipped, never fatal.
      this.log.error("theoxenia slot failed — skipped", {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** cfg.quietHoursUtc is [start, end) in UTC hours and may wrap midnight. */
  private inQuietHours(): boolean {
    const [start, end] = this.opts.cfg.quietHoursUtc;
    if (start === end) return false; // zero-length window = no quiet hours
    const h = new Date(this.now()).getUTCHours();
    return start < end ? h >= start && h < end : h >= start || h < end;
  }

  private adapterFor(platform: Platform): ChannelAdapter | undefined {
    return platform === "telegram" ? this.opts.telegram : this.opts.discord;
  }

  /** Adapter for a platform if it exists AND is under today's post cap. */
  private available(platform: Platform): ChannelAdapter | undefined {
    const adapter = this.adapterFor(platform);
    if (!adapter) return undefined;
    if (this.state.countToday(platform) >= this.opts.cfg.maxPostsPerDay) {
      this.log.info("theoxenia daily cap reached", { platform, cap: this.opts.cfg.maxPostsPerDay });
      return undefined;
    }
    return adapter;
  }

  private genDeps(): GeneratorDeps {
    return { kb: this.opts.kb, llm: this.opts.llm, links: this.opts.links };
  }

  /**
   * Topic selection: author queue first; else rotate cfg.topics for this kind,
   * skipping topics posted within the 14-day dedup window; when every topic is
   * recent, reuse the least recently posted one.
   */
  private async pickTopic(kind: ContentKind): Promise<string | null> {
    const queued = consumeQueue(this.opts.dataDir, kind, this.log);
    if (queued) {
      this.log.info("theoxenia topic from author queue", { kind });
      return queued.topic;
    }
    const topics = this.opts.cfg.topics;
    if (topics.length === 0) return null;
    const rot = this.state.getRotation(kind);
    let chosen = -1;
    for (let i = 0; i < topics.length; i++) {
      const idx = (rot + i) % topics.length;
      if (!this.state.hasRecentHash(topicHash(kind, topics[idx]!))) {
        chosen = idx;
        break;
      }
    }
    if (chosen === -1) {
      let oldest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < topics.length; i++) {
        const ts = this.state.hashTs(topicHash(kind, topics[i]!)) ?? 0;
        if (ts < oldest) {
          oldest = ts;
          chosen = i;
        }
      }
    }
    this.state.setRotation(kind, (chosen + 1) % topics.length);
    await this.state.save();
    return topics[chosen]!;
  }

  /** Post-flight bookkeeping shared by every kind: counter, persist, audit. */
  private async recordPost(platform: Platform, kind: ContentKind, text: string): Promise<void> {
    this.state.bumpToday(platform);
    await this.state.save();
    if (!this.opts.audit) return;
    try {
      await this.opts.audit.append({
        ts: new Date(this.now()).toISOString(),
        platform,
        kind: "content.post",
        actor: "theoxenia",
        subject: kind,
        data: { preview: text.slice(0, 80) },
      });
    } catch (err) {
      this.log.warn("audit append failed", {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Kind runners
  // -------------------------------------------------------------------------

  /** Spotlight alternates platforms run-to-run (toggle persisted in state). */
  private async runSpotlight(): Promise<void> {
    const preferTelegram = this.state.data.spotlightPlatform;
    const order: Platform[] = preferTelegram ? ["telegram", "discord"] : ["discord", "telegram"];
    let target: { platform: Platform; adapter: ChannelAdapter } | null = null;
    for (const p of order) {
      const a = this.available(p);
      if (a) {
        target = { platform: p, adapter: a };
        break;
      }
    }
    if (!target) return;
    const topic = await this.pickTopic("spotlight");
    if (topic === null) return;

    const ctaIdx = this.state.getRotation("spotlight-cta");
    this.state.setRotation("spotlight-cta", ctaIdx + 1);
    const text = await spotlight(this.genDeps(), topic, target.platform, ctaIdx);

    let delivered = false;
    const shots = this.opts.screenshotProvider;
    const demoMatch = this.opts.kb.resolveDemoUrl?.(topic) ?? null;
    if (
      shots &&
      this.opts.cfg.images.screenshots.enabled &&
      demoMatch &&
      target.adapter.announceImage
    ) {
      try {
        const image = await shots.capture(demoMatch.url);
        await target.adapter.announceImage(image, text);
        delivered = true;
        this.log.info("spotlight demo screenshot attached", {
          repo: demoMatch.repo,
          url: demoMatch.url,
          platform: target.platform,
        });
      } catch (err) {
        this.log.warn("demo screenshot failed — posting text-only", {
          repo: demoMatch.repo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!delivered) await target.adapter.announce(text);
    // Next spotlight prefers the platform we did NOT use this time.
    this.state.data.spotlightPlatform = target.platform !== "telegram";
    this.state.recordHash(topicHash("spotlight", topic));
    await this.recordPost(target.platform, "spotlight", text);
  }

  /**
   * Banter: setup lands on platform A now, the punchline on platform B fires
   * 15 minutes later (injectable timer). Direction alternates per run. If the
   * punchline adapter is missing the whole slot is skipped — a setup without
   * its landing would strand the joke (and the traffic).
   */
  private async runBanter(): Promise<void> {
    const direction = this.state.data.banterDirection;
    const platformA: Platform = direction ? "telegram" : "discord";
    const platformB: Platform = direction ? "discord" : "telegram";
    const adapterA = this.available(platformA);
    const adapterB = this.adapterFor(platformB);
    if (!adapterA || !adapterB) {
      this.log.info("theoxenia banter skipped — missing/capped adapter", { platformA, platformB });
      return;
    }
    const topic = await this.pickTopic("banter");
    if (topic === null) return;

    const joke = await banter(this.genDeps(), topic, direction); // throws → slot skipped

    // AI meme (optional, budgeted): attach to the setup post — the visual hook
    // carries the "punchline lives with my brother" bridge. Any failure here
    // must cost nothing: the joke posts as text and the budget is untouched.
    let setupDelivered = false;
    const memes = this.opts.memeProvider;
    const memeBudget = this.opts.cfg.images.aiMemesPerWeek;
    if (memes && memeBudget > 0 && this.state.memesThisWeek() < memeBudget && adapterA.announceImage) {
      try {
        const seed = this.state.getRotation("meme-style");
        this.state.setRotation("meme-style", seed + 1);
        const image = await memes.generate(buildMemePrompt(topic, seed));
        await adapterA.announceImage(image, joke.setup);
        this.state.bumpMemes();
        setupDelivered = true;
        this.log.info("banter meme attached", {
          provider: memes.name,
          platform: platformA,
          memesThisWeek: this.state.memesThisWeek(),
        });
      } catch (err) {
        this.log.warn("meme generation failed — posting text-only", {
          provider: memes.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!setupDelivered) await adapterA.announce(joke.setup);
    this.state.data.banterDirection = !direction;
    this.state.recordHash(topicHash("banter", topic));
    await this.recordPost(platformA, "banter", joke.setup);

    const timer = this.setTimeoutFn(() => {
      this.pendingTimers.delete(timer);
      void this.deliverPunchline(adapterB, platformB, joke.punchline);
    }, PUNCHLINE_DELAY_MS);
    this.pendingTimers.add(timer);
  }

  private async deliverPunchline(adapter: ChannelAdapter, platform: Platform, text: string): Promise<void> {
    try {
      await adapter.announce(text);
      await this.recordPost(platform, "banter", text);
    } catch (err) {
      this.log.error("banter punchline failed", {
        platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Poll goes to BOTH platforms; native poll API when the adapter has one. */
  private async runPoll(): Promise<void> {
    const targets = (["telegram", "discord"] as const)
      .map((p) => ({ platform: p, adapter: this.available(p) }))
      .filter((t): t is { platform: Platform; adapter: ChannelAdapter } => t.adapter !== undefined);
    if (targets.length === 0) return;
    const topic = await this.pickTopic("poll");
    if (topic === null) return;

    const p = await poll(this.genDeps(), topic); // throws → slot skipped

    for (const t of targets) {
      if (t.adapter.announcePoll) {
        await t.adapter.announcePoll(p.question, p.options);
      } else {
        await t.adapter.announce(pollFallbackText(p));
      }
      await this.recordPost(t.platform, "poll", p.question);
    }
    this.state.recordHash(topicHash("poll", topic));
    await this.state.save();
  }

  /** Digest is deterministic; a quiet week (null) skips the slot entirely. */
  private async runDigest(): Promise<void> {
    const text = digest(this.opts.kb, this.opts.links, this.now);
    if (text === null) {
      this.log.info("theoxenia digest skipped — no releases in the last 7 days");
      return;
    }
    for (const platform of ["telegram", "discord"] as const) {
      const adapter = this.available(platform);
      if (!adapter) continue;
      await adapter.announce(text);
      await this.recordPost(platform, "digest", text);
    }
  }

  /** Discord gets the main nudge; Telegram a companion pointer at Discord. */
  private async runShowAndTell(): Promise<void> {
    const dc = this.available("discord");
    const tg = this.available("telegram");
    if (!dc && !tg) return;
    const idx = this.state.getRotation("show-and-tell");
    this.state.setRotation("show-and-tell", idx + 1);
    const { discord: nudge, telegram: companion } = showAndTell(idx, this.opts.links);
    if (dc) {
      await dc.announce(nudge);
      await this.recordPost("discord", "show-and-tell", nudge);
    }
    if (tg) {
      await tg.announce(companion);
      await this.recordPost("telegram", "show-and-tell", companion);
    }
    await this.state.save();
  }
}

/** Text fallback when an adapter has no native poll API. */
function pollFallbackText(p: PollResult): string {
  const lettered = p.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("\n");
  return `🗳 ${p.question}\n\n${lettered}`;
}
