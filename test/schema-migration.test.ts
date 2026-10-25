/** Zod 4 must preserve operational defaults and existing persisted maps. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BulletinState } from "../src/bulletin/state.js";
import { loadConfig } from "../src/config.js";
import { TheoxeniaState } from "../src/theoxenia/state.js";
import type { Logger } from "../src/types.js";

const directories: string[] = [];
const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
function directory(): string {
  const result = mkdtempSync(join(tmpdir(), "dioscuri-schema-"));
  directories.push(result);
  return result;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("tuning input defaults", () => {
  it("expands defaults for every absent nested section", () => {
    const tuning = loadConfig(join(directory(), "missing.json")).tuning;
    expect(tuning.moderation.enabled).toBe(true);
    expect(tuning.moderation.deleteConfidence).toBe(0.8);
    expect(tuning.links.siteUrl).toBe("https://magic-ai-factory.com");
    expect(tuning.syndication.devtoDigestDay).toBe(1);
    expect(tuning.showcase.sources).toHaveLength(2);
    expect(tuning.content.images.screenshots.enabled).toBe(true);
    expect(tuning.content.slots).toHaveLength(8);
    expect(tuning.bulletin.enabled).toBe(false);
  });

  it("preserves a partial override while filling its nested siblings", () => {
    const file = join(directory(), "tuning.json");
    writeFileSync(file, JSON.stringify({
      moderation: { deleteConfidence: 0.95 }, content: { images: { aiProvider: "local" } },
    }));
    const tuning = loadConfig(file).tuning;
    expect(tuning.moderation.deleteConfidence).toBe(0.95);
    expect(tuning.moderation.enabled).toBe(true);
    expect(tuning.content.images.aiProvider).toBe("local");
    expect(tuning.content.images.screenshots.enabled).toBe(true);
    expect(tuning.content.maxPostsPerDay).toBe(3);
  });

  it("still rejects an invalid operator moderation threshold", () => {
    const file = join(directory(), "tuning.json");
    writeFileSync(file, JSON.stringify({ moderation: { deleteConfidence: 2 } }));
    expect(() => loadConfig(file)).toThrow();
  });
});

describe("persisted record compatibility", () => {
  it("keeps topic history, rotation and daily counters when loading old state", () => {
    const dir = directory();
    const now = Date.UTC(2026, 9, 25, 12);
    writeFileSync(join(dir, "theoxenia.json"), JSON.stringify({
      postedHashes: [{ h: "legacy-topic", ts: now }], rotation: { banter: 3 },
      dailyCounts: { date: "2026-10-25", perPlatform: { discord: 2 } },
      banterDirection: false, spotlightPlatform: true, weeklyMemes: { week: "", count: 0 },
    }));
    const state = new TheoxeniaState(dir, log, () => now);
    expect(state.data.rotation).toEqual({ banter: 3 });
    expect(state.data.dailyCounts.perPlatform).toEqual({ discord: 2 });
    expect(state.data.postedHashes).toEqual([{ hash: "legacy-topic", ts: now }]);
  });

  it("keeps per-advisory, per-sink delivery records", () => {
    const dir = directory();
    writeFileSync(join(dir, "bulletin-state.json"), JSON.stringify({ posted: {
      "fixture-advisory": { modified: "2026-10-25", status: "fixed", postedAt: 123,
        messages: { discord: "message-123", telegram: "message-456" } },
    } }));
    const state = new BulletinState(dir, log);
    expect(state.recordFor("fixture-advisory")?.messages).toEqual({
      discord: "message-123", telegram: "message-456",
    });
  });
});
