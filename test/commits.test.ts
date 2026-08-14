/**
 * Recent-changes awareness: fetchCommits parsing (merge commits skipped) and
 * the per-repo "recent changes" digest chunk built by a sync pass.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MnemosyneKB } from "../src/mnemosyne/index.js";
import { prepareUntrusted } from "../src/aegis/sanitize.js";
import type { AegisGate, Logger } from "../src/types.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

const stubAegis: AegisGate = {
  inspect(text, opts) {
    const sanitizedText = prepareUntrusted(text, opts?.maxLen ?? 4000);
    const reject = /ignore all previous/i.test(sanitizedText);
    return { action: reject ? "reject" : "allow", score: 1, findings: [], sanitizedText };
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** GitHub API stub: one repo, no readme, no releases, three commits. */
function githubFetch(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  if (u.includes("/users/")) {
    return Promise.resolve(
      json([
        {
          name: "argus",
          description: "reference agent",
          topics: ["ai"],
          html_url: "https://github.com/alexar76/argus",
          updated_at: "2026-07-01T00:00:00Z",
        },
      ]),
    );
  }
  if (u.includes("/readme")) return Promise.resolve(new Response("nope", { status: 404 }));
  if (u.includes("/releases")) return Promise.resolve(json([]));
  if (u.includes("/commits")) {
    return Promise.resolve(
      json([
        {
          sha: "abcdef1234567",
          html_url: "https://github.com/alexar76/argus/commit/abcdef1",
          commit: {
            message: "feat(warden): add threat-feed gate\n\nlong body here",
            author: { date: "2026-07-03T10:00:00Z" },
          },
        },
        {
          sha: "1234567abcdef",
          html_url: "https://github.com/alexar76/argus/commit/1234567",
          commit: {
            message: "Merge pull request #12 from x/y",
            author: { date: "2026-07-02T10:00:00Z" },
          },
        },
        {
          sha: "fedcba7654321",
          html_url: "https://github.com/alexar76/argus/commit/fedcba7",
          commit: {
            message: "fix(sealed): pin tool defs by sha256",
            author: { date: "2026-07-01T10:00:00Z" },
          },
        },
      ]),
    );
  }
  return Promise.resolve(new Response("unexpected " + u, { status: 500 }));
}

describe("recent-changes digest", () => {
  it("builds a searchable per-repo digest chunk; merge commits excluded", async () => {
    const kb = new MnemosyneKB({
      dataDir: mkdtempSync(join(tmpdir(), "dioscuri-commits-")),
      owner: "alexar76",
      repos: ["argus"],
      intervalMin: 30,
      aegis: stubAegis,
      log: noopLogger,
      fetchFn: vi.fn(githubFetch) as unknown as typeof fetch,
      now: () => new Date("2026-07-04T12:00:00Z"),
    });

    await kb.syncOnce();

    const hits = kb.search("threat-feed gate warden", 3);
    expect(hits.length).toBeGreaterThan(0);
    const digest = hits[0]!.chunk;
    expect(digest.id).toBe("argus#changes#0");
    expect(digest.title).toBe("argus — recent changes");
    expect(digest.url).toBe("https://github.com/alexar76/argus/commits");
    expect(digest.text).toContain("feat(warden): add threat-feed gate");
    expect(digest.text).toContain("fix(sealed): pin tool defs by sha256");
    expect(digest.text).toContain("abcdef1"); // short sha
    expect(digest.text).not.toContain("Merge pull request");
    // Only the 2 real commits counted.
    expect(digest.text).toContain("2 commits");
  });

  it("requests commits with a since= window", async () => {
    const fetchFn = vi.fn(githubFetch);
    const kb = new MnemosyneKB({
      dataDir: mkdtempSync(join(tmpdir(), "dioscuri-commits-")),
      owner: "alexar76",
      repos: ["argus"],
      intervalMin: 30,
      aegis: stubAegis,
      log: noopLogger,
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => new Date("2026-07-15T00:00:00Z"),
    });

    await kb.syncOnce();

    const commitsCall = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.includes("/commits"));
    expect(commitsCall).toBeDefined();
    // 14-day lookback from the injected clock.
    expect(commitsCall).toContain("since=2026-07-01");
  });
});
