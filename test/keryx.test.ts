/**
 * Tests for src/keryx — the herald — with fake fetchFn everywhere (no network,
 * no real accounts, POST-ONLY charter observed even in fixtures):
 * bluesky session + createRecord flow, byte-offset facets under emoji,
 * 300-grapheme truncation, 401 re-auth; mastodon status post + bearer header;
 * X OAuth 1.0a header (signature recomputed independently), intact JSON body,
 * 280 cap; dev.to deterministic monthly article (31-day release window, quiet
 * month publishes nothing, api-key header); Keryx fan-out fail-soft + audit;
 * armSinks secret-presence arming incl. the X_SYNDICATION opt-in gate.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DioscuriConfig } from "../src/config.js";
import { createBlueskySink } from "../src/keryx/bluesky.js";
import { createDevtoDigest } from "../src/keryx/devto.js";
import { armSinks, Keryx } from "../src/keryx/index.js";
import { createMastodonSink } from "../src/keryx/mastodon.js";
import { createXSink } from "../src/keryx/x.js";
import type {
  AuditEvent,
  AuditLog,
  CrossLinks,
  KnowledgeChunk,
  Logger,
  Mnemosyne,
  ReleaseEvent,
  SyndicationSink,
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

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15 → "June 2026"
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fake fetch plumbing
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const i = init ?? {};
    calls.push({ url, init: i });
    return handler(url, i, calls.length);
  }) as typeof fetch;
  return { fn, calls };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bluesky
// ---------------------------------------------------------------------------

describe("bluesky sink", () => {
  function sinkWith(handler: Parameters<typeof fakeFetch>[0]) {
    const { fn, calls } = fakeFetch(handler);
    const sink = createBlueskySink({
      identifier: "herald.bsky.social",
      appPassword: "app-pass-secret",
      log,
      fetchFn: fn,
    });
    return { sink, calls };
  }

  const happy = (url: string): Response =>
    url.endsWith("com.atproto.server.createSession")
      ? jsonRes({ accessJwt: "jwt-1", did: "did:plc:test" })
      : jsonRes({ uri: "at://did:plc:test/app.bsky.feed.post/1" });

  it("creates a session lazily, then posts a createRecord with the session did + jwt", async () => {
    const { sink, calls } = sinkWith(happy);
    await sink.post("Plain text post, no links.");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://bsky.social/xrpc/com.atproto.server.createSession");
    expect(bodyOf(calls[0]!)).toEqual({ identifier: "herald.bsky.social", password: "app-pass-secret" });

    expect(calls[1]!.url).toBe("https://bsky.social/xrpc/com.atproto.repo.createRecord");
    expect(headersOf(calls[1]!).Authorization).toBe("Bearer jwt-1");
    const body = bodyOf(calls[1]!);
    expect(body.repo).toBe("did:plc:test");
    expect(body.collection).toBe("app.bsky.feed.post");
    const record = body.record as { $type: string; text: string; createdAt: string };
    expect(record.$type).toBe("app.bsky.feed.post");
    expect(record.text).toBe("Plain text post, no links.");
    expect(Number.isFinite(Date.parse(record.createdAt))).toBe(true);

    // Session is cached: a second post adds only ONE more call.
    await sink.post("Second post.");
    expect(calls).toHaveLength(3);
  });

  it("computes BYTE offsets for link facets when emoji precede the URL", async () => {
    const { sink, calls } = sinkWith(happy);
    const text = "🔥🔥 check https://example.com now";
    await sink.post(text);

    const record = bodyOf(calls[1]!).record as {
      facets: { index: { byteStart: number; byteEnd: number }; features: { $type: string; uri: string }[] }[];
    };
    expect(record.facets).toHaveLength(1);
    const facet = record.facets[0]!;
    // "🔥" is 4 UTF-8 bytes but 2 UTF-16 units — char offsets would be wrong.
    const prefixBytes = Buffer.byteLength("🔥🔥 check ", "utf8");
    expect(prefixBytes).toBe(15);
    expect(facet.index.byteStart).toBe(prefixBytes);
    expect(facet.index.byteEnd).toBe(prefixBytes + Buffer.byteLength("https://example.com", "utf8"));
    expect(facet.features[0]!).toEqual({
      $type: "app.bsky.richtext.facet#link",
      uri: "https://example.com",
    });
  });

  it("truncates to the 300-grapheme limit on a sentence boundary before posting", async () => {
    const { sink, calls } = sinkWith(happy);
    await sink.post("A solid sentence about the forge. ".repeat(20)); // 680 chars

    const record = bodyOf(calls[1]!).record as { text: string };
    expect(record.text.length).toBeLessThanOrEqual(300);
    expect(record.text.endsWith("…")).toBe(true);
    expect(record.text.at(-2)).toBe("."); // cut fell on a sentence boundary
  });

  it("re-creates the session once on 401 and retries with the fresh jwt", async () => {
    let sessions = 0;
    const { sink, calls } = sinkWith((url, _init, n) => {
      if (url.endsWith("createSession")) {
        sessions += 1;
        return jsonRes({ accessJwt: `jwt-${sessions}`, did: "did:plc:test" });
      }
      return n === 2 ? jsonRes({ error: "ExpiredToken" }, 401) : jsonRes({ uri: "at://ok" });
    });
    await sink.post("Back from the dead.");

    expect(calls).toHaveLength(4); // session, 401 record, session, record
    expect(headersOf(calls[3]!).Authorization).toBe("Bearer jwt-2");
  });

  it("throws with a scrubbed message on failure — the app password never leaks", async () => {
    const { sink } = sinkWith(() => {
      throw new Error("connect refused while sending app-pass-secret");
    });
    await expect(sink.post("hi")).rejects.toThrow(/\*\*\*/);
    await expect(sink.post("hi")).rejects.not.toThrow(/app-pass-secret/);
  });
});

