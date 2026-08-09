/**
 * BULLETIN publisher — the fail-closed path, the no-exploit path, the no-spam path.
 *
 * The tests that matter most here are not the happy ones:
 *
 *  - a TAMPERED, WRONG-KEY or STALE index must post NOTHING (posting an
 *    unverified advisory under our own community bot would let whoever controls
 *    the network path publish accusations in our name);
 *  - an `open` advisory whose payload maliciously carries a reproducer must not
 *    publish it — this is the test that stops us shipping an exploit through the
 *    community bot;
 *  - a hostile summary (markdown, @everyone, zero-width, bidi override) must come
 *    out neutralised;
 *  - a second run must post nothing, so a restart never re-announces the backlog.
 */

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BulletinPublisher,
  canonicalize,
  renderAdvisory,
  verifyBulletinPayload,
  type Advisory,
  type BulletinSink,
  type RenderedAdvisory,
} from "../src/bulletin/index.js";
import { defangLinks, neutraliseTracked } from "../src/bulletin/render.js";
import type { Logger } from "../src/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

interface LogLine {
  level: string;
  msg: string;
  extra: Record<string, unknown>;
}

/**
 * A logger that keeps every line, including the ones written by child scopes.
 *
 * A refusal that is silent is a refusal nobody can operate: if MOMUS ever starts
 * publishing text this bot will not repeat, the only way anyone finds out is the
 * log line. So the log is part of the contract, and is asserted like one.
 */
function capturingLogger(): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const make = (): Logger => ({
    debug: (msg, extra) => lines.push({ level: "debug", msg, extra: extra ?? {} }),
    info: (msg, extra) => lines.push({ level: "info", msg, extra: extra ?? {} }),
    warn: (msg, extra) => lines.push({ level: "warn", msg, extra: extra ?? {} }),
    error: (msg, extra) => lines.push({ level: "error", msg, extra: extra ?? {} }),
    child: () => make(),
  });
  return { log: make(), lines };
}

const INDEX_URL = "https://momus.example.test/bulletin";
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);

/** The publisher's key pair, and a stranger's — the "wrong key" case. */
const publisher = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");

function pinOf(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("hex");
}

/** Sign an index the way MOMUS does: Ed25519 over JCS({advisories, timestamp}). */
function signedIndex(
  advisories: unknown[],
  opts: { timestamp?: number; key?: KeyObject } = {},
): string {
  const timestamp = opts.timestamp ?? NOW - 60_000;
  const canonical = canonicalize({ advisories, timestamp });
  const signature = sign(null, Buffer.from(canonical, "utf8"), opts.key ?? publisher.privateKey).toString("hex");
  return JSON.stringify({ advisories, timestamp, signature });
}

/**
 * A published advisory as MOMUS's `advisories` table describes it, plus whatever
 * extra keys a caller wants to smuggle in.
 */
function advisoryPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    advisory_id: "MOMUS-2026-0007",
    status: "open",
    severity: "high",
    component: "aimarket-hub",
    summary: "The paid invoke path accepts a forged escrow reference under some conditions.",
    url: "https://momus.example.test/bulletin/MOMUS-2026-0007",
    published: "2026-08-07T09:00:00Z",
    modified: "2026-08-07T09:00:00Z",
    ...extra,
  };
}

interface Recorder extends BulletinSink {
  readonly sent: RenderedAdvisory[];
}

function recorder(name: string, fail = false): Recorder {
  const sent: RenderedAdvisory[] = [];
  return {
    name,
    sent,
    post: async (rendered) => {
      if (fail) throw new Error("platform unavailable");
      sent.push(rendered);
      return `${name}-msg-${sent.length}`;
    },
  };
}

