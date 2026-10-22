/**
 * Tests for src/keryx/blog.ts — the blog relay — with a fake feed and fake sinks (no network):
 * Atom parsing (entities, CDATA, rel=self skipped, foreign links refused), the first-poll baseline,
 * back-dated imports never posted, one post per poll oldest first, per-sink retry without double
 * posting, state surviving a restart, and the announcement fitting Bluesky's 300 graphemes.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlogHerald, parseAtomFeed } from "../src/keryx/blog.js";
import { Keryx } from "../src/keryx/index.js";
import type { Logger, SyndicationSink } from "../src/types.js";

const log: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => log };
const FEED = "https://blog.test/blog/feed.xml";
const NOW = Date.parse("2026-10-22T12:00:00Z");

function entry(slug: string, title: string, published: string, base = "https://blog.test/blog/"): string {
  return `<entry><title>${title}</title><link href="${base}${slug}/"/><id>${base}${slug}/</id>` +
    `<published>${published}</published><updated>${published}</updated><summary>s</summary></entry>`;
}

function feed(...entries: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>` +
    `<link href="https://blog.test/blog/"/><link rel="self" href="${FEED}"/>${entries.join("")}</feed>`;
}

function sink(name: string, failTimes = 0): SyndicationSink & { texts: string[] } {
  const texts: string[] = [];
  let failures = failTimes;
  return {
    name,
    texts,
    async post(text: string) {
      if (failures > 0) {
        failures--;
        throw new Error(`${name} down`);
      }
      texts.push(text);
    },
  };
}

function herald(xml: () => string, sinks: SyndicationSink[], dataDir: string, now = NOW): BlogHerald {
  return new BlogHerald({
    feedUrl: FEED,
    pollIntervalMin: 30,
    maxAgeHours: 72,
    maxPostsPerRun: 1,
    sinks,
    compose: (post) => `NEW ${post.title} ${post.url}`,
    dataDir,
    log,
    now: () => now,
    fetchFn: (async () => new Response(xml(), { status: 200 })) as typeof fetch,
  });
}

describe("parseAtomFeed", () => {
  it("reads title, link, id and date, decodes entities and CDATA, skips the self link", () => {
    const xml = feed(
      entry("a", "Tools &amp; &quot;agents&quot; &#8212; done", "2026-10-22T07:30:00Z"),
      entry("b", "<![CDATA[Raw <b>title</b>]]>", "2026-10-21T07:30:00Z"),
    );
    const posts = parseAtomFeed(xml, "https://blog.test/blog/");
    expect(posts.map((p) => p.title)).toEqual(['Tools & "agents" — done', "Raw <b>title</b>"]);
    expect(posts[0]!.url).toBe("https://blog.test/blog/a/");
    expect(posts[0]!.published).toBe("2026-10-22T07:30:00Z");
  });

  it("refuses entries that link outside the feed's directory or have no date", () => {
    const xml = feed(
      entry("x", "Elsewhere", "2026-10-22T07:30:00Z", "https://evil.test/"),
      entry("y", "No date", "not a date"),
      entry("z", "Fine", "2026-10-22T07:30:00Z"),
    );
    expect(parseAtomFeed(xml, "https://blog.test/blog/").map((p) => p.title)).toEqual(["Fine"]);
  });
});

describe("BlogHerald", () => {
  it("records old articles as a baseline and announces only fresh ones, one per poll, oldest first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keryx-blog-"));
    const xml = feed(
      entry("newest", "Newest", "2026-10-22T07:30:00Z"),
      entry("fresh", "Fresh", "2026-10-21T09:00:00Z"),
      entry("old", "Old", "2026-09-01T09:00:00Z"),
    );
    const bsky = sink("bluesky");
    const h = herald(() => xml, [bsky], dir);
    await h.pollOnce();
    expect(bsky.texts).toEqual(["NEW Fresh https://blog.test/blog/fresh/"]);
    await h.pollOnce();
    await h.pollOnce();
    expect(bsky.texts).toEqual([
      "NEW Fresh https://blog.test/blog/fresh/",
      "NEW Newest https://blog.test/blog/newest/",
    ]);
  });

  it("never posts a back-dated import that appears later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keryx-blog-"));
    let xml = feed(entry("one", "One", "2026-09-01T09:00:00Z"));
    const bsky = sink("bluesky");
    const h = herald(() => xml, [bsky], dir);
    await h.pollOnce();
    xml = feed(entry("imported", "Imported from elsewhere", "2026-08-15T09:00:00Z"), entry("one", "One", "2026-09-01T09:00:00Z"));
    await h.pollOnce();
    expect(bsky.texts).toEqual([]);
  });

  it("retries a failed sink without posting twice to the one that worked, and survives a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keryx-blog-"));
    const xml = feed(entry("p", "Post", "2026-10-22T07:30:00Z"));
    const bsky = sink("bluesky");
    const masto = sink("mastodon", 1);
    await herald(() => xml, [bsky, masto], dir).pollOnce();
    expect(bsky.texts).toHaveLength(1);
    expect(masto.texts).toHaveLength(0);
    // A new process reads the same state file.
    await herald(() => xml, [bsky, masto], dir).pollOnce();
    await herald(() => xml, [bsky, masto], dir).pollOnce();
    expect(bsky.texts).toHaveLength(1);
    expect(masto.texts).toHaveLength(1);
  });

  it("an unreachable feed changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keryx-blog-"));
    const bsky = sink("bluesky");
    const h = new BlogHerald({
      feedUrl: FEED, pollIntervalMin: 30, maxAgeHours: 72, maxPostsPerRun: 1, sinks: [bsky],
      compose: (p) => p.title, dataDir: dir, log, now: () => NOW,
      fetchFn: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    await h.pollOnce();
    expect(bsky.texts).toEqual([]);
  });
});

describe("Keryx.composeBlogPost", () => {
  const keryx = new Keryx({ sinks: [], links: { discordInvite: "d", telegramChannel: "t" } as never, log });

  it("keeps the whole title and link when they fit", () => {
    const url = "https://modelmarket.dev/blog/mcp-servers-edit-the-instructions-your-agent-reads-warden-018-shows-which-words-changed/";
    const text = keryx.composeBlogPost({ title: "MCP servers edit the instructions your agent reads. WARDEN 0.18 shows which words changed", url });
    expect(text).toBe(`✎ New on the blog: MCP servers edit the instructions your agent reads. WARDEN 0.18 shows which words changed\n${url}`);
  });

  it("shortens a long title, never the link, under 300 graphemes", () => {
    const url = "https://modelmarket.dev/blog/" + "a".repeat(150) + "/";
    const text = keryx.composeBlogPost({ title: "word ".repeat(80), url });
    expect([...text].length).toBeLessThanOrEqual(300);
    expect(text.endsWith(url)).toBe(true);
    expect(text).toContain("...");
  });
});
