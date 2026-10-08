import { describe, expect, it } from "vitest";
import { extractDemoUrl, resolveDemoForTopic } from "../src/mnemosyne/demo-urls.js";

const ALIEN_README = `
# Alien Monitor

3D ecosystem observatory.

**Live demo:** https://monitor.modelmarket.dev/

[![CI](https://img.shields.io/badge/ci-passing)](https://github.com/alexar76/alien-monitor)
`;

const AICOM_README = `
# AICOM

- Site: https://magic-ai-factory.com/
- Monitor: https://monitor.modelmarket.dev/
- Admin: https://magic-ai-factory.com/admin/login
- API: https://magic-ai-factory.com/landing-page-generation/api/generate
`;

describe("extractDemoUrl", () => {
  it("prefers URLs on demo-labelled lines", () => {
    expect(extractDemoUrl(ALIEN_README)).toBe("https://monitor.modelmarket.dev/");
  });

  it("skips admin and API paths", () => {
    const url = extractDemoUrl(AICOM_README);
    expect(url).toBe("https://monitor.modelmarket.dev/");
    expect(url).not.toContain("/admin/");
    expect(url).not.toContain("/api/");
  });

  it("returns null when no acceptable demo URL exists", () => {
    expect(extractDemoUrl("# Foo\nOnly https://github.com/org/repo")).toBeNull();
  });
});

describe("resolveDemoForTopic", () => {
  const registry = new Map<string, string>([
    ["alien-monitor", "https://monitor.modelmarket.dev/"],
    ["argus", "https://magic-ai-factory.com/arena"],
    ["aicom", "https://magic-ai-factory.com/"],
  ]);

  it("matches spotlight topics to repo demos", () => {
    expect(resolveDemoForTopic("Alien Monitor — the 3D ecosystem observatory", registry)).toEqual({
      repo: "alien-monitor",
      url: "https://monitor.modelmarket.dev/",
    });
  });

  it("matches ARGUS personal agent topic", () => {
    const m = resolveDemoForTopic("ARGUS personal agent and the WARDEN MCP firewall", registry);
    expect(m?.repo).toBe("argus");
  });

  it("returns null for generic topics with no product match", () => {
    expect(
      resolveDemoForTopic("what shipped recently across the ecosystem", registry),
    ).toBeNull();
  });
});
