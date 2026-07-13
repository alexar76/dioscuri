/**
 * Tests for src/theoxenia — the content engine — with fake adapters/llm/kb and
 * injected clock/random/timers: banter choreography (setup on A with B's link,
 * punchline on B after 15 min, alternating direction), quiet-hours and
 * daily-cap skips, author-queue consumption, 14-day topic dedup, poll text
 * fallback, digest recency filter, postGuard hardening, English-only output.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Theoxenia, type ContentTuning, type TheoxeniaOpts } from "../src/theoxenia/engine.js";
import { resolveDemoForTopic } from "../src/mnemosyne/demo-urls.js";
import { createScreenshotProvider } from "../src/images/screenshots.js";
import { makeFakeQcPng } from "./helpers/fake-png.js";
import { postGuard } from "../src/theoxenia/generator.js";
import { topicHash } from "../src/theoxenia/state.js";
import type {
  CanonDiscordPost,
  ChannelAdapter,
  ChatOptions,
  CrossLinks,
  KnowledgeChunk,
  Logger,
  Mnemosyne,
  Platform,
  RetrievalHit,
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

/** Monday 2026-06-15 12:00 UTC — comfortably outside the default quiet hours. */
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeAdapter extends ChannelAdapter {
  announces: string[];
  galleryAnnounces: string[];
  canonAnnounces: CanonDiscordPost[];
  generalAnnounces: string[];
  polls: { question: string; options: string[] }[];
  images: { caption: string; bytes: number }[];
}

function makeAdapter(platform: Platform, withPoll = false, withImage = false): FakeAdapter {
  const a: FakeAdapter = {
    platform,
    announces: [],
    galleryAnnounces: [],
    canonAnnounces: [],
    generalAnnounces: [],
    polls: [],
    images: [],
    start: async () => {},
    stop: async () => {},
    announce: async (text) => {
      a.announces.push(text);
    },
    isReady: () => true,
  };
  if (platform === "discord") {
    a.announceGallery = async (text) => {
      a.galleryAnnounces.push(text);
    };
    a.announceCanon = async (post) => {
      a.canonAnnounces.push(post);
    };
    a.announceGeneral = async (text) => {
      a.generalAnnounces.push(text);
    };
  }
  if (withImage) {
    a.announceImage = async (image, caption) => {
      a.images.push({ caption, bytes: image.length });
      a.announces.push(caption);
    };
  }
  if (withPoll) {
    a.announcePoll = async (question, options) => {
      a.polls.push({ question, options });
    };
  }
  return a;
}

function chunk(over: Partial<KnowledgeChunk>): KnowledgeChunk {
  return {
    id: "aicom#readme#0",
    repo: "aicom",
    source: "readme",
    title: "AI Factory README",
    url: "https://github.com/alexar76/aicom",
    text: "The factory builds products autonomously. It never sleeps.",
    updatedAt: new Date(NOW - DAY).toISOString(),
    ...over,
  };
}

function kbWith(chunks: KnowledgeChunk[], demo?: Record<string, string>): Mnemosyne {
  const hits: RetrievalHit[] = chunks.map((c) => ({ chunk: c, score: 1 }));
  const registry = new Map(Object.entries(demo ?? {}));
  return {
    search: () => hits,
    stats: () => ({ chunks: chunks.length, repos: 1, lastSyncAt: null, lastSyncOk: true }),
    onRelease: () => {},
    syncOnce: async () => {},
    start: () => {},
    stop: () => {},
    demoUrls: () => Object.fromEntries(registry),
    resolveDemoUrl: (topic) => resolveDemoForTopic(topic, registry),
  };
}

interface FakeTimers {
  scheduled: { id: number; fn: () => void; ms: number }[];
  cleared: unknown[];
  setTimeoutFn: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn: (handle: unknown) => void;
}

function makeTimers(): FakeTimers {
  let nextId = 1;
  const t: FakeTimers = {
    scheduled: [],
    cleared: [],
    setTimeoutFn: (fn, ms) => {
      const id = nextId++;
      t.scheduled.push({ id, fn, ms });
      return id;
    },
    clearTimeoutFn: (handle) => {
      t.cleared.push(handle);
    },
  };
  return t;
}