/** fetch stub serving one body; `bodies` may serve a different body per call. */
function serve(...bodies: string[]): { fetchFn: typeof fetch; calls: () => number } {
  let call = 0;
  const fetchFn = (async () => {
    const body = bodies[Math.min(call, bodies.length - 1)]!;
    call++;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => call };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dioscuri-bulletin-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function publisherWith(
  body: string | string[],
  opts: {
    sinks?: BulletinSink[];
    pin?: string;
    maxAgeMs?: number;
    writeupBaseUrl?: string;
    maxPostsPerRun?: number;
    dir?: string;
    log?: Logger;
  } = {},
): { pub: BulletinPublisher; discord: Recorder; telegram: Recorder } {
  const discord = recorder("discord");
  const telegram = recorder("telegram");
  const bodies = Array.isArray(body) ? body : [body];
  const pub = new BulletinPublisher({
    indexUrl: INDEX_URL,
    publicKeyHex: opts.pin ?? pinOf(publisher.publicKey),
    sinks: opts.sinks ?? [discord, telegram],
    dataDir: opts.dir ?? dataDir,
    log: opts.log ?? noopLogger,
    now: () => NOW,
    fetchFn: serve(...bodies).fetchFn,
    ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
    ...(opts.writeupBaseUrl !== undefined ? { writeupBaseUrl: opts.writeupBaseUrl } : {}),
    ...(opts.maxPostsPerRun !== undefined ? { maxPostsPerRun: opts.maxPostsPerRun } : {}),
  });
  return { pub, discord, telegram };
}

/** Everything a sink actually put in front of the community, as one string. */
function everythingPosted(sink: Recorder): string {
  return sink.sent.map((r) => JSON.stringify(r)).join("\n");
}

/** Our own header phrase — the thing a forged second header has to reproduce. */
const HEADER_MARKER = "MOMUS security bulletin";

/**
 * Every run of text a client would turn into a link, whether or not it has a
 * scheme: Discord auto-links bare urls in embed descriptions and field values,
 * and Telegram builds url entities out of scheme-less hosts like `evil.example/x`.
 * Deliberately GREEDIER than either platform — a test that models linkification
 * more narrowly than the clients do is a test that passes the day one of them
 * gets more eager.
 */
const LINKIFIABLE_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|(?:[\p{L}\p{N}][\p{L}\p{N}-]*\.)+\p{L}{2,24})/giu;

/** Every message surface of one rendered advisory, named for the failure message. */
function surfaces(rendered: RenderedAdvisory): [string, string][] {
  const { content, embed } = rendered.discord;
  return [
    ["discord.content", content],
    ["discord.title", embed.title],
    ["discord.description", embed.description],
    ["discord.footer", embed.footer],
    ...embed.fields.map((f): [string, string] => [`discord.field:${f.name}`, `${f.name} ${f.value}`]),
    ["telegram", rendered.telegram],
  ];
}

/**
 * Assert that the ONLY linkifiable text anywhere in a rendered advisory is the
 * allow-listed advisory url — i.e. that nothing the feed wrote can be tapped.
 *
 * The allow-listed url is subtracted rather than skipped so a hostile string
 * hiding behind it (`https://ok.example/x evil.example/y`) still shows up.
 */
function assertNoLinksExcept(rendered: RenderedAdvisory, allowed: string[]): void {
  for (const [where, text] of surfaces(rendered)) {
    let remaining = text;
    for (const url of allowed) remaining = remaining.split(url).join(" ");
    const found = remaining.match(LINKIFIABLE_RE) ?? [];
    expect(found, `linkifiable text in ${where}: ${found.join(", ")}`).toEqual([]);
  }
}

/** How many times `needle` occurs in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// The wire contract: our canonical bytes must be MOMUS's canonical bytes
// ---------------------------------------------------------------------------

describe("RFC 8785 canonical form (cross-implementation)", () => {
  /**
   * PINNED OUTPUT of the PUBLISHER's own canonicalizer — the `jcs()` function in
   * `momus/momus/warden_feed.py`, run over the payload below. src/bulletin/jcs.ts
   * is a deliberate copy of ARGUS's module (see its header), and a copy is only
   * safe while it stays byte-compatible: the signature is over these exact bytes,
   * so any drift shows up as "signature INVALID" in production — which reads like
   * an attack, not like a refactor.
   *
   * The fixture deliberately exercises what usually diverges between two
   * implementations: key sort order including a non-ASCII key ("ä" after "zz",
   * because JCS sorts UTF-16 code units, not alphabetically), uppercase before
   * lowercase, raw non-ASCII and astral-plane characters left unescaped, the
   * two-character escapes, and -0 rendering as "0".
   */
  const PAYLOAD_FROM_PUBLISHER =
    '{"advisories": [{"advisory_id": "MOMUS-2026-0007", "status": "open", "severity": "high", ' +
    '"component": "aimarket-hub", "summary": "\\u00dcnicode \\u2713 \\"quoted\\" and \\\\ ' +
    'backslash\\nnewline\\ttab \\u00e9\\u0301 \\ud83d\\ude00", "url": "https://momus.example.test/b/1", ' +
    '"published": "2026-08-07T09:00:00Z", "modified": "2026-08-07T09:00:00Z"}, ' +
    '{"zz": 1, "aa": [true, false, null, -0, 42], "\\u00e4": "umlaut key", "a": "plain", ' +
    '"A": "upper"}], "timestamp": 1754648400000}';

  const CANONICAL_FROM_PUBLISHER =
    '{"advisories":[{"advisory_id":"MOMUS-2026-0007","component":"aimarket-hub",' +
    '"modified":"2026-08-07T09:00:00Z","published":"2026-08-07T09:00:00Z","severity":"high",' +
    '"status":"open","summary":"Ünicode ✓ \\"quoted\\" and \\\\ backslash\\nnewline\\ttab é́ 😀",' +
    '"url":"https://momus.example.test/b/1"},{"A":"upper","a":"plain","aa":[true,false,null,0,42],' +
    '"zz":1,"ä":"umlaut key"}],"timestamp":1754648400000}';

  it("reproduces the publisher's bytes exactly", () => {
    expect(canonicalize(JSON.parse(PAYLOAD_FROM_PUBLISHER))).toBe(CANONICAL_FROM_PUBLISHER);
  });

  it("verifies an index signed over those bytes", () => {
    const parsed = JSON.parse(PAYLOAD_FROM_PUBLISHER) as { advisories: unknown[]; timestamp: number };
    const signature = sign(
      null,
      Buffer.from(CANONICAL_FROM_PUBLISHER, "utf8"),
      publisher.privateKey,
    ).toString("hex");
    const result = verifyBulletinPayload(
      JSON.stringify({ ...parsed, signature }),
      { publicKeyHex: pinOf(publisher.publicKey), now: () => parsed.timestamp + 1000 },
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verification: the gate
// ---------------------------------------------------------------------------

describe("bulletin verification", () => {
  it("posts the advisories of a VALID signed index", async () => {
    const { pub, discord, telegram } = publisherWith(signedIndex([advisoryPayload()]));

    const result = await pub.runOnce();

    expect(result.refused).toBeUndefined();
    expect(result.posted).toBe(1);
    expect(discord.sent).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
    const [posted] = discord.sent;
    expect(posted!.advisoryId).toBe("MOMUS-2026-0007");
    expect(posted!.discord.embed.title).toContain("MOMUS-2026-0007");
    expect(posted!.discord.embed.title).toContain("OPEN");
    expect(posted!.telegram).toContain("MOMUS-2026-0007");
  });

  it("posts NOTHING when the index was TAMPERED with after signing", async () => {
    const valid = signedIndex([advisoryPayload()]);
    // Same signature, edited advisory — the canonical bytes no longer match.
    const tampered = valid.replace("aimarket-hub", "aimarket-hubb");
    expect(tampered).not.toBe(valid);
    const { pub, discord, telegram } = publisherWith(tampered);

    const result = await pub.runOnce();

    expect(result.refused).toBe("SIGNATURE_INVALID");
    expect(result.posted).toBe(0);
    expect(discord.sent).toHaveLength(0);
    expect(telegram.sent).toHaveLength(0);
  });

  it("posts NOTHING when the index is signed by the WRONG key", async () => {
    const body = signedIndex([advisoryPayload()], { key: stranger.privateKey });
    const { pub, discord, telegram } = publisherWith(body);

    const result = await pub.runOnce();

    expect(result.refused).toBe("SIGNATURE_INVALID");
    expect(discord.sent).toHaveLength(0);
    expect(telegram.sent).toHaveLength(0);
  });

  it("posts NOTHING for a STALE index, even with a perfect signature", async () => {
    // Correctly signed, but 48 h old: a replayed snapshot hides newer advisories.
    const body = signedIndex([advisoryPayload()], { timestamp: NOW - 48 * 60 * 60 * 1000 });
    const { pub, discord } = publisherWith(body);

    const result = await pub.runOnce();

    expect(result.refused).toBe("STALE");
    expect(discord.sent).toHaveLength(0);
  });

  it("posts NOTHING when no publisher key is pinned", async () => {
    const { pub, discord } = publisherWith(signedIndex([advisoryPayload()]), { pin: "" });

    const result = await pub.runOnce();

    expect(result.refused).toBe("NO_PUBKEY");
    expect(discord.sent).toHaveLength(0);
  });

  it("never throws when the feed is unreachable", async () => {
    const discord = recorder("discord");
    const pub = new BulletinPublisher({
      indexUrl: INDEX_URL,
      publicKeyHex: pinOf(publisher.publicKey),
      sinks: [discord],
      dataDir,
      log: noopLogger,
      now: () => NOW,
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(pub.runOnce()).resolves.toMatchObject({ refused: "FETCH_FAILED", posted: 0 });
    expect(discord.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Disclosure: an open advisory carries no exploit
// ---------------------------------------------------------------------------

describe("open advisory disclosure", () => {
  it("publishes no reproducer even when the payload maliciously includes one", async () => {
    // A signed index whose `open` advisory smuggles actionable attack detail. The
    // signature is VALID: the point is that authenticity is not authorisation to
    // repeat everything a publisher sends.
    const body = signedIndex([
      advisoryPayload({
        reproducer: "curl -X POST https://target.example/invoke -d '{\"escrow\":\"0xdeadbeef\"}'",
        proof_of_concept: "POST /v1/invoke with escrow=0xdeadbeef returns 200",
        evidence: "PAYLOAD-LEAK-EVIDENCE: response carried the operator's payout address",
        target_url: "https://target.example/internal/invoke",
        exploit: "SMUGGLED-EXPLOIT-STRING",
      }),
    ]);
    const { pub, discord, telegram } = publisherWith(body);

    await pub.runOnce();

    expect(discord.sent).toHaveLength(1);
    // Assert on the smuggled VALUES: the words "reproducer"/"evidence" legitimately
    // appear in our own notice explaining that an open advisory carries neither.
    for (const sink of [discord, telegram]) {
      const output = everythingPosted(sink);
      expect(output).not.toContain("curl -X POST");
      expect(output).not.toContain("0xdeadbeef");
      expect(output).not.toContain("target.example");
      expect(output).not.toContain("PAYLOAD-LEAK-EVIDENCE");
      expect(output).not.toContain("SMUGGLED-EXPLOIT-STRING");
      expect(output).not.toContain("POST /v1/invoke");
      // No smuggled key becomes a rendered label either.
      expect(output).not.toMatch(/reproducer"?\s*[:=]/i);
      expect(output).not.toMatch(/proof_of_concept/i);
      expect(output).not.toMatch(/target_url/i);
    }
    // ...and it says out loud WHY the post is thin, so nobody goes hunting.
    expect(discord.sent[0]!.discord.embed.description).toMatch(/non-actionable/i);
    expect(telegram.sent[0]!.telegram).toMatch(/non-actionable/i);
  });

  it("drops an advisory link that points off the index's own origin", async () => {
    const body = signedIndex([
      advisoryPayload({ url: "https://phishing.example/momus/MOMUS-2026-0007" }),
    ]);
    const { pub, discord } = publisherWith(body);

    await pub.runOnce();

    const output = everythingPosted(discord);
    expect(output).not.toContain("phishing.example");
    expect(discord.sent[0]!.discord.embed.url).toBeUndefined();
  });

  it("gives each status a visually distinct badge and colour", () => {
    const base: Advisory = {
      id: "MOMUS-2026-0001",
      status: "open",
      severity: "critical",
      component: "hub",
      summary: "s",
      url: "",
      published: "2026-01-01T00:00:00Z",
      modified: "2026-01-01T00:00:00Z",
    };
    const open = renderAdvisory(base, "new");
    const fixed = renderAdvisory({ ...base, status: "fixed" }, "new");
    const withdrawn = renderAdvisory({ ...base, status: "withdrawn" }, "new");

    const colors = [open, fixed, withdrawn].map((r) => r.discord.embed.color);
    expect(new Set(colors).size).toBe(3);
    expect(open.discord.embed.title).toContain("OPEN");
    expect(fixed.discord.embed.title).toContain("FIXED");
    expect(withdrawn.discord.embed.title).toContain("WITHDRAWN");
    // Only an open advisory carries the non-actionable notice.
    expect(fixed.discord.embed.description).not.toMatch(/non-actionable/i);
  });
});

// ---------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------

describe("hostile advisory text", () => {
  const HOSTILE =
    "**pwn** @everyone _now_ ​zero​width ‮reversed‬ `code` " +
    "[click](https://evil.example) <@1234567890> ~~strike~~ ||spoiler||";

  /** Zero-width, bidi-override, word-joiner, BOM — the invisible smuggling set. */
  const INVISIBLES = /[​-‏‪-‮⁠﻿]/;

  it("has a fixture that really does contain the invisible characters", () => {
    // Guard the guard: if the literals below were lost to an editor or a copy-paste,
    // the "no invisibles in the output" assertion would pass for the wrong reason.
    expect(INVISIBLES.test(HOSTILE)).toBe(true);
    expect(HOSTILE).toContain("​");
    expect(HOSTILE).toContain("‮");
  });

  it("neutralises markdown, mentions, zero-width and bidi characters", async () => {
    const body = signedIndex([advisoryPayload({ summary: HOSTILE })]);
    const { pub, discord, telegram } = publisherWith(body);

    await pub.runOnce();

    const description = discord.sent[0]!.discord.embed.description;
    const telegramText = telegram.sent[0]!.telegram;

    for (const text of [description, telegramText]) {
      // Invisible smuggling characters are gone entirely.
      expect(text).not.toMatch(INVISIBLES);
      // No live mass mention survives.
      expect(text).not.toContain("@everyone");
      expect(text).toContain("everyone");
      // Numeric mention tokens do not survive either.
      expect(text).not.toContain("<@1234567890>");
    }

    // Discord: markdown is DEFUSED BY FENCING, not by escaping. Inside a code
    // fence nothing is parsed, so the advisory's words are shown exactly as it
    // wrote them — no hedge of backslashes, and no bare url left live either
    // (escaping used to leave those clickable, which was the phishing bug).
    expect(description).toContain(
      "```\n**pwn** everyone _now_ zerowidth reversed `code` " +
        "[click](https[:]//evil[.]example) [mention removed] ~~strike~~ ||spoiler||\n```",
    );
    expect(description).not.toContain("\\*\\*");
    expect(description).not.toContain("https://evil.example");

    // Telegram is sent with no parse_mode, so the text stays literal and unescaped
    // on one sigil-marked line that our header sits outside of.
    expect(telegramText).toContain(
      "| **pwn** everyone _now_ zerowidth reversed `code` " +
        "[click](https[:]//evil[.]example) [mention removed] ~~strike~~ ||spoiler||",
    );
    expect(telegramText).not.toContain("\\*\\*");
    expect(telegramText).not.toContain("https://evil.example");
  });

  it("refuses an advisory whose id or status is not something we can render honestly", async () => {
    const body = signedIndex([
      advisoryPayload({ advisory_id: "MOMUS-2026-0007 <script>alert(1)</script>" }),
      advisoryPayload({ advisory_id: "MOMUS-2026-0008", status: "probably-fixed" }),
      advisoryPayload({ advisory_id: "MOMUS-2026-0009" }),
    ]);
    const { pub, discord } = publisherWith(body);

    const result = await pub.runOnce();

    // Only the well-formed one is announced; the other two are dropped, not guessed.
    expect(result.posted).toBe(1);
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0]!.advisoryId).toBe("MOMUS-2026-0009");
  });

  it("keeps the non-actionable notice even when the summary is enormous", async () => {
    // A hostile publisher could try to push our own safety notice off the end of
    // the embed by padding the summary with markdown that doubles under escaping.
    const body = signedIndex([advisoryPayload({ summary: "*".repeat(4000) })]);
    const { pub, discord } = publisherWith(body);

    await pub.runOnce();

    const description = discord.sent[0]!.discord.embed.description;
    expect(description).toMatch(/non-actionable/i);
    expect(description.length).toBeLessThanOrEqual(1800);
    // No half-finished escape pair left at the truncation point.
    expect(description).not.toMatch(/(^|[^\\])(\\\\)*\\…/);
  });

  it("never echoes an unrecognised severity string", async () => {
    const body = signedIndex([advisoryPayload({ severity: "APOCALYPTIC @everyone" })]);
    const { pub, discord } = publisherWith(body);

    await pub.runOnce();

    const output = everythingPosted(discord);
    expect(output).not.toContain("APOCALYPTIC");
    expect(output).toContain("UNSPECIFIED");
  });
});

// ---------------------------------------------------------------------------
// The phishing vector: a link the feed wrote, and a header the feed forged
// ---------------------------------------------------------------------------

/**
 * These two defects were found together, and together they are the whole attack:
 * a summary that forges a second `🟢 … FIXED …` header carrying a clickable
 * "patch" link, published under our own bot's name in a channel the community
 * trusts precisely because we sign it. Either half alone is bad; the pair is a
 * working phishing post, which is why the channel is worse than no channel until
 * both are closed.
 *
 * The invariant these tests defend: the allow-listed `url` FIELD is the ONLY way
 * a live link reaches the channel, and our header is the only header.
 */
describe("feed text can never become a clickable link", () => {
  /** The payload from the review, verbatim. */
  const PHISHING_SUMMARY = "Mitigation guidance: https://phishing.evil.example/momus-fix";
  /** …and exactly how it must come out: readable, searchable, inert. */
  const DEFANGED = "Mitigation guidance: https[:]//phishing[.]evil[.]example/momus-fix";
  const LEGIT_URL = "https://momus.example.test/bulletin/MOMUS-2026-0007";

  it("de-fangs and fences a url smuggled through the summary, on both sinks", async () => {
    const body = signedIndex([advisoryPayload({ summary: PHISHING_SUMMARY })]);
    const { pub, discord, telegram } = publisherWith(body);

    await pub.runOnce();

    // Discord: the feed's words verbatim inside a fence — auto-linking off twice
    // over (no live scheme to match, and nothing inside a fence is linkified).
    expect(discord.sent[0]!.discord.embed.description).toContain(`\`\`\`\n${DEFANGED}\n\`\`\``);
    // Telegram: the same words on one sigil-marked line, below our header.
    expect(telegram.sent[0]!.telegram).toContain(`| ${DEFANGED}`);

    for (const sink of [discord, telegram]) {
      const output = everythingPosted(sink);
      expect(output).not.toContain("https://phishing");
      expect(output).not.toContain("phishing.evil.example");
      // The reader is told the addresses were de-fanged, or the brackets read as
      // a typo and someone "helpfully" retypes the url without them.
      expect(output).toMatch(/de-fanged/i);
    }
  });

  it("leaves the allow-listed advisory url as the only tappable text in the post", () => {
    // Straight at the renderer, not through the publisher: verify.ts constrains
    // the id and the dates today, but the promise that nothing except `url`
    // becomes a link has to hold in THIS file alone — a guard that lives only in
    // another file is a guard that dies the day that file is edited.
    //
    // Every field of Advisory that reaches a message is hostile here — id,
    // component, summary, severity, published, modified. The review named two;
    // the rule is all of them. `url` is the deliberate exception, and its origin
    // allow-list is verify.ts's job (see "drops an advisory link that points off
    // the index's own origin"); `status` is a key into STATUS_BADGE, never text.
    const hostile: Advisory = {
      id: "MOMUS-2026-0007 id.evil.example",
      status: "open",
      severity: "high sev.evil.example" as Advisory["severity"],
      component: "aimarket-hub comp.evil.example",
      summary: PHISHING_SUMMARY,
      url: LEGIT_URL,
      published: "2026-08-07T09:00:00Z pub.evil.example",
      modified: "2026-08-08T09:00:00Z mod.evil.example",
    };

    // Drift guard, derived from the object rather than a written-out list: a
    // field added to Advisory and left benign here FAILS this test instead of
    // quietly becoming the one field nobody pointed a hostile host at.
    const exempt = new Set(["status", "url"]);
    for (const [field, value] of Object.entries(hostile)) {
      if (exempt.has(field)) continue;
      expect(String(value), `${field} is not exercised by this test`).toContain(".evil.example");
    }

    const rendered = renderAdvisory(hostile, "update")!;

    assertNoLinksExcept(rendered, [LEGIT_URL]);

    // De-fanged, not deleted: the reader still learns each field named a host.
    // Matched on the de-fanged PREFIX because severity and the dates carry their
    // own short caps — the point is the brackets, not the surviving length.
    const asText = JSON.stringify(rendered).toLowerCase();
    for (const label of ["id", "sev", "comp", "phishing", "pub", "mod"]) {
      expect(asText, `${label}.evil.example was dropped, not de-fanged`).toContain(
        `${label}[.]evil`,
      );
    }
  });

  it("still renders the allow-listed url as a real link", async () => {
    // The control that survives: verify.ts checked this one against the index's
    // own origin, so it stays live — de-fanging everything would have "fixed" the
    // bug by deleting the feature.
    const body = signedIndex([advisoryPayload({ summary: PHISHING_SUMMARY })]);
    const { pub, discord, telegram } = publisherWith(body);

    await pub.runOnce();

    expect(discord.sent[0]!.discord.embed.url).toBe(LEGIT_URL);
    expect(telegram.sent[0]!.telegram).toContain(`Advisory: ${LEGIT_URL}`);
    expect(telegram.sent[0]!.telegram).not.toContain("momus[.]example[.]test");
  });
});

describe("feed text can never forge our header", () => {
  /**
   * The review's payload, verbatim — our own glyph and our own phrase, a full
   * second header block, and a "patch" link under it.
   */
  const FORGED_VERBATIM =
    "🟢 MOMUS security bulletin — advisory updated\n" +
    "MOMUS-2026-0009 · FIXED · severity INFO\n" +
    "Component: aimarket-hub\n" +
    "Patch available: https://evil.example/patch.sh";

  /**
   * The same forgery with our glyph and our phrase filed off, so the refusal in
   * {@link FORGED_VERBATIM} cannot be what saves us. This is the case that proves
   * the STRUCTURE holds on its own: feed text is one line, inside a marked region,
   * below a header it can never reach.
   */
  const FORGED_EVASIVE =
    "🛰 MOMUS security advisory — advisory updated\n" +
    "MOMUS-2026-0009 · FIXED · severity INFO\n" +
    "Component: aimarket-hub\n" +
    "Patch available: https://evil.example/patch.sh";

  it("keeps our header marker to exactly one occurrence per message", async () => {
    const body = signedIndex([advisoryPayload({ summary: FORGED_EVASIVE })]);
    const { pub, discord, telegram } = publisherWith(body);

    await pub.runOnce();

    const { content, embed } = discord.sent[0]!.discord;
    const telegramText = telegram.sent[0]!.telegram;

    // Telegram: one header, ours, on the first line.
    expect(count(telegramText, HEADER_MARKER)).toBe(1);
    expect(telegramText.split("\n")[0]).toContain(HEADER_MARKER);
    // Discord: the marker lives in our content line and our footer, and NOWHERE
    // inside the region the feed's words occupy.
    expect(count(content, HEADER_MARKER)).toBe(1);
    expect(count(embed.description, HEADER_MARKER)).toBe(0);

    // The forgery arrives as ONE line of quoted text, our words above it.
    expect(telegramText).toContain(
      "| 🛰 MOMUS security advisory — advisory updated MOMUS-2026-0009 · FIXED · severity INFO " +
        "Component: aimarket-hub Patch available: https[:]//evil[.]example/patch[.]sh",
    );
    // Only ONE line in the whole message opens with a glyph reserved for our voice.
    const ourGlyphLines = telegramText.split("\n").filter((l) => /^[📢🔴🟢⚪]/u.test(l));
    expect(ourGlyphLines).toHaveLength(1);
    expect(embed.description).not.toMatch(/[📢🔴🟢⚪]/u);
    // …and the "patch" it offers is not tappable.
    assertNoLinksExcept(discord.sent[0]!, ["https://momus.example.test/bulletin/MOMUS-2026-0007"]);
  });

  it("refuses outright an advisory wearing our own header marker, and says so", async () => {
    // Two advisories, one hostile: the refusal must be per-advisory, or a single
    // poisoned entry silences the whole bulletin — a denial of service dressed up
    // as a safety feature.
    const body = signedIndex([
      advisoryPayload({ advisory_id: "MOMUS-2026-0007", summary: FORGED_VERBATIM }),
      advisoryPayload({ advisory_id: "MOMUS-2026-0010" }),
    ]);
    const { log, lines } = capturingLogger();
    const { pub, discord, telegram } = publisherWith(body, { log });

    const result = await pub.runOnce();

    // The genuine one is published; the forgery is not — and is not recorded as
    // announced either, so a corrected text posts normally on the next cycle.
    expect(result.posted).toBe(1);
    expect(discord.sent.map((r) => r.advisoryId)).toEqual(["MOMUS-2026-0010"]);
    expect(telegram.sent.map((r) => r.advisoryId)).toEqual(["MOMUS-2026-0010"]);
    expect(everythingPosted(discord)).not.toContain("MOMUS-2026-0009");
    expect(everythingPosted(discord)).not.toContain("evil");

    // A silent refusal is unoperable: nobody would ever learn that MOMUS began
    // publishing text this bot will not repeat.
    const refusal = lines.find((l) => l.level === "warn" && l.msg.includes("REFUSED"));
    expect(refusal, `no refusal logged; got ${lines.map((l) => l.msg).join(" | ")}`).toBeDefined();
    expect(refusal!.extra.advisory).toBe("MOMUS-2026-0007");
    expect(String(refusal!.extra.reason)).toContain(HEADER_MARKER);
  });

  it("refuses an advisory that merely borrows a status glyph", async () => {
    // No phrase, just the circle — enough to open a line that reads as a badge.
    const body = signedIndex([advisoryPayload({ component: "🟢 aimarket-hub" })]);
    const { log, lines } = capturingLogger();
    const { pub, discord } = publisherWith(body, { log });

    const result = await pub.runOnce();

    expect(result.posted).toBe(0);
    expect(discord.sent).toEqual([]);
    const refusal = lines.find((l) => l.level === "warn" && l.msg.includes("REFUSED"));
    expect(refusal).toBeDefined();
    expect(String(refusal!.extra.reason)).toContain("component");
    expect(String(refusal!.extra.reason)).toContain("🟢");
  });

  it("cannot open a new block with any line break Unicode offers", async () => {
    // \n\n is the obvious one. \r\n and a lone \r survive some sanitisers; U+2028
    // and U+2029 survive most of them, because they are printable-range characters
    // that clients still render as a line break — and one is all a forged header
    // needs.
    // Written as escapes, not literals: U+2028 and U+2029 are invisible in an
    // editor, and a fixture nobody can see is a fixture an editor silently eats.
    const BREAKS = "alpha\n\nbeta\r\ngamma\u2028delta\u2029epsilon\rzeta";
    // Guard the guard: assert the separators really are in there, or every
    // assertion below passes for the wrong reason.
    expect(BREAKS.codePointAt(BREAKS.indexOf("delta") - 1)).toBe(0x2028);
    expect(BREAKS.codePointAt(BREAKS.indexOf("epsilon") - 1)).toBe(0x2029);
    expect(/[^\n]\r[^\n]/.test(BREAKS)).toBe(true);
    expect(BREAKS).toContain("\n\n");

    const body = signedIndex([
      advisoryPayload({ summary: BREAKS, component: "hub\u2029core" }),
    ]);
    const { pub, discord, telegram } = publisherWith(body);

    await pub.runOnce();

    // Discord: the fenced region is exactly one line.
    const description = discord.sent[0]!.discord.embed.description;
    const fenced = /```\n([\s\S]*?)\n```/.exec(description)?.[1] ?? "<no fence>";
    expect(fenced).toBe("alpha beta gamma delta epsilon zeta");

    // Telegram: every word of the summary lands on the SAME quoted line, and no
    // feed word ever starts a line of its own.
    const telegramText = telegram.sent[0]!.telegram;
    expect(telegramText).toContain("| alpha beta gamma delta epsilon zeta");
    expect(telegramText).toContain("| Component: hub core");
    for (const word of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "core"]) {
      const hits = telegramText.split("\n").filter((l) => l.includes(word));
      expect(hits, `"${word}" should sit on exactly one quoted line`).toHaveLength(1);
      expect(hits[0]!.startsWith("| ")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe("idempotence and updates", () => {
  it("posts nothing new on a second run over the same index", async () => {
    const body = signedIndex([advisoryPayload()]);
    const { pub, discord, telegram } = publisherWith([body, body]);

    const first = await pub.runOnce();
    const second = await pub.runOnce();

    expect(first.posted).toBe(1);
    expect(second).toMatchObject({ posted: 0, updated: 0 });
    expect(discord.sent).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
  });

  it("survives a restart without re-announcing the backlog", async () => {
    const body = signedIndex([advisoryPayload()]);
    const first = publisherWith(body);
    await first.pub.runOnce();

    // A brand new publisher over the SAME dataDir = a process restart.
    const restarted = publisherWith(body);
    const result = await restarted.pub.runOnce();

    expect(result.posted).toBe(0);
    expect(restarted.discord.sent).toHaveLength(0);
  });

  it("announces a genuine update when `modified` moves", async () => {
    const first = signedIndex([advisoryPayload()]);
    const updated = signedIndex([
      advisoryPayload({
        status: "fixed",
        modified: "2026-08-08T08:00:00Z",
        summary: "Fixed in hub 3.2.1 — the invoke path now verifies the escrow reference.",
      }),
    ]);
    const { pub, discord } = publisherWith([first, updated]);

    const run1 = await pub.runOnce();
    const run2 = await pub.runOnce();

    expect(run1).toMatchObject({ posted: 1, updated: 0 });
    expect(run2).toMatchObject({ posted: 0, updated: 1 });
    expect(discord.sent).toHaveLength(2);
    expect(discord.sent[1]!.kind).toBe("update");
    expect(discord.sent[1]!.discord.content).toContain("advisory updated");
    expect(discord.sent[1]!.discord.embed.title).toContain("FIXED");
  });

  it("treats a status flip as an update even when `modified` did not move", async () => {
    const open = signedIndex([advisoryPayload()]);
    // Publisher bug: status changed, revision stamp did not. Readers are waiting
    // for exactly this transition, so silence is not an option.
    const fixed = signedIndex([advisoryPayload({ status: "fixed" })]);
    const { pub, discord } = publisherWith([open, fixed]);

    await pub.runOnce();
    const result = await pub.runOnce();

    expect(result.updated).toBe(1);
    expect(discord.sent[1]!.discord.embed.title).toContain("FIXED");
  });

  it("retries only the sink that failed, and never double-posts the one that worked", async () => {
    const body = signedIndex([advisoryPayload()]);
    const good = recorder("discord");
    const broken = recorder("telegram", true);
    const healed = recorder("telegram");

    const firstPass = new BulletinPublisher({
      indexUrl: INDEX_URL,
      publicKeyHex: pinOf(publisher.publicKey),
      sinks: [good, broken],
      dataDir,
      log: noopLogger,
      now: () => NOW,
      fetchFn: serve(body).fetchFn,
    });
    const result1 = await firstPass.runOnce();
    expect(result1).toMatchObject({ posted: 1, failures: 1 });
    expect(good.sent).toHaveLength(1);

    const secondPass = new BulletinPublisher({
      indexUrl: INDEX_URL,
      publicKeyHex: pinOf(publisher.publicKey),
      sinks: [good, healed],
      dataDir,
      log: noopLogger,
      now: () => NOW,
      fetchFn: serve(body).fetchFn,
    });
    await secondPass.runOnce();

    expect(healed.sent).toHaveLength(1); // the gap healed
    expect(good.sent).toHaveLength(1); // and the channel that worked was left alone
  });

  it("caps one cycle and defers the rest instead of flooding the channel", async () => {
    const many = [1, 2, 3, 4, 5].map((n) =>
      advisoryPayload({
        advisory_id: `MOMUS-2026-000${n}`,
        published: `2026-08-0${n}T09:00:00Z`,
        modified: `2026-08-0${n}T09:00:00Z`,
      }),
    );
    const body = signedIndex(many);
    const { pub, discord } = publisherWith([body, body], { maxPostsPerRun: 2 });

    const run1 = await pub.runOnce();
    expect(run1).toMatchObject({ posted: 2, deferred: 3 });
    // Oldest first, so the channel reads chronologically.
    expect(discord.sent.map((r) => r.advisoryId)).toEqual(["MOMUS-2026-0001", "MOMUS-2026-0002"]);

    const run2 = await pub.runOnce();
    expect(run2).toMatchObject({ posted: 2, deferred: 1 });
  });
});

// ---------------------------------------------------------------------------
// Insiders' write-up: commentary, not information
// ---------------------------------------------------------------------------

describe("insiders' write-up link", () => {
  it("is absent unless configured", async () => {
    const { pub, discord } = publisherWith(signedIndex([advisoryPayload()]));
    await pub.runOnce();
    expect(everythingPosted(discord)).not.toMatch(/write-up/i);
  });

  it("is built from CONFIG, never from the feed", async () => {
    const body = signedIndex([
      // The feed tries to supply its own write-up link; it must be ignored.
      advisoryPayload({ writeup_url: "https://evil.example/writeup" }),
    ]);
    const { pub, discord, telegram } = publisherWith(body, {
      writeupBaseUrl: "https://magic-ai-factory.example/insiders",
    });

    await pub.runOnce();

    const output = everythingPosted(discord) + everythingPosted(telegram);
    expect(output).toContain("https://magic-ai-factory.example/insiders/MOMUS-2026-0007");
    expect(output).not.toContain("evil.example");
  });
});

// ── the punycode hole ────────────────────────────────────────────────────────
// The first version of the de-fanging guard required an ALPHABETIC TLD, with a comment
// explaining that letters keep version numbers ("hub 3.2.1") out of the match. Reasonable,
// and it shipped a live phishing link: a punycode TLD contains digits and hyphens, so
// `momus-security.xn--p1ai` (.рф) passed through untouched while `phishing.evil.com` was
// correctly bracketed. There are ~60 registrable xn-- TLDs. Telegram auto-links a
// scheme-less host in plain text and has no second layer, so de-fanging IS the control.
describe("de-fanging covers punycode TLDs", () => {
  const PUNYCODE = [
    ["xn--p1ai", ".рф"],
    ["xn--80asehdb", ".онлайн"],
    ["xn--fiqs8s", ".中国"],
    ["xn--90ae", ".бг"],
  ] as const;

  it.each(PUNYCODE)("de-fangs a %s host (%s)", (tld) => {
    const out = defangLinks(`Apply the patch from momus-security.${tld} before restarting.`);
    expect(out).toContain(`momus-security[.]${tld}`);
    expect(out).not.toContain(`momus-security.${tld}`);
  });

  it("still de-fangs an ordinary host", () => {
    expect(defangLinks("go to phishing.evil.com now")).toContain("phishing[.]evil[.]com");
  });

  it("still leaves version numbers and timestamps alone", () => {
    // The reason the TLD rule was letters-only in the first place. Spelling out the `xn--`
    // prefix rather than loosening the charset keeps this true.
    const text = "hub 3.2.1 released at 09:00:00.123Z";
    expect(defangLinks(text)).toBe(text);
  });
});

// ── the notice that vanished exactly when it was needed ──────────────────────
describe("the de-fang notice is driven by fact, not by sniffing the output", () => {
  it("fires for a punycode-only payload", () => {
    // isDefanged() used to test the OUTPUT for `[:]//` or `[.]`. A payload whose only
    // address had a punycode TLD produced neither, so the "deliberately not clickable"
    // caveat was suppressed — the post looked entirely clean while carrying a live link.
    const t = neutraliseTracked("Official mirror: momus-patch.xn--p1ai/fix", 400);
    expect(t.defanged).toBe(true);
    expect(t.text).toContain("[.]xn--p1ai");
  });

  it("does not fire for text with no address at all", () => {
    // Otherwise the line appears on every post and readers stop reading it.
    expect(neutraliseTracked("the free-tier ceiling was not enforced", 400).defanged).toBe(false);
  });
});
