/**
 * Tests for src/aegis/moderation.ts — pure-logic tests with stubbed
 * aegis/llm/floodLimiter and an injected clock: deterministic rules
 * (invites, deny/allow lists, mass mention, flood, repeat-spam, caps,
 * hidden unicode, AEGIS critical), moderator bypass, and the clamped
 * LLM classifier (confidence floor for delete, timeout cap, malformed
 * JSON keeping the deterministic verdict).
 */

import { describe, expect, it } from "vitest";
import { Moderation, type ModerationDeps } from "../src/aegis/moderation.js";
import { prepareUntrusted } from "../src/aegis/sanitize.js";
import type { Tuning } from "../src/config.js";
import type {
  AegisFinding,
  AegisGate,
  ChatOptions,
  CrossLinks,
  Logger,
  ModerationInput,
  RateLimiter,
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

function cfgWith(overrides: Partial<Tuning["moderation"]> = {}): Tuning["moderation"] {
  return {
    enabled: true,
    llmClassifier: false,
    deleteConfidence: 0.8,
    maxTimeoutMs: 10 * 60 * 1000,
    linkAllowlist: [],
    linkDenylist: [],
    ...overrides,
  };
}

/** Pass-through AEGIS stub: real sanitation, injectable findings. */
function aegisStub(findings: AegisFinding[] = []): AegisGate {
  return {
    inspect: (text, opts) => ({
      action: "allow",
      score: 1,
      findings,
      sanitizedText: prepareUntrusted(text, opts?.maxLen ?? 4000),
    }),
  };
}

const allow: RateLimiter = { check: () => ({ allowed: true, remaining: 9 }) };
const deny: RateLimiter = { check: () => ({ allowed: false, retryAfterMs: 5000, remaining: 0 }) };

function inputWith(overrides: Partial<ModerationInput> = {}): ModerationInput {
  return {
    platform: "discord",
    text: "hello there, how do I run the factory?",
    authorDisplay: "Alice",
    authorKey: "dc:1",
    authorIsMod: false,
    mentionCount: 0,
    mentionsEveryone: false,
    ...overrides,
  };
}

function engine(over: Partial<ModerationDeps> = {}): Moderation {
  return new Moderation({
    aegis: aegisStub(),
    cfg: cfgWith(),
    officialLinks: LINKS,
    floodLimiter: allow,
    log,
    ...over,
  });
}

describe("Moderation — deterministic rules", () => {
  it("clean message passes", async () => {
    const d = await engine().review(inputWith());
    expect(d.kind).toBe("ok");
    expect(d.ruleCodes).toEqual([]);
  });

  it("foreign discord invite is deleted; the official one passes", async () => {
    const mod = engine();
    const bad = await mod.review(inputWith({ text: "join us: https://discord.gg/evilplace" }));
    expect(bad.kind).toBe("delete");
    expect(bad.ruleCodes).toContain("FOREIGN_INVITE");

    const official = await mod.review(inputWith({ text: "our server: https://discord.gg/aicom" }));
    expect(official.kind).toBe("ok");
  });

  it("discord.com/invite and t.me variants are caught; official t.me passes", async () => {
    const mod = engine();
    const viaCom = await mod.review(inputWith({ text: "discord.com/invite/evilplace" }));
    expect(viaCom.kind).toBe("delete");
    const tme = await mod.review(inputWith({ text: "cool group t.me/scamcoin" }));
    expect(tme.kind).toBe("delete");
    const ours = await mod.review(inputWith({ text: "follow https://t.me/aicom" }));
    expect(ours.kind).toBe("ok");
  });

  it("denylisted domain (including subdomains) → delete", async () => {
    const mod = engine({ cfg: cfgWith({ linkDenylist: ["scam.example"] }) });
    const hit = await mod.review(inputWith({ text: "free coins at https://scam.example/win" }));
    expect(hit.kind).toBe("delete");
    expect(hit.ruleCodes).toContain("LINK_DENYLIST");
    const sub = await mod.review(inputWith({ text: "https://promo.scam.example/x" }));
    expect(sub.kind).toBe("delete");
  });

  it("non-empty allowlist: outside hostname → warn, listed one → ok", async () => {
    const mod = engine({ cfg: cfgWith({ linkAllowlist: ["github.com"] }) });
    const outside = await mod.review(inputWith({ text: "see https://gitlab.com/thing" }));
    expect(outside.kind).toBe("warn");
    expect(outside.ruleCodes).toContain("LINK_ALLOWLIST");
    const listed = await mod.review(inputWith({ text: "see https://github.com/alexar76" }));
    expect(listed.kind).toBe("ok");
  });

  it("mass mention → timeout 5min, within the cap", async () => {
    const d = await engine().review(inputWith({ mentionCount: 8 }));
    expect(d.kind).toBe("timeout");
    expect(d.ruleCodes).toContain("MASS_MENTION");
    expect(d.timeoutMs).toBe(5 * 60 * 1000);
    expect(d.timeoutMs!).toBeLessThanOrEqual(cfgWith().maxTimeoutMs);
  });

  it("mass-mention timeout is clamped to cfg.maxTimeoutMs", async () => {
    const mod = engine({ cfg: cfgWith({ maxTimeoutMs: 60_000 }) });
    const d = await mod.review(inputWith({ mentionsEveryone: true }));
    expect(d.kind).toBe("timeout");
    expect(d.timeoutMs).toBe(60_000);
  });

  it("flood-blocked author → delete + timeout 2min", async () => {
    const d = await engine({ floodLimiter: deny }).review(inputWith());
    expect(d.kind).toBe("timeout");
    expect(d.ruleCodes).toContain("FLOOD");
    expect(d.timeoutMs).toBe(2 * 60 * 1000);
  });

  it("repeat-spam fires on the 3rd identical copy within 60s (normalised)", async () => {
    let t = 1_000_000;
    const mod = engine({ now: () => t });
    const first = await mod.review(inputWith({ text: "Buy   NOW at mysite" }));
    expect(first.kind).toBe("ok");
    t += 10_000;
    const second = await mod.review(inputWith({ text: "buy now at MYSITE" }));
    expect(second.kind).toBe("ok");
    t += 10_000;
    const third = await mod.review(inputWith({ text: "BUY NOW   at mysite" }));
    expect(third.kind).toBe("timeout");
    expect(third.ruleCodes).toContain("REPEAT_SPAM");
    expect(third.timeoutMs).toBe(5 * 60 * 1000);
  });

  it("repeat-spam window expires: 3rd copy after 60s stays ok", async () => {
    let t = 1_000_000;
    const mod = engine({ now: () => t });
    await mod.review(inputWith({ text: "same text here friends" }));
    t += 10_000;
    await mod.review(inputWith({ text: "same text here friends" }));
    t += 70_000; // both prior copies aged out of the 60s window
    const third = await mod.review(inputWith({ text: "same text here friends" }));
    expect(third.kind).toBe("ok");
  });

  it("all-caps shouting → warn", async () => {
    const d = await engine().review(inputWith({ text: "THIS IS DEFINITELY VERY LOUD SHOUTING" }));
    expect(d.kind).toBe("warn");
    expect(d.ruleCodes).toContain("CAPS");
  });

  it("oversize message → warn", async () => {
    const d = await engine().review(inputWith({ text: "a".repeat(4200) }));
    expect(d.kind).toBe("warn");
    expect(d.ruleCodes).toContain("OVERSIZE");
  });

  it("HIDDEN_UNICODE finding → delete; AEGIS critical → warn AEGIS_PATTERN", async () => {
    const hidden = await engine({
      aegis: aegisStub([{ code: "HIDDEN_UNICODE", severity: "medium", message: "m" }]),
    }).review(inputWith());
    expect(hidden.kind).toBe("delete");
    expect(hidden.ruleCodes).toContain("HIDDEN_UNICODE");

    const critical = await engine({
      aegis: aegisStub([{ code: "INJECTION_CRITICAL", severity: "critical", message: "m" }]),
    }).review(inputWith());
    expect(critical.kind).toBe("warn");
    expect(critical.ruleCodes).toContain("AEGIS_PATTERN");
  });

  it("moderators bypass everything except FOREIGN_INVITE (softened to warn)", async () => {
    const mod = engine({ floodLimiter: deny });
    const bypass = await mod.review(
      inputWith({ authorIsMod: true, mentionsEveryone: true, mentionCount: 20, text: "ANNOUNCEMENT FOR EVERYONE TODAY" }),
    );
    expect(bypass.kind).toBe("ok");

    const invite = await mod.review(inputWith({ authorIsMod: true, text: "check discord.gg/otherserver" }));
    expect(invite.kind).toBe("warn");
    expect(invite.ruleCodes).toContain("FOREIGN_INVITE");
  });

  it("moderation disabled → always ok", async () => {
    const mod = engine({ cfg: cfgWith({ enabled: false }), floodLimiter: deny });
    const d = await mod.review(inputWith({ mentionsEveryone: true }));
    expect(d.kind).toBe("ok");
  });
});

describe("Moderation — LLM classifier (clamped)", () => {
  function llmReturning(reply: string | (() => string)): { llm: { chat: (o: ChatOptions) => Promise<string> }; calls: ChatOptions[] } {
    const calls: ChatOptions[] = [];
    return {
      calls,
      llm: {
        chat: async (o: ChatOptions) => {
          calls.push(o);
          return typeof reply === "function" ? reply() : reply;
        },
      },
    };
  }

  it("malformed classifier JSON keeps the deterministic verdict", async () => {
    const { llm } = llmReturning("sorry, I cannot produce JSON today");
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    const d = await mod.review(inputWith({ text: "THIS IS DEFINITELY VERY LOUD SHOUTING" }));
    expect(d.kind).toBe("warn"); // deterministic CAPS warn survives
    expect(d.ruleCodes).toEqual(["CAPS"]);
    expect(d.llmCategory).toBeUndefined();
  });

  it("classifier delete below deleteConfidence is downgraded to warn", async () => {
    const { llm, calls } = llmReturning('{"category":"spam","action":"delete","confidence":0.5}');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    // a link is the risk signal; deterministically the message is clean
    const d = await mod.review(inputWith({ text: "amazing deal at https://example.com now" }));
    expect(calls).toHaveLength(1);
    expect(d.kind).toBe("warn");
    expect(d.llmCategory).toBe("spam");
    expect(d.ruleCodes).toContain("LLM_CLASSIFIER");
  });

  it("classifier delete at/above deleteConfidence is enforced", async () => {
    const { llm } = llmReturning('{"category":"scam","action":"delete","confidence":0.95}');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    const d = await mod.review(inputWith({ text: "double your USDC at https://example.com" }));
    expect(d.kind).toBe("delete");
    expect(d.llmCategory).toBe("scam");
  });

  it("classifier timeout is capped at cfg.maxTimeoutMs", async () => {
    const { llm } = llmReturning('{"category":"spam","action":"timeout","confidence":0.99}');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true, maxTimeoutMs: 60_000 }), llm });
    const d = await mod.review(inputWith({ text: "spam wall https://example.com" }));
    expect(d.kind).toBe("timeout");
    expect(d.timeoutMs).toBe(60_000);
  });

  it("code fences around the JSON are tolerated", async () => {
    const { llm } = llmReturning('```json\n{"category":"spam","action":"warn","confidence":0.9}\n```');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    const d = await mod.review(inputWith({ text: "look https://example.com" }));
    expect(d.kind).toBe("warn");
    expect(d.llmCategory).toBe("spam");
  });

  it("no risk signal → classifier is never called", async () => {
    const { llm, calls } = llmReturning('{"category":"spam","action":"delete","confidence":0.99}');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    const d = await mod.review(inputWith({ text: "plain harmless question about oracles" }));
    expect(calls).toHaveLength(0);
    expect(d.kind).toBe("ok");
  });

  it("classifier cannot soften a deterministic timeout (harsher wins)", async () => {
    const { llm, calls } = llmReturning('{"category":"none","action":"ok","confidence":1}');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    const d = await mod.review(inputWith({ mentionCount: 10, text: "hi https://example.com" }));
    // deterministic verdict is already delete+ — classifier must not even run
    expect(calls).toHaveLength(0);
    expect(d.kind).toBe("timeout");
  });

  it("classifier user turn is fenced (wrapUserText), never raw", async () => {
    const { llm, calls } = llmReturning('{"category":"none","action":"ok","confidence":1}');
    const mod = engine({ cfg: cfgWith({ llmClassifier: true }), llm });
    await mod.review(inputWith({ text: "is https://example.com legit?" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages[0]!.content).toContain("«DIOSCURI_USER_TEXT_BEGIN»");
    expect(calls[0]!.json).toBe(true);
  });
});
