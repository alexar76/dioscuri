import { describe, expect, it } from "vitest";
import { CASTOR } from "../src/personas/index.js";
import { releaseBlurb, stripMarkdown } from "../src/shared/text.js";
import type { CrossLinks, ReleaseEvent } from "../src/types.js";

const LINKS: CrossLinks = {
  discordInvite: "https://discord.gg/aimarket",
  telegramChannel: "https://t.me/just_for_agents",
  siteUrl: "https://magic-ai-factory.com",
  githubOrg: "https://github.com/alexar76",
  theorosUrl: "https://alexar76.github.io/theoros/",
};

const DIOSCURI_NOTES = `## DIOSCURI v0.1.0

**Twin community agents for the AICOM ecosystem**

- **CASTOR** — Telegram (grammY long-polling)
- **POLLUX** — Discord (discord.js gateway)

### Install

\`\`\`bash
npm install -g @alexar76/dioscuri
cp dioscuri.config.example.json dioscuri.config.json
\`\`\`
`;

describe("stripMarkdown / releaseBlurb", () => {
  it("strips GitHub release-note markdown walls", () => {
    const plain = stripMarkdown(DIOSCURI_NOTES);
    expect(plain).not.toContain("##");
    expect(plain).not.toContain("**");
    expect(plain).not.toContain("```");
    expect(plain).toContain("DIOSCURI v0.1.0");
    expect(plain).toContain("Twin community agents");
  });

  it("releaseBlurb caps to a short plain sentence", () => {
    const blurb = releaseBlurb(DIOSCURI_NOTES, 120);
    expect(blurb.length).toBeLessThanOrEqual(120);
    expect(blurb).not.toMatch(/[#*`]/);
  });
});

describe("CASTOR.releaseAnnouncement", () => {
  it("never posts raw markdown to Telegram", () => {
    const ev: ReleaseEvent = {
      repo: "dioscuri",
      tag: "v0.1.0",
      name: "v0.1.0",
      url: "https://github.com/alexar76/dioscuri/releases/tag/v0.1.0",
      summary: DIOSCURI_NOTES,
      publishedAt: "2026-07-06T10:00:00Z",
    };
    const text = CASTOR.releaseAnnouncement(LINKS, ev);
    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).not.toContain("```");
    expect(text).toContain("dioscuri v0.1.0");
    expect(text).toContain(ev.url);
  });
});
