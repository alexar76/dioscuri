import { describe, expect, it } from "vitest";
import {
  CHANNEL_GUIDES,
  TELEGRAM_ECOSYSTEM_MARKER,
  guideDemoTargets,
  guideMarker,
  renderChannelGuide,
  renderTelegramEcosystemGuide,
  telegramDemoTargets,
} from "../src/provision/guides.js";
import type { CrossLinks } from "../src/types.js";

const links: CrossLinks = {
  discordInvite: "https://discord.gg/test",
  telegramChannel: "https://t.me/test",
  telegramBot: "https://t.me/test_bot",
  siteUrl: "https://magic-ai-factory.com",
  githubOrg: "https://github.com/alexar76",
  theorosUrl: "https://alexar76.github.io/theoros/",
};

const demos: Record<string, string> = {
  aicom: "https://magic-ai-factory.com/monitor/",
  argus: "https://magic-ai-factory.com/argus/",
  "aimarket-hub": "https://modelmarket.dev/plugins/demo",
};

describe("channel guides", () => {
  it("renders marker and repo links", () => {
    const def = CHANNEL_GUIDES.find((g) => g.channel === "factory")!;
    const text = renderChannelGuide(def, { links, githubOwner: "alexar76", demoUrls: demos });
    expect(text).toContain(guideMarker("factory"));
    expect(text).toContain("https://github.com/alexar76/aicom");
    expect(text).toContain("https://magic-ai-factory.com/monitor/");
    expect(text).toContain("Discord (Pollux)");
    expect(text).toContain("Telegram");
    expect(text).toContain("English");
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("renders telegram ecosystem guide in English with both platforms", () => {
    const text = renderTelegramEcosystemGuide({ links, githubOwner: "alexar76", demoUrls: demos });
    expect(text).toContain(TELEGRAM_ECOSYSTEM_MARKER);
    expect(text).toContain("English");
    expect(text).toContain("Pollux");
    expect(text).toContain("Discord");
    expect(text).toContain("MNEMOSYNE");
    expect(text).toContain("AI Factory");
    expect(text.length).toBeLessThanOrEqual(12000);
  });

  it("telegram demo targets respect album cap", () => {
    expect(telegramDemoTargets(demos, 10).length).toBeLessThanOrEqual(10);
    expect(telegramDemoTargets(demos).length).toBeGreaterThan(0);
  });

  it("picks demo screenshot targets without duplicates", () => {
    const def = CHANNEL_GUIDES.find((g) => g.channel === "aimarket")!;
    const targets = guideDemoTargets(def, {
      ...demos,
      "aimarket-protocol": demos["aimarket-hub"]!,
    });
    const urls = targets.map((t) => t.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(targets.length).toBeGreaterThan(0);
  });

  it("covers every forge and agora channel plus announcements and banter", () => {
    const names = CHANNEL_GUIDES.map((g) => g.channel);
    for (const ch of [
      "announcements",
      "general",
      "help",
      "ideas",
      "gallery-spotlight",
      "demo-clinic",
      "factory",
      "oracles",
      "aimarket",
      "argus",
      "banter",
    ]) {
      expect(names, `missing guide for #${ch}`).toContain(ch);
    }
  });
});