// ---------------------------------------------------------------------------
// Mastodon
// ---------------------------------------------------------------------------

describe("mastodon sink", () => {
  it("posts a public status with the bearer token", async () => {
    const { fn, calls } = fakeFetch(() => jsonRes({ id: "1" }));
    const sink = createMastodonSink({
      baseUrl: "https://mstdn.example/",
      accessToken: "masto-token",
      log,
      fetchFn: fn,
    });
    await sink.post("Hello fediverse.");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mstdn.example/api/v1/statuses");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headersOf(calls[0]!).Authorization).toBe("Bearer masto-token");
    expect(bodyOf(calls[0]!)).toEqual({ status: "Hello fediverse.", visibility: "public" });
  });

  it("caps at 500 chars on a sentence boundary", async () => {
    const { fn, calls } = fakeFetch(() => jsonRes({ id: "1" }));
    const sink = createMastodonSink({
      baseUrl: "https://mstdn.example",
      accessToken: "t",
      log,
      fetchFn: fn,
    });
    await sink.post("A proper sentence for the cap test. ".repeat(30));

    const status = bodyOf(calls[0]!).status as string;
    expect(status.length).toBeLessThanOrEqual(500);
    expect(status.endsWith("…")).toBe(true);
  });

  it("throws on non-2xx so the caller can log and skip", async () => {
    const { fn } = fakeFetch(() => jsonRes({ error: "nope" }, 422));
    const sink = createMastodonSink({ baseUrl: "https://m.e", accessToken: "t", log, fetchFn: fn });
    await expect(sink.post("x")).rejects.toThrow(/422/);
  });
});

// ---------------------------------------------------------------------------
// X (OAuth 1.0a)
// ---------------------------------------------------------------------------

