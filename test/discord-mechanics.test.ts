/**
 * Discord growth mechanics — the PURE seams only (discord.js network objects
 * are not faked end-to-end here):
 *
 *  - shouldTriggerDiscordQa / discordChannelNamesForQa: #help open-ask routing
 *    (plain messages qualify; other channels still need @mention).
 *  - isDisboardBumpSuccess: recognising DISBOARD's "Bump done" confirmation
 *    (and nothing else — wrong authors and unrelated embeds must not trigger).
 *  - buildBumpReminder: the Keeper reminder text + its allowedMentions payload.
 *    This is the ONLY sanctioned role mention in the whole bot, so the tests
 *    pin the invariants hard: parse is ALWAYS empty, roles lists exactly the
 *    Keeper role id or nothing.
 *  - planProvision still plans #announcements exactly once (the announcement-
 *    type upgrade lives in the executor; the pure diff must be unchanged).
 */

import { describe, expect, it } from "vitest";
import {
  DISBOARD_BOT_ID,
  QA_OPEN_CHANNEL_NAMES,
  buildBumpReminder,
  discordChannelNamesForQa,
  isDisboardBumpSuccess,
  shouldTriggerDiscordQa,
} from "../src/adapters/discord.js";
import { ANNOUNCE_CHANNEL, planProvision } from "../src/provision/structure.js";

// ---------------------------------------------------------------------------
// shouldTriggerDiscordQa
// ---------------------------------------------------------------------------

describe("shouldTriggerDiscordQa", () => {
  const base = { isDm: false, mentioned: false, repliedToBot: false, channelName: "general" };

  it("answers in #help without a mention", () => {
    expect(shouldTriggerDiscordQa({ ...base, channelName: "help" })).toBe(true);
    expect(shouldTriggerDiscordQa({ ...base, channelName: "HELP" })).toBe(true);
  });

  it("still requires a mention outside open ask channels", () => {
    expect(shouldTriggerDiscordQa({ ...base, channelName: "general" })).toBe(false);
    expect(shouldTriggerDiscordQa({ ...base, channelName: "ideas" })).toBe(false);
  });

  it("answers in a thread whose parent is #help", () => {
    expect(
      shouldTriggerDiscordQa({
        ...base,
        channelName: "helios-thread",
        parentChannelName: "help",
      }),
    ).toBe(true);
  });

  it("always answers DMs, mentions and replies", () => {
    expect(shouldTriggerDiscordQa({ ...base, isDm: true })).toBe(true);
    expect(shouldTriggerDiscordQa({ ...base, mentioned: true })).toBe(true);
    expect(shouldTriggerDiscordQa({ ...base, repliedToBot: true })).toBe(true);
  });

  it("does not treat a thread in #general as open ask", () => {
    expect(
      shouldTriggerDiscordQa({
        ...base,
        channelName: "side-topic",
        parentChannelName: "general",
      }),
    ).toBe(false);
  });

  it("ignores null/empty channel names when not dm/mention/reply", () => {
    expect(shouldTriggerDiscordQa({ ...base, channelName: null })).toBe(false);
    expect(shouldTriggerDiscordQa({ ...base, channelName: "" })).toBe(false);
    expect(shouldTriggerDiscordQa({ ...base, channelName: "   " })).toBe(false);
  });

  it("only #help is in the open-ask set", () => {
    expect(QA_OPEN_CHANNEL_NAMES.has("help")).toBe(true);
    expect(QA_OPEN_CHANNEL_NAMES.has("general")).toBe(false);
    expect(QA_OPEN_CHANNEL_NAMES.size).toBe(1);
  });
});

describe("discordChannelNamesForQa", () => {
  it("returns the channel name for a normal text channel", () => {
    const names = discordChannelNamesForQa({
      isTextBased: () => true,
      name: "help",
      isThread: () => false,
    });
    expect(names).toEqual({ channelName: "help", parentChannelName: null });
  });

  it("returns nulls for non-text channels", () => {
    expect(discordChannelNamesForQa({ isTextBased: () => false })).toEqual({
      channelName: null,
      parentChannelName: null,
    });
  });

  it("returns parent name for threads", () => {
    const names = discordChannelNamesForQa({
      isTextBased: () => true,
      name: "side-thread",
      isThread: () => true,
      parent: { name: "help" },
    });
    expect(names).toEqual({ channelName: "side-thread", parentChannelName: "help" });
  });
});

// ---------------------------------------------------------------------------
// isDisboardBumpSuccess
// ---------------------------------------------------------------------------

describe("isDisboardBumpSuccess", () => {
  it("detects DISBOARD's bump confirmation embed", () => {
    expect(
      isDisboardBumpSuccess(DISBOARD_BOT_ID, ["Bump done! :thumbsup:\nCheck it out on DISBOARD."]),
    ).toBe(true);
  });

  it("detects the phrase in any embed of the message", () => {
    expect(isDisboardBumpSuccess(DISBOARD_BOT_ID, ["something else", "Bump done!"])).toBe(true);
  });

  it("ignores the same embed from a different author (spoof guard)", () => {
    expect(isDisboardBumpSuccess("123456789012345678", ["Bump done! :thumbsup:"])).toBe(false);
    expect(isDisboardBumpSuccess("", ["Bump done!"])).toBe(false);
  });

  it("ignores DISBOARD messages that are not a successful bump", () => {
    // Cooldown notice, help text, empty descriptions — none of these count.
    expect(isDisboardBumpSuccess(DISBOARD_BOT_ID, ["Please wait 42 minutes until the server can be bumped"])).toBe(false);
    expect(isDisboardBumpSuccess(DISBOARD_BOT_ID, ["DISBOARD: discover public servers"])).toBe(false);
    expect(isDisboardBumpSuccess(DISBOARD_BOT_ID, [""])).toBe(false);
    expect(isDisboardBumpSuccess(DISBOARD_BOT_ID, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildBumpReminder
// ---------------------------------------------------------------------------

describe("buildBumpReminder", () => {
  it("mentions exactly the Keeper role when its id is known", () => {
    const r = buildBumpReminder("424242424242424242");
    expect(r.content).toContain("<@&424242424242424242>");
    expect(r.content).toContain("DISBOARD");
    expect(r.content).toContain("/bump");
    expect(r.allowedMentions.roles).toEqual(["424242424242424242"]);
    expect(r.allowedMentions.parse).toEqual([]);
  });

  it("posts without any mention when no Keeper role exists", () => {
    const r = buildBumpReminder(null);
    expect(r.content).not.toContain("<@&");
    expect(r.content).toContain("/bump");
    expect(r.allowedMentions.roles).toEqual([]);
    expect(r.allowedMentions.parse).toEqual([]);
  });

  it("never widens allowedMentions.parse (no @everyone/@here escape hatch)", () => {
    for (const roleId of ["424242424242424242", null]) {
      const r = buildBumpReminder(roleId);
      expect(r.allowedMentions.parse).toHaveLength(0);
      expect(r.content).not.toContain("@everyone");
      expect(r.content).not.toContain("@here");
    }
  });
});

// ---------------------------------------------------------------------------
// provision structure: #announcements is still planned exactly once
// ---------------------------------------------------------------------------

describe("planProvision × announcements", () => {
  it("plans a single #announcements creation step for an empty guild", () => {
    const plan = planProvision([]);
    const announceCreates = plan.filter(
      (s) => (s.op === "createText" || s.op === "createVoice") && s.name === ANNOUNCE_CHANNEL,
    );
    expect(announceCreates).toHaveLength(1);
    expect(announceCreates[0]?.op).toBe("createText");
  });
});