function makeCfg(over: Partial<ContentTuning> = {}): ContentTuning {
  return {
    enabled: true,
    maxPostsPerDay: 3,
    quietHoursUtc: [22, 7],
    slots: [{ kind: "spotlight", day: "mon", hourUtc: 15 }],
    images: { aiProvider: "", aiModel: "", aiMemesPerWeek: 2, screenshots: { enabled: true } },
    topics: ["alpha topic", "beta topic"],
    ...over,
  };
}

interface Harness {
  engine: Theoxenia;
  tg: FakeAdapter;
  dc: FakeAdapter;
  timers: FakeTimers;
  llmCalls: ChatOptions[];
  dir: string;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "dioscuri-theoxenia-"));
  dirs.push(dir);
  return dir;
}

function harness(opts: {
  llmReply?: string | ((o: ChatOptions) => string);
  kbChunks?: KnowledgeChunk[];
  kbDemo?: Record<string, string>;
  cfg?: Partial<ContentTuning>;
  now?: number;
  dir?: string;
  withPoll?: boolean;
  withImage?: boolean;
  overrides?: Partial<TheoxeniaOpts>;
} = {}): Harness {
  const dir = opts.dir ?? makeDir();
  const tg = makeAdapter("telegram", opts.withPoll ?? false, opts.withImage ?? false);
  const dc = makeAdapter("discord", opts.withPoll ?? false);
  const timers = makeTimers();
  const llmCalls: ChatOptions[] = [];
  const reply = opts.llmReply ?? "A perfectly grounded English post.";
  const engine = new Theoxenia({
    telegram: tg,
    discord: dc,
    kb: kbWith(opts.kbChunks ?? [chunk({})], opts.kbDemo),
    llm: {
      chat: async (o) => {
        llmCalls.push(o);
        return typeof reply === "function" ? reply(o) : reply;
      },
    },
    links: LINKS,
    cfg: makeCfg(opts.cfg ?? {}),
    dataDir: dir,
    log,
    now: () => opts.now ?? NOW,
    random: () => 0.5,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    ...opts.overrides,
  });
  return { engine, tg, dc, timers, llmCalls, dir };
}

const BANTER_JSON = JSON.stringify({
  setup: "Why did the oracle cross the chain? I only carry setups.",
  punchline: "To verify the other side. Naturally.",
});

const CANON_JSON = JSON.stringify({
  column: "Weak aggregation is not deliberation — it is latency with a committee badge.",
  debateHook: "Which Metis benchmark would you trust a weak council to run?",
});

// ---------------------------------------------------------------------------
// Canon (THEOROS)
// ---------------------------------------------------------------------------

