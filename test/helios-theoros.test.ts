/**
 * THEOROS → HELIOS syndication: Dioscuri must pass Theoros's own words.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  enqueueReleaseVideo,
  enqueueTheorosFromCanonPost,
  enqueueTheorosVideo,
  theorosVoBeats,
} from "../src/helios/enqueue.js";
import type { Logger } from "../src/types.js";

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("theorosVoBeats", () => {
  it("keeps Theoros sentences — does not invent copy", () => {
    const column =
      "Agents without receipts are pets. Sovereignty starts when an invoke can be verified on-chain. " +
      "If the hub can rewrite history, the agent never owned the act.";
    const debate = "Who amends the canon when nobody debates?";
    const beats = theorosVoBeats(column, debate);
    expect(column.startsWith(beats.hook.slice(0, 20))).toBe(true);
    expect(column).toContain(beats.body.slice(0, Math.min(40, beats.body.length)));
    expect(beats.debate).toBe(debate);
  });

  it("scrubs brace placeholders so Helios substitution cannot eat prose", () => {
    const beats = theorosVoBeats("Claim {repo} quietly. Second sentence holds.", "Ask?");
    expect(beats.hook).not.toContain("{");
    expect(beats.hook).toContain("repo");
  });
});

describe("enqueueTheorosVideo", () => {
  it("writes theoros-short jsonl with the full column for audit", () => {
    const dir = mkdtempSync(join(tmpdir(), "helios-theoros-"));
    dirs.push(dir);
    const queue = join(dir, "helios-queue.jsonl");
    const column =
      "Weak aggregation is tyranny dressed as quorum. Name the proof or refuse the vote.";
    const debate = "Is a silent council still a council?";

    enqueueTheorosVideo(
      {
        chapterLabel: "Chapter 7 — Weak councils",
        column,
        debateHook: debate,
        canonUrl: "https://alexar76.github.io/theoros/",
        chapterKey: "7:abc",
      },
      { log, queuePath: queue },
    );

    const line = readFileSync(queue, "utf8").trim();
    const job = JSON.parse(line) as {
      template: string;
      source: string;
      vars: Record<string, string>;
      youtube: { title: string; privacy: string };
      idempotency_key: string;
    };
    expect(job.template).toBe("theoros-short");
    expect(job.source).toBe("dioscuri-theoros");
    expect(job.vars.column).toBe(column);
    expect(job.vars.hook.length).toBeGreaterThan(10);
    expect(column.startsWith(job.vars.hook.slice(0, 15))).toBe(true);
    expect(job.vars.debate).toBe(debate);
    expect(job.youtube.title).toContain("THEOROS");
    expect(job.youtube.privacy).toBe("private");
    expect(job.idempotency_key).toBe("theoros:7:abc");
  });

  it("enqueueTheorosFromCanonPost uses body + debateHook unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "helios-theoros-"));
    dirs.push(dir);
    const queue = join(dir, "q.jsonl");
    const body = "Invoke is a contract. Unsigned work is charity with a receipt.";
    enqueueTheorosFromCanonPost(
      {
        chapterLabel: "Chapter 3 — Invoke",
        body,
        debateHook: "Who signs first?",
        canonUrl: "https://alexar76.github.io/theoros/",
      },
      "3:inv",
      { log, queuePath: queue },
    );
    const job = JSON.parse(readFileSync(queue, "utf8").trim()) as { vars: Record<string, string> };
    expect(job.vars.column).toBe(body);
    expect(job.vars.debate).toBe("Who signs first?");
  });
});

describe("enqueueReleaseVideo", () => {
  it("skips release-short unless HELIOS_RELEASE_SHORTS=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "helios-rel-"));
    dirs.push(dir);
    const queue = join(dir, "q.jsonl");
    const prev = process.env.HELIOS_RELEASE_SHORTS;
    const synd = process.env.HELIOS_SYNDICATION;
    const pathEnv = process.env.HELIOS_QUEUE_PATH;
    process.env.HELIOS_SYNDICATION = "1";
    process.env.HELIOS_QUEUE_PATH = queue;
    delete process.env.HELIOS_RELEASE_SHORTS;
    try {
      enqueueReleaseVideo(
        {
          repo: "alexar76/aicom",
          tag: "v9.9.9",
          url: "https://github.com/alexar76/aicom/releases/tag/v9.9.9",
          summary: "boring",
        },
        { log, queuePath: queue },
      );
      expect(existsSync(queue) ? readFileSync(queue, "utf8").trim() : "").toBe("");
      process.env.HELIOS_RELEASE_SHORTS = "1";
      enqueueReleaseVideo(
        {
          repo: "alexar76/aicom",
          tag: "v9.9.9",
          url: "https://github.com/alexar76/aicom/releases/tag/v9.9.9",
          summary: "boring",
        },
        { log, queuePath: queue },
      );
      const job = JSON.parse(readFileSync(queue, "utf8").trim()) as { template: string };
      expect(job.template).toBe("release-short");
    } finally {
      if (prev === undefined) delete process.env.HELIOS_RELEASE_SHORTS;
      else process.env.HELIOS_RELEASE_SHORTS = prev;
      if (synd === undefined) delete process.env.HELIOS_SYNDICATION;
      else process.env.HELIOS_SYNDICATION = synd;
      if (pathEnv === undefined) delete process.env.HELIOS_QUEUE_PATH;
      else process.env.HELIOS_QUEUE_PATH = pathEnv;
    }
  });
});
