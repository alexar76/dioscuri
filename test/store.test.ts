/**
 * Tests for src/mnemosyne/store.ts — BM25 retrieval (latin + cyrillic
 * tokens, source boosts), replaceRepo semantics, seenReleases bookkeeping,
 * and atomic persist/load with missing/corrupt-file tolerance.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KnowledgeStore, tokenize } from "../src/mnemosyne/store.js";
import type { KnowledgeChunk, KnowledgeSource } from "../src/types.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dioscuri-store-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function ch(
  id: string,
  repo: string,
  text: string,
  source: KnowledgeSource = "readme",
  title = `${repo} title`,
): KnowledgeChunk {
  return {
    id,
    repo,
    source,
    title,
    url: `https://github.com/alexar76/${repo}`,
    text,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("tokenize", () => {
  it("lowercases and keeps letter/digit runs of >=2 chars", () => {
    expect(tokenize("Hello, WORLD! a b2 x")).toEqual(["hello", "world", "b2"]);
  });

  it("handles cyrillic runs", () => {
    expect(tokenize("Оракул проверяет данные v2")).toEqual(["оракул", "проверяет", "данные", "v2"]);
  });
});

describe("KnowledgeStore search (BM25)", () => {
  it("ranks the relevant repo first", () => {
    const store = new KnowledgeStore();
    store.replaceRepo("oracles", [
      ch("oracles#readme#0", "oracles", "A verifiable oracle family with cryptographic attestation of every answer."),
    ]);
    store.replaceRepo("lottery", [
      ch("lottery#readme#0", "lottery", "An on-chain lottery selling tickets with USDC on Base."),
    ]);

    const oracleHits = store.search("oracle attestation", 5);
    expect(oracleHits.length).toBeGreaterThan(0);
    expect(oracleHits[0]!.chunk.repo).toBe("oracles");

    const lotteryHits = store.search("lottery tickets", 5);
    expect(lotteryHits[0]!.chunk.repo).toBe("lottery");
  });

  it("finds cyrillic content with cyrillic queries", () => {
    const store = new KnowledgeStore();
    store.replaceRepo("docs", [ch("docs#doc#0", "docs", "Оракул проверяет данные и подписывает ответ.", "doc")]);
    store.replaceRepo("misc", [ch("misc#doc#0", "misc", "Something entirely unrelated in english.", "doc")]);
    const hits = store.search("оракул", 5);
    expect(hits.length).toBe(1);
    expect(hits[0]!.chunk.id).toBe("docs#doc#0");
  });

  it("applies source boosts: readme beats repo-meta on identical text", () => {
    const store = new KnowledgeStore();
    const text = "The warden firewall scores every MCP call.";
    store.replaceRepo("r1", [ch("r1#readme#0", "r1", text, "readme", "same title")]);
    store.replaceRepo("r2", [ch("r2#repo-meta#0", "r2", text, "repo-meta", "same title")]);
    const hits = store.search("warden firewall", 5);
    expect(hits.length).toBe(2);
    expect(hits[0]!.chunk.source).toBe("readme");
    expect(hits[0]!.score / hits[1]!.score).toBeCloseTo(1.15, 5);
  });

  it("returns [] for empty stores, empty queries and k<=0", () => {
    const store = new KnowledgeStore();
    expect(store.search("anything", 5)).toEqual([]);
    store.replaceRepo("r", [ch("r#readme#0", "r", "some text")]);
    expect(store.search("", 5)).toEqual([]);
    expect(store.search("a", 5)).toEqual([]); // 1-char run → no tokens
    expect(store.search("text", 0)).toEqual([]);
  });

  it("caps results at k", () => {
    const store = new KnowledgeStore();
    store.replaceRepo("r", [
      ch("r#readme#0", "r", "gauss oracle one"),
      ch("r#readme#1", "r", "gauss oracle two"),
      ch("r#readme#2", "r", "gauss oracle three"),
    ]);
    expect(store.search("gauss", 2)).toHaveLength(2);
  });
});

describe("KnowledgeStore replaceRepo", () => {
  it("replaces a repo's chunks atomically", () => {
    const store = new KnowledgeStore();
    store.replaceRepo("r", [ch("r#readme#0", "r", "ancient forgotten kraken")]);
    expect(store.search("kraken", 5)).toHaveLength(1);

    store.replaceRepo("r", [ch("r#readme#0", "r", "fresh shiny phoenix")]);
    expect(store.search("kraken", 5)).toHaveLength(0);
    expect(store.search("phoenix", 5)).toHaveLength(1);
    expect(store.chunkCount()).toBe(1);
    expect(store.repoCount()).toBe(1);
  });

  it("an empty chunk list removes the repo", () => {
    const store = new KnowledgeStore();
    store.replaceRepo("r", [ch("r#readme#0", "r", "temporary")]);
    store.replaceRepo("r", []);
    expect(store.repoCount()).toBe(0);
    expect(store.chunkCount()).toBe(0);
  });
});

describe("KnowledgeStore seenReleases + isEmpty", () => {
  it("tracks seen release ids and factors them into isEmpty", () => {
    const store = new KnowledgeStore();
    expect(store.isEmpty()).toBe(true);
    expect(store.hasSeenRelease("aicom@v1.0.0")).toBe(false);
    store.markReleaseSeen("aicom@v1.0.0");
    expect(store.hasSeenRelease("aicom@v1.0.0")).toBe(true);
    expect(store.seenReleaseCount()).toBe(1);
    expect(store.isEmpty()).toBe(false); // seen releases alone make it non-empty
  });
});

describe("KnowledgeStore persist/load", () => {
  it("round-trips chunks and seenReleases through JSON", async () => {
    const path = join(tmp(), "kb.json");
    const store = new KnowledgeStore();
    store.replaceRepo("oracles", [
      ch("oracles#readme#0", "oracles", "A verifiable oracle with attestation."),
      ch("oracles#release#0", "oracles", "v1.0.0 adds attestation proofs.", "release"),
    ]);
    store.markReleaseSeen("oracles@v1.0.0");
    await store.persist(path);

    const loaded = new KnowledgeStore();
    expect(loaded.load(path)).toBe(true);
    expect(loaded.chunkCount()).toBe(2);
    expect(loaded.repoCount()).toBe(1);
    expect(loaded.hasSeenRelease("oracles@v1.0.0")).toBe(true);
    const hits = loaded.search("attestation", 5);
    expect(hits.length).toBe(2);
    expect(hits[0]!.chunk.repo).toBe("oracles");
  });

  it("leaves no tmp file behind (atomic write)", async () => {
    const path = join(tmp(), "kb.json");
    const store = new KnowledgeStore();
    store.replaceRepo("r", [ch("r#readme#0", "r", "text")]);
    await store.persist(path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("creates missing parent directories", async () => {
    const path = join(tmp(), "deep", "nested", "kb.json");
    const store = new KnowledgeStore();
    await store.persist(path);
    expect(existsSync(path)).toBe(true);
  });

  it("tolerates a missing file", () => {
    const store = new KnowledgeStore();
    expect(store.load(join(tmp(), "nope.json"))).toBe(false);
    expect(store.isEmpty()).toBe(true);
    expect(store.search("anything", 3)).toEqual([]);
  });

  it("tolerates a corrupt file", () => {
    const path = join(tmp(), "corrupt.json");
    writeFileSync(path, "definitely {{ not json", "utf8");
    const store = new KnowledgeStore();
    expect(store.load(path)).toBe(false);
    expect(store.isEmpty()).toBe(true);
  });

  it("skips malformed chunk entries but keeps valid ones", () => {
    const path = join(tmp(), "partial.json");
    const valid = ch("r#readme#0", "r", "valid entry text");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        chunks: [valid, { id: "broken" }, 42, null],
        seenReleases: ["r@v1", 7, null],
      }),
      "utf8",
    );
    const store = new KnowledgeStore();
    expect(store.load(path)).toBe(true);
    expect(store.chunkCount()).toBe(1);
    expect(store.hasSeenRelease("r@v1")).toBe(true);
    expect(store.seenReleaseCount()).toBe(1);
  });

  it("round-trips demoUrls in v2 persist format", async () => {
    const path = join(tmp(), "kb-v2.json");
    const store = new KnowledgeStore();
    store.replaceRepo("alien-monitor", [ch("alien-monitor#readme#0", "alien-monitor", "observatory")]);
    store.setDemoUrl("alien-monitor", "https://magic-ai-factory.com/monitor/");
    await store.persist(path);

    const loaded = new KnowledgeStore();
    expect(loaded.load(path)).toBe(true);
    expect(loaded.getDemoUrl("alien-monitor")).toBe("https://magic-ai-factory.com/monitor/");
    expect(loaded.allDemoUrls().size).toBe(1);
  });
});