describe("canon", () => {
  it("posts column, teaser, and twin pointers on Discord + Telegram", async () => {
    const h = harness({
      llmReply: CANON_JSON,
      kbChunks: [
        chunk({
          id: "theoros#readme#0",
          repo: "theoros",
          source: "readme",
          title: "THEOROS",
          text: "Seven precepts of agent sovereignty.",
          updatedAt: new Date(NOW).toISOString(),
        }),
      ],
      cfg: { topics: ["weak aggregation on Metis benchmarks"] },
    });
    await h.engine.runSlotNow("canon");

    expect(h.dc.canonAnnounces).toHaveLength(1);
    expect(h.dc.canonAnnounces[0]!.body).toContain("Weak aggregation");
    expect(h.dc.canonAnnounces[0]!.chapterLabel).toMatch(/Chapter \d+/);
    expect(h.dc.canonAnnounces[0]!.canonUrl).toBe(LINKS.theorosUrl);
    expect(h.dc.canonAnnounces[0]!.debateHook).toContain("Metis");
    expect(h.dc.announces).toHaveLength(1);
    expect(h.dc.announces[0]!).toContain("THEOROS");
    expect(h.dc.generalAnnounces).toHaveLength(1);
    expect(h.dc.generalAnnounces[0]!).toContain("THEOROS");
    expect(h.dc.generalAnnounces[0]!).toContain("#canon-debate");
    expect(h.tg.announces).toHaveLength(1);
    expect(h.tg.announces[0]!).toContain("THEOROS");
    expect(h.tg.announces[0]!).toContain(LINKS.discordInvite);
  });

  it("skips when announceCanon is not configured", async () => {
    const dcNoCanon = makeAdapter("discord");
    delete dcNoCanon.announceCanon;
    const h = harness({
      llmReply: CANON_JSON,
      overrides: { discord: dcNoCanon },
      cfg: { topics: ["canon topic"] },
    });
    await h.engine.runSlotNow("canon");
    expect(h.dc.announces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Banter choreography
// ---------------------------------------------------------------------------

describe("banter", () => {
  it("setup on A carries B's link; punchline fires on B after 15 minutes", async () => {
    const h = harness({ llmReply: BANTER_JSON });
    await h.engine.runSlotNow("banter");

    // Default direction: setup by Castor on Telegram, teasing the Discord punchline.
    expect(h.tg.announces).toHaveLength(1);
    expect(h.tg.announces[0]!).toContain("Why did the oracle cross the chain?");
    expect(h.tg.announces[0]!).toContain(LINKS.discordInvite);
    expect(h.dc.announces).toHaveLength(0);

    // Punchline waits on the injected timer for exactly 15 minutes.
    expect(h.timers.scheduled).toHaveLength(1);
    expect(h.timers.scheduled[0]!.ms).toBe(15 * 60 * 1000);
    h.timers.scheduled[0]!.fn();
    await flush();
    expect(h.dc.announces).toHaveLength(1);
    expect(h.dc.announces[0]!).toContain("To verify the other side.");
  });

  it("direction alternates: second run sets up on Discord with the Telegram link", async () => {
    const h = harness({ llmReply: BANTER_JSON });
    await h.engine.runSlotNow("banter");
    expect(h.tg.announces).toHaveLength(1);

    await h.engine.runSlotNow("banter");
    expect(h.dc.announces).toHaveLength(1); // second setup went to Discord
    expect(h.dc.announces[0]!).toContain(LINKS.telegramChannel);
  });

  it("malformed banter JSON skips the slot without posting", async () => {
    const h = harness({ llmReply: "not json at all" });
    await h.engine.runSlotNow("banter");
    expect(h.tg.announces).toHaveLength(0);
    expect(h.dc.announces).toHaveLength(0);
    expect(h.timers.scheduled).toHaveLength(0);
  });

  it("missing punchline adapter skips the whole slot", async () => {
    const h = harness({ llmReply: BANTER_JSON, overrides: { discord: undefined } });
    await h.engine.runSlotNow("banter");
    expect(h.tg.announces).toHaveLength(0);
    expect(h.llmCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cadence discipline
// ---------------------------------------------------------------------------

describe("cadence discipline", () => {
  it("scheduled slot skips inside quiet hours (window wraps midnight)", async () => {
    const h = harness({ now: Date.UTC(2026, 5, 15, 23, 0, 0) }); // 23:00 ∈ [22, 7)
    await h.engine.runSlot("spotlight");
    expect(h.llmCalls).toHaveLength(0);
    expect(h.tg.announces).toHaveLength(0);
    expect(h.dc.announces).toHaveLength(0);
  });

  it("runSlotNow bypasses quiet hours", async () => {
    const h = harness({ now: Date.UTC(2026, 5, 15, 23, 0, 0) });
    await h.engine.runSlotNow("spotlight");
    expect(h.tg.announces.length + h.dc.announces.length).toBe(1);
  });

  it("daily cap: second poll of the day is skipped before the LLM is called", async () => {
    const pollJson = JSON.stringify({
      question: "Which oracle do you trust most?",
      options: ["LUMEN", "CHRONOS", "PLATON"],
    });
    const h = harness({ llmReply: pollJson, cfg: { maxPostsPerDay: 1 } });

    await h.engine.runSlotNow("poll");
    expect(h.tg.announces).toHaveLength(1);
    expect(h.dc.announces).toHaveLength(1);
    expect(h.llmCalls).toHaveLength(1);

    await h.engine.runSlotNow("poll");
    expect(h.tg.announces).toHaveLength(1); // unchanged
    expect(h.dc.announces).toHaveLength(1);
    expect(h.llmCalls).toHaveLength(1); // capped platforms → no generation
  });
});

// ---------------------------------------------------------------------------
// Topic sourcing: author queue + dedup rotation
// ---------------------------------------------------------------------------

describe("topic sourcing", () => {
  it("author queue is consumed first and the file is rewritten without the item", async () => {
    const dir = makeDir();
    const queueFile = join(dir, "content-queue.json");
    writeFileSync(
      queueFile,
      JSON.stringify([
        { kind: "spotlight", topic: "queued special topic" },
        { topic: "generic follow-up" },
      ]),
      "utf8",
    );
    const h = harness({ dir });
    await h.engine.runSlotNow("spotlight");

    expect(h.llmCalls).toHaveLength(1);
    expect(h.llmCalls[0]!.messages[0]!.content).toContain("queued special topic");
    const left = JSON.parse(readFileSync(queueFile, "utf8")) as { topic: string }[];
    expect(left).toHaveLength(1);
    expect(left[0]!.topic).toBe("generic follow-up");
  });

  it("rotation skips a topic posted within the 14-day window", async () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "theoxenia.json"),
      JSON.stringify({
        postedHashes: [{ h: topicHash("spotlight", "alpha topic"), ts: NOW - HOUR }],
        rotation: {},
        dailyCounts: { date: "", perPlatform: {} },
        banterDirection: true,
        spotlightPlatform: true,
      }),
      "utf8",
    );
    const h = harness({ dir });
    await h.engine.runSlotNow("spotlight");

    expect(h.llmCalls).toHaveLength(1);
    expect(h.llmCalls[0]!.messages[0]!.content).toContain("beta topic");
    expect(h.llmCalls[0]!.messages[0]!.content).not.toContain("alpha topic");
  });
});

// ---------------------------------------------------------------------------
// Spotlight demo screenshots
// ---------------------------------------------------------------------------

describe("spotlight screenshots", () => {
  it("attaches a README demo screenshot when topic matches a repo", async () => {
    const png = makeFakeQcPng();
    const shots = createScreenshotProvider({
      baseUrl: "http://127.0.0.1:8767",
      log,
      fetchFn: async () => new Response(png, { status: 200 }),
    });
    const h = harness({
      withImage: true,
      cfg: {
        topics: ["Alien Monitor — the 3D ecosystem observatory"],
        images: { aiProvider: "", aiModel: "", aiMemesPerWeek: 0, screenshots: { enabled: true } },
      },
      kbDemo: { "alien-monitor": "https://magic-ai-factory.com/monitor/" },
      overrides: { screenshotProvider: shots },
    });
    await h.engine.runSlotNow("spotlight");
    expect(h.tg.images).toHaveLength(1);
    expect(h.tg.images[0]!.bytes).toBeGreaterThan(50_000);
  });

  it("falls back to text when screenshot capture fails", async () => {
    const shots = createScreenshotProvider({
      baseUrl: "http://127.0.0.1:8767",
      log,
      fetchFn: async () => new Response("nope", { status: 500 }),
    });
    const h = harness({
      withImage: true,
      cfg: {
        topics: ["Alien Monitor — the 3D ecosystem observatory"],
        images: { aiProvider: "", aiModel: "", aiMemesPerWeek: 0, screenshots: { enabled: true } },
      },
      kbDemo: { "alien-monitor": "https://magic-ai-factory.com/monitor/" },
      overrides: { screenshotProvider: shots },
    });
    await h.engine.runSlotNow("spotlight");
    expect(h.tg.images).toHaveLength(0);
    expect(h.tg.announces).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Poll fallback
// ---------------------------------------------------------------------------

describe("poll", () => {
  it("falls back to lettered text when announcePoll is absent", async () => {
    const pollJson = JSON.stringify({
      question: "Which oracle do you trust most?",
      options: ["LUMEN", "CHRONOS"],
    });
    const h = harness({ llmReply: pollJson }); // adapters without announcePoll
    await h.engine.runSlotNow("poll");

    for (const a of [h.tg, h.dc]) {
      expect(a.announces).toHaveLength(1);
      expect(a.announces[0]!.startsWith("🗳")).toBe(true);
      expect(a.announces[0]!).toContain("Which oracle do you trust most?");
      expect(a.announces[0]!).toContain("A) LUMEN");
      expect(a.announces[0]!).toContain("B) CHRONOS");
    }
  });

  it("uses the native poll API when the adapter provides one", async () => {
    const pollJson = JSON.stringify({
      question: "Ship on Friday?",
      options: ["Always", "Never", "Only oracles"],
    });
    const h = harness({ llmReply: pollJson, withPoll: true });
    await h.engine.runSlotNow("poll");
    expect(h.tg.polls).toHaveLength(1);
    expect(h.dc.polls).toHaveLength(1);
    expect(h.tg.announces).toHaveLength(0);
    expect(h.dc.polls[0]!.options).toEqual(["Always", "Never", "Only oracles"]);
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe("digest", () => {
  it("includes only release chunks updated within 7 days, posts to both platforms", async () => {
    const h = harness({
      kbChunks: [
        chunk({
          id: "argus#release#0",
          repo: "argus",
          source: "release",
          title: "v1.2.0",
          text: "WARDEN firewall shipped. More things happened later.",
          url: "https://github.com/alexar76/argus/releases/v1.2.0",
          updatedAt: new Date(NOW - 2 * DAY).toISOString(),
        }),
        chunk({
          id: "oldrepo#release#0",
          repo: "oldrepo",
          source: "release",
          title: "v0.0.9",
          text: "Ancient history.",
          updatedAt: new Date(NOW - 30 * DAY).toISOString(),
        }),
        chunk({
          id: "docs#readme#0",
          repo: "docsrepo",
          source: "readme",
          title: "README",
          text: "Not a release at all.",
          updatedAt: new Date(NOW - DAY).toISOString(),
        }),
      ],
    });
    await h.engine.runSlotNow("digest");

    for (const a of [h.tg, h.dc]) {
      expect(a.announces).toHaveLength(1);
      const text = a.announces[0]!;
      expect(text).toContain("🔨 This week in the forge:");
      expect(text).toContain("• argus v1.2.0 — WARDEN firewall shipped.");
      expect(text).toContain("https://github.com/alexar76/argus/releases/v1.2.0");
      expect(text).not.toContain("oldrepo");
      expect(text).not.toContain("docsrepo");
    }
    expect(h.llmCalls).toHaveLength(0); // digest is deterministic
  });

  it("skips entirely when no release is fresh enough", async () => {
    const h = harness({
      kbChunks: [
        chunk({
          id: "oldrepo#release#0",
          repo: "oldrepo",
          source: "release",
          title: "v0.0.9",
          text: "Ancient history.",
          updatedAt: new Date(NOW - 30 * DAY).toISOString(),
        }),
      ],
    });
    await h.engine.runSlotNow("digest");
    expect(h.tg.announces).toHaveLength(0);
    expect(h.dc.announces).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// postGuard
// ---------------------------------------------------------------------------

describe("postGuard", () => {
  it("neutralises @everyone/@here and strips foreign invites, keeps official ones", () => {
    const out = postGuard(
      "hey @everyone and @here — join https://discord.gg/evil or https://discord.gg/aicom or t.me/scam or https://t.me/aicom",
      "discord",
      LINKS,
    );
    expect(out).not.toContain("@everyone");
    expect(out).not.toContain("@here");
    expect(out).toContain("everyone");
    expect(out).not.toContain("discord.gg/evil");
    expect(out).not.toContain("t.me/scam");
    expect(out).toContain("https://discord.gg/aicom");
    expect(out).toContain("https://t.me/aicom");
  });

  it("caps discord at 1900 chars with a sentence cut and ellipsis", () => {
    const out = postGuard("This is a proper sentence. ".repeat(200), "discord", LINKS);
    expect(out.length).toBeLessThanOrEqual(1900);
    expect(out.endsWith("…")).toBe(true);
    expect(out.at(-2)).toBe("."); // cut fell on a sentence boundary
  });

  it("caps telegram at 3500 chars", () => {
    const out = postGuard("word ".repeat(1000), "telegram", LINKS);
    expect(out.length).toBeLessThanOrEqual(3500);
    expect(out.endsWith("…")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// English-only output
// ---------------------------------------------------------------------------

describe("english-only output", () => {
  it("show-and-tell, digest and banter produce no cyrillic given EN fixtures", async () => {
    const h = harness({
      llmReply: BANTER_JSON,
      kbChunks: [
        chunk({
          id: "argus#release#0",
          repo: "argus",
          source: "release",
          title: "v1.2.0",
          text: "WARDEN firewall shipped.",
          updatedAt: new Date(NOW - 2 * DAY).toISOString(),
        }),
      ],
      cfg: { maxPostsPerDay: 12 },
    });
    await h.engine.runSlotNow("show-and-tell");
    await h.engine.runSlotNow("digest");
    await h.engine.runSlotNow("banter");
    for (const s of h.timers.scheduled) s.fn();
    await flush();

    const all = [...h.tg.announces, ...h.dc.announces, ...h.dc.galleryAnnounces];
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const text of all) {
      expect(text).not.toMatch(/[Ѐ-ӿ]/);
      expect(text.trim().length).toBeGreaterThan(0);
    }
    // Show-and-tell: main nudge on Discord gallery, companion pointer on Telegram.
    expect(h.dc.galleryAnnounces.length).toBeGreaterThanOrEqual(1);
    expect(h.dc.galleryAnnounces[0]!).toContain("#gallery");
    expect(h.tg.announces[0]!).toContain(LINKS.discordInvite);
  });
});

// ---------------------------------------------------------------------------
// AI memes on banter slots (optional provider, weekly budget, text fallback)
// ---------------------------------------------------------------------------

describe("banter memes", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

  function memeProvider(script: Array<Buffer | Error>) {
    const prompts: string[] = [];
    return {
      prompts,
      provider: {
        name: "fake-images",
        generate: async (prompt: string) => {
          prompts.push(prompt);
          const next = script.shift() ?? PNG;
          if (next instanceof Error) throw next;
          return next;
        },
      },
    };
  }

  function captureImages(adapter: FakeAdapter): { caption: string; bytes: number }[] {
    const shots: { caption: string; bytes: number }[] = [];
    adapter.announceImage = async (image, caption) => {
      shots.push({ caption, bytes: image.byteLength });
    };
    return shots;
  }

  it("attaches a meme to the setup post; prompt is built from the topic, not user text", async () => {
    const m = memeProvider([PNG]);
    const h = harness({ llmReply: BANTER_JSON, overrides: { memeProvider: m.provider } });
    const shots = captureImages(h.tg);

    await h.engine.runSlotNow("banter");

    expect(shots).toHaveLength(1);
    expect(shots[0]!.bytes).toBe(PNG.byteLength);
    expect(shots[0]!.caption).toContain("Why did the oracle cross the chain?");
    // Setup went as an image post — no duplicate text announce.
    expect(h.tg.announces).toHaveLength(0);
    // Prompt grounded in the rotating config topic only.
    expect(m.prompts).toHaveLength(1);
    expect(m.prompts[0]!).toContain("alpha topic");
    // Punchline choreography untouched.
    expect(h.timers.scheduled).toHaveLength(1);
  });

  it("respects the weekly budget: past the cap banter posts as text", async () => {
    const m = memeProvider([PNG, PNG]);
    const h = harness({
      llmReply: BANTER_JSON,
      cfg: { images: { aiProvider: "together", aiModel: "", aiMemesPerWeek: 1 } },
      overrides: { memeProvider: m.provider },
    });
    const tgShots = captureImages(h.tg);
    const dcShots = captureImages(h.dc);

    await h.engine.runSlotNow("banter"); // telegram setup — meme #1 (budget hit)
    await h.engine.runSlotNow("banter"); // discord setup — over budget → text

    expect(tgShots).toHaveLength(1);
    expect(dcShots).toHaveLength(0);
    expect(h.dc.announces.some((t) => t.includes("Why did the oracle"))).toBe(true);
    expect(m.prompts).toHaveLength(1); // provider not even called past the cap
  });

  it("provider failure falls back to text and does not burn the budget", async () => {
    const m = memeProvider([new Error("gpu on fire"), PNG]);
    const h = harness({ llmReply: BANTER_JSON, overrides: { memeProvider: m.provider } });
    const tgShots = captureImages(h.tg);
    const dcShots = captureImages(h.dc);

    await h.engine.runSlotNow("banter"); // fails → text on telegram
    expect(tgShots).toHaveLength(0);
    expect(h.tg.announces).toHaveLength(1);

    await h.engine.runSlotNow("banter"); // budget still free → meme on discord
    expect(dcShots).toHaveLength(1);
  });

  it("adapter without announceImage never invokes the provider", async () => {
    const m = memeProvider([PNG]);
    const h = harness({ llmReply: BANTER_JSON, overrides: { memeProvider: m.provider } });
    // default fake adapters have no announceImage

    await h.engine.runSlotNow("banter");

    expect(m.prompts).toHaveLength(0);
    expect(h.tg.announces).toHaveLength(1);
  });
});
