import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCORD_WELCOME_MARKER,
  TELEGRAM_LINKS_MARKER,
  isDiscordWelcomeMessage,
  isTelegramEcosystemGuide,
  isTelegramLinksMessage,
} from "../src/provision/dedup.js";
import { TELEGRAM_ECOSYSTEM_MARKER } from "../src/provision/guides.js";
import {
  hasProvisionFlag,
  provisionFlagPath,
  readProvisionFlag,
  releaseProvisionLock,
  tryProvisionLock,
  writeProvisionFlag,
} from "../src/provision/flags.js";

describe("provision dedup markers", () => {
  it("detects discord welcome from bot", () => {
    const text = `⚔️ **${DISCORD_WELCOME_MARKER}**`;
    expect(isDiscordWelcomeMessage(text, "bot1", "bot1")).toBe(true);
    expect(isDiscordWelcomeMessage(text, "other", "bot1")).toBe(false);
    expect(isDiscordWelcomeMessage("hello", "bot1", "bot1")).toBe(false);
  });

  it("detects telegram links in groups and channels", () => {
    const text = `${TELEGRAM_LINKS_MARKER}\nTalk to Castor`;
    expect(isTelegramLinksMessage({ from: { id: 42 }, text }, 42, "-1001")).toBe(true);
    expect(isTelegramLinksMessage({ sender_chat: { id: -1001 }, text }, 42, "-1001")).toBe(true);
    expect(isTelegramLinksMessage({ from: { id: 99 }, text }, 42, "-1001")).toBe(false);
    expect(isTelegramLinksMessage({ text: "Pollux only" }, 42, "-1001")).toBe(false);
  });

  it("detects telegram ecosystem guide in groups and channels", () => {
    const text = `${TELEGRAM_ECOSYSTEM_MARKER}\nEnglish is the default`;
    expect(isTelegramEcosystemGuide({ from: { id: 42 }, text }, 42, "-1001")).toBe(true);
    expect(isTelegramEcosystemGuide({ sender_chat: { id: -1001 }, text }, 42, "-1001")).toBe(true);
    expect(isTelegramEcosystemGuide({ text: TELEGRAM_LINKS_MARKER }, 42, "-1001")).toBe(false);
  });
});

describe("provision flags", () => {
  let dataDir = "";

  afterEach(() => {
    if (dataDir !== "") rmSync(dataDir, { recursive: true, force: true });
    dataDir = "";
  });

  it("writes and reads a provision flag", () => {
    dataDir = mkdtempSync(join(tmpdir(), "provision-flag-"));
    expect(hasProvisionFlag(dataDir, "discord-welcome")).toBe(false);
    writeProvisionFlag(dataDir, "discord-welcome", "msg=123");
    expect(hasProvisionFlag(dataDir, "discord-welcome")).toBe(true);
    expect(readProvisionFlag(dataDir, "discord-welcome")).toContain("msg=123");
    expect(existsSync(provisionFlagPath(dataDir, "discord-welcome"))).toBe(true);
  });

  it("exclusive lock prevents double acquire", () => {
    dataDir = mkdtempSync(join(tmpdir(), "provision-lock-"));
    expect(tryProvisionLock(dataDir, "discord-welcome")).toBe(true);
    expect(tryProvisionLock(dataDir, "discord-welcome")).toBe(false);
    releaseProvisionLock(dataDir, "discord-welcome");
    expect(tryProvisionLock(dataDir, "discord-welcome")).toBe(true);
    releaseProvisionLock(dataDir, "discord-welcome");
  });
});
