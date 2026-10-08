/**
 * The bulletin feature was fully implemented and fully unreachable: BulletinPublisher
 * existed, the renderer and the verifier were tested, #momus-bulletin was provisioned —
 * and nothing ever constructed the publisher, so not one advisory could be posted.
 * `tuning.bulletin`, which the module's own docs pointed at, was not in the schema either.
 *
 * These tests hold the wiring itself: the config surface exists, the composition root
 * references it, and a Discord sink hands a rendered advisory to the adapter untouched.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BulletinPublisher, type BulletinSink, type RenderedAdvisory } from "../src/bulletin/index.js";
import { loadConfig } from "../src/config.js";

const ROOT = join(import.meta.dirname, "..");

function rendered(id = "MOMUS-2026-0001"): RenderedAdvisory {
  return {
    advisoryId: id,
    kind: "new",
    discord: {
      content: "🛡️ MOMUS advisory",
      embed: {
        title: `${id} — unauthenticated read on a control route`,
        url: `https://momus.modelmarket.dev/bulletin/${id}`,
        color: 0xff5d8a,
        description: "A control route answered without an operator token.",
        fields: [{ name: "Severity", value: "high", inline: true }],
        footer: "MOMUS · signed advisory",
      },
    },
    telegram: `${id} — unauthenticated read on a control route`,
  };
}

describe("tuning.bulletin config surface", () => {
  it("exists with publishing off by default", () => {
    const cfg = loadConfig();
    expect(cfg.tuning.bulletin).toBeDefined();
    expect(cfg.tuning.bulletin.enabled).toBe(false);
    expect(cfg.tuning.bulletin.publicKeyHex).toBe("");
  });

  it("defaults are the ones the publisher documents", () => {
    const b = loadConfig().tuning.bulletin;
    expect(b.indexUrl).toBe("https://momus.modelmarket.dev/bulletin");
    expect(b.pollIntervalMin).toBe(30);
    expect(b.maxPostsPerRun).toBe(5);
    expect(b.maxAgeHours).toBe(24);
  });

  it("carries a bulletin channel id, so an operator can pin one", () => {
    expect(loadConfig().discord.bulletinChannelId).toBeDefined();
  });
});

describe("composition root", () => {
  const index = readFileSync(join(ROOT, "src", "index.ts"), "utf8");

  it("constructs and starts the publisher", () => {
    expect(index).toContain("new BulletinPublisher(");
    expect(index).toMatch(/bulletinPublisher\.start\(\)/);
  });

  it("resolves the channel from provisioning, with the pinned id winning", () => {
    expect(index).toContain("bulletinChannelId = bulletinChannelId || res.bulletinChannelId");
  });

  it("stops the publisher on shutdown", () => {
    expect(index).toContain("bulletinPublisher?.stop()");
  });

  it("hands the channel to the Discord adapter", () => {
    const adapter = readFileSync(join(ROOT, "src", "adapters", "discord.ts"), "utf8");
    expect(adapter).toContain("bulletinChannelId");
    expect(adapter).toContain("async announceBulletin(");
  });
});

describe("a sink that posts", () => {
  it("passes the rendered advisory through untouched and records the message id", async () => {
    const announceBulletin = vi.fn(async () => "msg-1");
    const sink: BulletinSink = { name: "discord", post: (r) => announceBulletin(r) };

    const id = await sink.post(rendered());

    expect(id).toBe("msg-1");
    expect(announceBulletin).toHaveBeenCalledTimes(1);
    const arg = announceBulletin.mock.calls[0]?.[0] as unknown as RenderedAdvisory;
    expect(arg.discord.embed.title).toContain("MOMUS-2026-0001");
  });

  it("refuses to start without a pinned key — an unverified advisory is never posted", () => {
    const warn = vi.fn();
    const log = {
      info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(),
      child: () => log,
    } as never;
    const setIntervalFn = vi.fn(() => ({ unref: () => undefined }));

    const publisher = new BulletinPublisher({
      indexUrl: "https://momus.modelmarket.dev/bulletin",
      publicKeyHex: "   ",
      sinks: [{ name: "discord", post: async () => "x" }],
      dataDir: join(ROOT, "test", ".tmp-bulletin-wiring"),
      log,
      setIntervalFn,
    });
    publisher.start();

    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("refuses to start with no sink configured", () => {
    const warn = vi.fn();
    const log = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => log } as never;
    const setIntervalFn = vi.fn(() => ({ unref: () => undefined }));

    new BulletinPublisher({
      indexUrl: "https://momus.modelmarket.dev/bulletin",
      publicKeyHex: "aa".repeat(32),
      sinks: [],
      dataDir: join(ROOT, "test", ".tmp-bulletin-wiring"),
      log,
      setIntervalFn,
    }).start();

    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
