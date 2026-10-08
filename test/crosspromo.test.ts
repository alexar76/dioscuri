/**
 * Tests for src/crosspromo/scheduler.ts — vitest fake timers + injected
 * randomness (random() = 0.5 → zero jitter): Castor promo lands on the
 * Telegram adapter carrying the Discord invite, Pollux promo lands on
 * Discord carrying the Telegram link (offset by half an interval), promo
 * lines rotate round-robin, release events announce on both adapters with
 * per-adapter error containment, and stop() cancels all pending timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrossPromo } from "../src/crosspromo/scheduler.js";
import type {
  ChannelAdapter,
  CrossLinks,
  Logger,
  Mnemosyne,
  Platform,
  ReleaseEvent,
} from "../src/types.js";

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

const LINKS: CrossLinks = {
  discordInvite: "https://discord.gg/aicom",
  telegramChannel: "https://t.me/aicom",
  telegramBot: "",
  siteUrl: "https://magic-ai-factory.com",
  githubOrg: "https://github.com/alexar76",
  theorosUrl: "https://alexar76.github.io/theoros/",
};

const HOUR = 60 * 60 * 1000;

interface StubAdapter extends ChannelAdapter {
  announced: string[];
}

function adapterStub(platform: Platform, failFirst = false): StubAdapter {
  let failed = false;
  const stub: StubAdapter = {
    platform,
    announced: [],
    start: async () => {},
    stop: async () => {},
    isReady: () => true,
    announce: async (text: string) => {
      if (failFirst && !failed) {
        failed = true;
        throw new Error("channel down");
      }
      stub.announced.push(text);
    },
  };
  return stub;
}

function kbStub(): { kb: Mnemosyne; fire: (ev: ReleaseEvent) => void } {
  const callbacks: Array<(ev: ReleaseEvent) => void> = [];
  const kb: Mnemosyne = {
    search: () => [],
    stats: () => ({ chunks: 0, repos: 0, lastSyncAt: null, lastSyncOk: true }),
    onRelease: (cb) => callbacks.push(cb),
    syncOnce: async () => {},
    start: () => {},
    stop: () => {},
  };
  return { kb, fire: (ev) => callbacks.forEach((cb) => cb(ev)) };
}

const RELEASE: ReleaseEvent = {
  repo: "argus",
  tag: "v1.2.0",
  name: "Warden Awakens",
  url: "https://github.com/alexar76/argus/releases/v1.2.0",
  summary: "WARDEN firewall now scores MCP calls.",
  publishedAt: "2026-07-01T00:00:00Z",
};

describe("CrossPromo — scheduled promos (fake timers, zero jitter)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function build(over: { telegram?: StubAdapter; discord?: StubAdapter; intervalHours?: number } = {}) {
    const telegram = over.telegram ?? adapterStub("telegram");
    const discord = over.discord ?? adapterStub("discord");
    const promo = new CrossPromo({
      telegram,
      discord,
      links: LINKS,
      intervalHours: over.intervalHours ?? 1,
      log,
      random: () => 0.5, // ±20% jitter collapses to exactly the interval
    });
    return { promo, telegram, discord };
  }

  it("pollux fires first at half interval and his promo carries the telegram link", async () => {
    const { promo, telegram, discord } = build();
    promo.start();
    await vi.advanceTimersByTimeAsync(HOUR / 2 + 1000);
    expect(discord.announced).toHaveLength(1);
    expect(discord.announced[0]).toContain(LINKS.telegramChannel);
    expect(telegram.announced).toHaveLength(0); // castor waits for the full interval
    promo.stop();
  });

  it("castor fires at the full interval and his promo carries the discord invite", async () => {
    const { promo, telegram } = build();
    promo.start();
    await vi.advanceTimersByTimeAsync(HOUR + 1000);
    expect(telegram.announced).toHaveLength(1);
    expect(telegram.announced[0]).toContain(LINKS.discordInvite);
    promo.stop();
  });

  it("promo lines rotate round-robin on consecutive posts", async () => {
    const { promo, telegram } = build();
    promo.start();
    await vi.advanceTimersByTimeAsync(3 * HOUR + 1000);
    expect(telegram.announced).toHaveLength(3);
    expect(new Set(telegram.announced).size).toBe(3); // three distinct lines
    for (const line of telegram.announced) expect(line).toContain(LINKS.discordInvite);
    promo.stop();
  });

  it("a side without an adapter is skipped", async () => {
    const discord = adapterStub("discord");
    const promo = new CrossPromo({
      discord,
      links: LINKS,
      intervalHours: 1,
      log,
      random: () => 0.5,
    });
    promo.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(discord.announced.length).toBeGreaterThan(0); // pollux still posts
    promo.stop();
  });

  it("intervalHours <= 0 disables scheduling entirely", async () => {
    const { promo, telegram, discord } = build({ intervalHours: 0 });
    promo.start();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(telegram.announced).toHaveLength(0);
    expect(discord.announced).toHaveLength(0);
    promo.stop();
  });

  it("stop() cancels pending timers — nothing posts afterwards", async () => {
    const { promo, telegram, discord } = build();
    promo.start();
    await vi.advanceTimersByTimeAsync(HOUR / 4); // before the first fire
    promo.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(telegram.announced).toHaveLength(0);
    expect(discord.announced).toHaveLength(0);
  });

  it("a failing adapter is logged, not fatal — cadence continues", async () => {
    const telegram = adapterStub("telegram", true); // first announce throws
    const { promo } = build({ telegram });
    promo.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR + 1000);
    expect(telegram.announced).toHaveLength(1); // second post survived
    promo.stop();
  });
});

describe("CrossPromo — release announcements", () => {
  it("release event announces on BOTH adapters in each twin's voice", async () => {
    const telegram = adapterStub("telegram");
    const discord = adapterStub("discord");
    const promo = new CrossPromo({ telegram, discord, links: LINKS, intervalHours: 1, log });
    const { kb, fire } = kbStub();
    promo.attachReleases(kb);

    fire(RELEASE);
    await vi.waitFor(() => {
      expect(telegram.announced).toHaveLength(1);
      expect(discord.announced).toHaveLength(1);
    });
    // Both carry the release, each points at the sibling's channel.
    expect(telegram.announced[0]).toContain("argus");
    expect(telegram.announced[0]).toContain("v1.2.0");
    expect(telegram.announced[0]).toContain(LINKS.discordInvite);
    expect(discord.announced[0]).toContain("v1.2.0");
    expect(discord.announced[0]).toContain(LINKS.telegramChannel);
  });

  it("one adapter failing does not stop the other from announcing", async () => {
    const telegram = adapterStub("telegram", true); // throws on first announce
    const discord = adapterStub("discord");
    const promo = new CrossPromo({ telegram, discord, links: LINKS, intervalHours: 1, log });
    await promo.postRelease(RELEASE);
    expect(telegram.announced).toHaveLength(0);
    expect(discord.announced).toHaveLength(1);
  });

  it("audit entry is appended after a release post (best-effort)", async () => {
    const discord = adapterStub("discord");
    const audits: string[] = [];
    const promo = new CrossPromo({
      discord,
      links: LINKS,
      intervalHours: 1,
      log,
      audit: {
        append: async (ev) => {
          audits.push(ev.kind);
          return { ...ev, hash: "h", prevHash: "p" };
        },
        verify: async () => -1,
      },
    });
    await promo.postRelease(RELEASE);
    expect(audits).toEqual(["promo.release"]);
  });
});
