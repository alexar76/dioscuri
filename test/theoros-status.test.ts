import { describe, expect, it } from "vitest";
import { computeTheorosStatus } from "../src/theoros-status.js";

describe("computeTheorosStatus", () => {
  const slots = [{ kind: "canon" as const, day: "sun" as const, hourUtc: 16 }];

  it("active when all gates pass", () => {
    const s = computeTheorosStatus({
      discordReady: true,
      canonChannelId: "123",
      githubRepos: ["dioscuri", "theoros"],
      slots,
    });
    expect(s.active).toBe(true);
    expect(s).toMatchObject({ discord: true, canonChannel: true, slot: true, kb: true });
  });

  it("inactive without canon channel", () => {
    const s = computeTheorosStatus({
      discordReady: true,
      canonChannelId: "",
      githubRepos: ["theoros"],
      slots,
    });
    expect(s.active).toBe(false);
    expect(s.canonChannel).toBe(false);
  });

  it("inactive without theoros in KB repos", () => {
    const s = computeTheorosStatus({
      discordReady: true,
      canonChannelId: "123",
      githubRepos: ["dioscuri"],
      slots,
    });
    expect(s.active).toBe(false);
    expect(s.kb).toBe(false);
  });
});