const RFC3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function parseOAuthHeader(h: string): Record<string, string> {
  expect(h.startsWith("OAuth ")).toBe(true);
  const out: Record<string, string> = {};
  for (const part of h.slice("OAuth ".length).split(", ")) {
    const eq = part.indexOf("=");
    out[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(
      part.slice(eq + 1).replace(/^"|"$/g, ""),
    );
  }
  return out;
}

describe("x sink", () => {
  const CREDS = {
    apiKey: "ck-key",
    apiSecret: "ck-secret",
    accessToken: "at-token",
    accessSecret: "at-secret",
  };

  it("sends an OAuth1.0a header whose HMAC-SHA1 signature verifies, body {text} intact", async () => {
    const { fn, calls } = fakeFetch(() => jsonRes({ data: { id: "1" } }, 201));
    const sink = createXSink({ ...CREDS, log, fetchFn: fn });
    const text = "One tweet with a link https://github.com/alexar76 in it!";
    await sink.post(text);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.x.com/2/tweets");
    expect(bodyOf(calls[0]!)).toEqual({ text }); // JSON body untouched by signing

    const p = parseOAuthHeader(headersOf(calls[0]!).Authorization!);
    expect(p.oauth_consumer_key).toBe(CREDS.apiKey);
    expect(p.oauth_token).toBe(CREDS.accessToken);
    expect(p.oauth_signature_method).toBe("HMAC-SHA1");
    expect(p.oauth_version).toBe("1.0");
    expect(p.oauth_nonce!.length).toBeGreaterThanOrEqual(16);
    expect(p.oauth_signature!.length).toBeGreaterThan(0);

    // Recompute the signature independently: oauth params only, sorted,
    // RFC3986-encoded — the JSON body is NOT part of the base string.
    const paramString = Object.entries(p)
      .filter(([k]) => k !== "oauth_signature")
      .map(([k, v]) => `${RFC3986(k)}=${RFC3986(v)}`)
      .sort()
      .join("&");
    const base = `POST&${RFC3986("https://api.x.com/2/tweets")}&${RFC3986(paramString)}`;
    const key = `${RFC3986(CREDS.apiSecret)}&${RFC3986(CREDS.accessSecret)}`;
    const expected = createHmac("sha1", key).update(base).digest("base64");
    expect(p.oauth_signature).toBe(expected);
  });

  it("caps at 280 chars on a sentence boundary", async () => {
    const { fn, calls } = fakeFetch(() => jsonRes({ data: { id: "1" } }, 201));
    const sink = createXSink({ ...CREDS, log, fetchFn: fn });
    await sink.post("Sentence for the strict bird cap. ".repeat(20));

    const text = bodyOf(calls[0]!).text as string;
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text.endsWith("…")).toBe(true);
  });

  it("throws on non-2xx and scrubs secrets from network errors", async () => {
    const { fn } = fakeFetch(() => jsonRes({ detail: "dup" }, 403));
    const sink = createXSink({ ...CREDS, log, fetchFn: fn });
    await expect(sink.post("x")).rejects.toThrow(/403/);

    const { fn: failing } = fakeFetch(() => {
      throw new Error("dns exploded carrying at-secret somehow");
    });
    const sink2 = createXSink({ ...CREDS, log, fetchFn: failing });
    await expect(sink2.post("x")).rejects.not.toThrow(/at-secret/);
  });
});

// ---------------------------------------------------------------------------
// dev.to monthly digest
// ---------------------------------------------------------------------------

function chunk(over: Partial<KnowledgeChunk>): KnowledgeChunk {
  return {
    id: "argus#release#0",
    repo: "argus",
    source: "release",
    title: "v1.2.0",
    url: "https://github.com/alexar76/argus/releases/v1.2.0",
    text: "WARDEN firewall shipped. It scores every MCP call. A third sentence nobody needs.",
    updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    ...over,
  };
}

function kbWith(releaseHits: KnowledgeChunk[], docHits: KnowledgeChunk[] = []): Mnemosyne {
  return {
    search: (q: string) => (q.includes("recent") ? docHits : releaseHits).map((c) => ({ chunk: c, score: 1 })),
    stats: () => ({ chunks: 0, repos: 0, lastSyncAt: null, lastSyncOk: true }),
    onRelease: () => {},
    syncOnce: async () => {},
    start: () => {},
    stop: () => {},
  };
}

