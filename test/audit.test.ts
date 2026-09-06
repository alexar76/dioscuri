/**
 * FileAuditLog — hash-chain integrity tests.
 *
 * Pure-logic coverage for the OPS module: chain construction, tamper detection,
 * append serialisation under concurrency, and tail recovery across restarts.
 * Uses a throwaway tmp dir per test; no network, no mocks of node:crypto.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FileAuditLog } from "../src/audit.js";
import type { AuditEvent, Logger } from "../src/types.js";

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function ev(n: number): AuditEvent {
  return {
    ts: new Date(1_750_000_000_000 + n * 1000).toISOString(),
    platform: n % 2 === 0 ? "telegram" : "discord",
    kind: "test.event",
    actor: `actor-${n}`,
    subject: `subject-${n}`,
    data: { n, note: "sanitised-by-caller" },
  };
}

describe("FileAuditLog", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dioscuri-audit-"));
  });

  it("appends 3 events into an intact chain (verify() === -1)", async () => {
    const audit = new FileAuditLog(dir, silentLogger);
    const entries = [];
    for (let i = 0; i < 3; i++) entries.push(await audit.append(ev(i)));

    // Chain linkage: genesis prev, then each entry points at its predecessor.
    expect(entries[0]!.prevHash).toBe("0".repeat(64));
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(entries[2]!.prevHash).toBe(entries[1]!.hash);

    await expect(audit.verify()).resolves.toBe(-1);
  });

  it("detects a tampered middle line and returns its index", async () => {
    const audit = new FileAuditLog(dir, silentLogger);
    for (let i = 0; i < 3; i++) await audit.append(ev(i));

    const file = join(dir, "audit.jsonl");
    const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim() !== "");
    const middle = JSON.parse(lines[1]!) as Record<string, unknown>;
    middle["actor"] = "forged-actor"; // change hashed material, keep stored hash
    lines[1] = JSON.stringify(middle);
    await writeFile(file, lines.join("\n") + "\n", "utf8");

    await expect(audit.verify()).resolves.toBe(1);
  });

  it("keeps a valid chain under concurrent Promise.all appends", async () => {
    const audit = new FileAuditLog(dir, silentLogger);
    const entries = await Promise.all(Array.from({ length: 10 }, (_, i) => audit.append(ev(i))));

    // Every entry must link to the previous one — no interleaved/raced writes.
    let prev = "0".repeat(64);
    for (const e of entries) {
      expect(e.prevHash).toBe(prev);
      prev = e.hash;
    }
    await expect(audit.verify()).resolves.toBe(-1);

    // On disk: exactly 10 parseable lines.
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(raw.split("\n").filter((l) => l.trim() !== "")).toHaveLength(10);
  });

  it("recovers the tail hash across restarts and continues the chain", async () => {
    const first = new FileAuditLog(dir, silentLogger);
    const last = await first.append(ev(0)).then(() => first.append(ev(1)));

    const second = new FileAuditLog(dir, silentLogger); // fresh instance, same dir
    const next = await second.append(ev(2));
    expect(next.prevHash).toBe(last.hash);
    await expect(second.verify()).resolves.toBe(-1);
  });

  it("falls back to genesis on a corrupted tail without throwing", async () => {
    const file = join(dir, "audit.jsonl");
    await writeFile(file, "{not json at all\n", "utf8");

    let warned = false;
    const spyLogger: Logger = { ...silentLogger, warn: () => void (warned = true) };
    const audit = new FileAuditLog(dir, spyLogger);
    expect(warned).toBe(true);

    // New entries restart from genesis; verify() still flags the corrupt line 0.
    const entry = await audit.append(ev(0));
    expect(entry.prevHash).toBe("0".repeat(64));
    await expect(audit.verify()).resolves.toBe(0);
  });
});
