import { describe, expect, it } from "vitest";
import {
  demoScreenshotScore,
  isEligibleDemoScreenshotUrl,
  pickDemoScreenshotTargets,
} from "../src/mnemosyne/demo-screenshots.js";

describe("demo screenshot URL filter", () => {
  it("rejects broken or non-visual URLs", () => {
    expect(isEligibleDemoScreenshotUrl("https://lottery.modelmarket.dev/**")).toBe(false);
    expect(isEligibleDemoScreenshotUrl("https://crates.io/crates/foo")).toBe(false);
    expect(isEligibleDemoScreenshotUrl("https://oracles.modelmarket.dev/platon/umbral")).toBe(false);
    expect(isEligibleDemoScreenshotUrl("https://monitor.modelmarket.dev/")).toBe(true);
  });

  it("prefers magic-ai-factory demos", () => {
    expect(demoScreenshotScore("https://monitor.modelmarket.dev/")).toBeGreaterThan(
      demoScreenshotScore("https://modeldev.modelmarket.dev/"),
    );
  });

  it("dedupes and caps ranked targets", () => {
    const picked = pickDemoScreenshotTargets(
      [
        { repo: "a", url: "https://monitor.modelmarket.dev/" },
        { repo: "b", url: "https://monitor.modelmarket.dev/" },
        { repo: "c", url: "https://magic-ai-factory.com/argus/" },
        { repo: "d", url: "https://crates.io/crates/x" },
      ],
      2,
    );
    expect(picked).toHaveLength(2);
    expect(picked.map((p) => p.url)).not.toContain("https://crates.io/crates/x");
  });
});