describe("dev.to digest", () => {
  it("builds the article from <=31d release chunks only, with commits capped at 8", async () => {
    const commits = Array.from({ length: 10 }, (_, i) => `- c${i + 1} commit ${i + 1} message`).join("\n");
    const kb = kbWith(
      [
        chunk({}),
        chunk({
          id: "oldrepo#release#0",
          repo: "oldrepo",
          title: "v0.0.9",
          text: "Ancient history.",
          updatedAt: new Date(NOW - 40 * DAY).toISOString(),
        }),
        chunk({ id: "docs#readme#0", repo: "docsrepo", source: "readme", text: "Not a release." }),
      ],
      [chunk({ id: "argus#doc#0", source: "doc", title: "argus recent changes", text: commits })],
    );
    const { fn, calls } = fakeFetch(() => jsonRes({ id: 1 }, 201));
    const digest = createDevtoDigest({ apiKey: "devto-key", kb, links: LINKS, log, fetchFn: fn });

    await expect(digest.publishMonthly(new Date(NOW))).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://dev.to/api/articles");
    expect(headersOf(calls[0]!)["api-key"]).toBe("devto-key");
    expect(headersOf(calls[0]!).accept).toBe("application/vnd.forem.api-v1+json");

    const article = bodyOf(calls[0]!).article as {
      title: string;
      published: boolean;
      body_markdown: string;
      tags: string[];
    };
    expect(article.title).toBe("This month in the AICOM forge — June 2026");
    expect(article.published).toBe(true);
    expect(article.tags).toEqual(["ai", "opensource", "agents", "showcase"]);

    const md = article.body_markdown;
    expect(md).toContain("## argus");
    expect(md).toContain("**v1.2.0**");
    expect(md).toContain("WARDEN firewall shipped. It scores every MCP call.");
    expect(md).not.toContain("A third sentence"); // only the first 2 sentences
    expect(md).toContain(chunk({}).url);
    expect(md).not.toContain("oldrepo"); // outside the 31-day window
    expect(md).not.toContain("Not a release."); // wrong source
    expect(md).toContain("commit 8 message");
    expect(md).not.toContain("commit 9 message"); // max 8 bullets
    // Intro + footer carry the community links and the provenance line.
    expect(md).toContain(LINKS.discordInvite);
    expect(md).toContain(LINKS.telegramChannel);
    expect(md).toContain(LINKS.siteUrl);
    expect(md).toContain(LINKS.githubOrg);
    expect(md).toContain("Written by DIOSCURI, the twin community agents");
  });

  it("a quiet month publishes nothing: returns false without any fetch call", async () => {
    const kb = kbWith([
      chunk({ id: "oldrepo#release#0", repo: "oldrepo", updatedAt: new Date(NOW - 40 * DAY).toISOString() }),
    ]);
    const { fn, calls } = fakeFetch(() => jsonRes({ id: 1 }, 201));
    const digest = createDevtoDigest({ apiKey: "k", kb, links: LINKS, log, fetchFn: fn });

    await expect(digest.publishMonthly(new Date(NOW))).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fail-soft: an API error returns false instead of throwing", async () => {
    const { fn } = fakeFetch(() => jsonRes({ error: "unauthorized" }, 401));
    const digest = createDevtoDigest({ apiKey: "k", kb: kbWith([chunk({})]), links: LINKS, log, fetchFn: fn });
    await expect(digest.publishMonthly(new Date(NOW))).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keryx fan-out
// ---------------------------------------------------------------------------

function fakeSink(name: string, fail = false): { sink: SyndicationSink; posts: string[] } {
  const posts: string[] = [];
  return {
    posts,
    sink: {
      name,
      post: async (t: string) => {
        if (fail) throw new Error(`${name} exploded`);
        posts.push(t);
      },
    },
  };
}

function fakeAudit(): { audit: AuditLog; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    audit: {
      append: async (ev) => {
        events.push(ev);
        return { ...ev, hash: "h", prevHash: "p" };
      },
      verify: async () => -1,
    },
  };
}

const RELEASE: ReleaseEvent = {
  repo: "argus",
  tag: "v1.2.0",
  name: "v1.2.0",
  url: "https://github.com/alexar76/argus/releases/v1.2.0",
  summary: "WARDEN shipped for @everyone out there. Second sentence with details.",
  publishedAt: new Date(NOW).toISOString(),
};

describe("Keryx.announceRelease", () => {
  it("strips markdown release notes to a short plain blurb", async () => {
    const a = fakeSink("a");
    const keryx = new Keryx({ sinks: [a.sink], links: LINKS, log });
    await keryx.announceRelease({
      ...RELEASE,
      repo: "aimarket-agent",
      tag: "v0.1.0",
      summary:
        "## AIMarket Agent (Python client) v0.1.0 (early)\n\n**What works today**\n- Python client for discovering and invoking hub capabilities\n- pytest CI on GitHub Actions",
    });
    const text = a.posts[0]!;
    expect(text).toContain("aimarket-agent v0.1.0 shipped — AIMarket Agent (Python client) v0.1.0 (early)");
    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).not.toContain("pytest CI");
  });

  it("posts one herald text to every sink: repo, tag, url, both community links, no @everyone", async () => {
    const a = fakeSink("a");
    const b = fakeSink("b");
    const keryx = new Keryx({ sinks: [a.sink, b.sink], links: LINKS, log });
    await keryx.announceRelease(RELEASE);

    expect(a.posts).toHaveLength(1);
    expect(b.posts).toEqual(a.posts); // same composed text everywhere
    const text = a.posts[0]!;
    expect(text).toContain("argus");
    expect(text).toContain("v1.2.0");
    expect(text).toContain(RELEASE.url);
    expect(text).toContain(LINKS.discordInvite);
    expect(text).toContain(LINKS.telegramChannel);
    expect(text).toContain("WARDEN shipped");
    expect(text).not.toContain("Second sentence"); // only the first sentence
    expect(text).not.toContain("@everyone"); // neutralised
    expect(text).toContain("everyone");
  });

  it("fail-soft fan-out: a failing sink is skipped, later sinks still post, audit logs successes", async () => {
    const a = fakeSink("a");
    const b = fakeSink("b", true);
    const c = fakeSink("c");
    const { audit, events } = fakeAudit();
    const keryx = new Keryx({ sinks: [a.sink, b.sink, c.sink], links: LINKS, log, audit });

    await expect(keryx.announceRelease(RELEASE)).resolves.toBeUndefined(); // never throws
    expect(a.posts).toHaveLength(1);
    expect(c.posts).toHaveLength(1);

    expect(events).toHaveLength(2); // successes only
    expect(events.map((e) => e.subject)).toEqual(["a", "c"]);
    for (const ev of events) {
      expect(ev.kind).toBe("keryx.post");
      expect(ev.platform).toBe("system");
      expect(ev.actor).toBe("keryx");
      expect(ev.data).toEqual({ repo: "argus", tag: "v1.2.0" });
    }
  });

  it("a failing audit log does not break the fan-out either", async () => {
    const a = fakeSink("a");
    const audit: AuditLog = {
      append: async () => {
        throw new Error("disk full");
      },
      verify: async () => -1,
    };
    const keryx = new Keryx({ sinks: [a.sink], links: LINKS, log, audit });
    await expect(keryx.announceRelease(RELEASE)).resolves.toBeUndefined();
    expect(a.posts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// armSinks
// ---------------------------------------------------------------------------

type SyndicationSecrets = DioscuriConfig["syndication"];

function emptySecrets(): SyndicationSecrets {
  return {
    bluesky: { identifier: "", appPassword: "" },
    mastodon: { baseUrl: "", accessToken: "" },
    x: { enabled: false, apiKey: "", apiSecret: "", accessToken: "", accessSecret: "" },
    devto: { apiKey: "" },
  };
}

const X_SECRETS = { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "as" };

describe("armSinks", () => {
  it("arms nothing when no secrets are present", () => {
    expect(armSinks(emptySecrets(), log)).toHaveLength(0);
  });

  it("arms bluesky and mastodon from their secret pairs", () => {
    const cfg = emptySecrets();
    cfg.bluesky = { identifier: "herald.bsky.social", appPassword: "pw" };
    cfg.mastodon = { baseUrl: "https://mstdn.example", accessToken: "tok" };
    expect(armSinks(cfg, log).map((s) => s.name)).toEqual(["bluesky", "mastodon"]);
  });

  it("half a secret pair arms nothing", () => {
    const cfg = emptySecrets();
    cfg.bluesky = { identifier: "herald.bsky.social", appPassword: "" };
    cfg.mastodon = { baseUrl: "", accessToken: "tok" };
    expect(armSinks(cfg, log)).toHaveLength(0);
  });

  it("x refuses to arm without the X_SYNDICATION opt-in even with all four secrets", () => {
    const cfg = emptySecrets();
    cfg.x = { enabled: false, ...X_SECRETS };
    expect(armSinks(cfg, log)).toHaveLength(0);
  });

  it("x arms with the opt-in AND all four secrets — a missing one refuses", () => {
    const cfg = emptySecrets();
    cfg.x = { enabled: true, ...X_SECRETS };
    expect(armSinks(cfg, log).map((s) => s.name)).toEqual(["x"]);

    cfg.x = { enabled: true, ...X_SECRETS, accessSecret: "" };
    expect(armSinks(cfg, log)).toHaveLength(0);
  });
});
