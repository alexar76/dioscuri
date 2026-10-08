/**
 * Audit chain — append-only, hash-chained JSONL (the tamper-evident flight recorder).
 *
 * Every consequential act (moderation action, AEGIS rejection, promo post, KB sync)
 * is written to `<dataDir>/audit.jsonl` as one JSON line whose `hash` commits to the
 * previous line's hash: sha256(prevHash + JSON.stringify([ts,platform,kind,actor,
 * subject,data])). Editing or deleting any historical line breaks every hash after
 * it, so `verify()` can point at the first forged entry.
 *
 * Constraints:
 *  - Appends are serialised through an internal promise queue: concurrent callers
 *    never interleave writes or race the tail hash.
 *  - Callers must pass AEGIS-sanitised text in `data`/`subject` (house rule: raw
 *    chat/doc text never reaches storage). This module stores what it is given —
 *    sanitising here would silently change the hashed material.
 *  - Corruption is tolerated, not hidden: an unreadable tail restarts the chain at
 *    genesis and logs a warning; verify() still exposes the broken index.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditChainEntry, AuditEvent, AuditLog, Logger } from "./types.js";

const GENESIS_HASH = "0".repeat(64);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Deterministic entry hash. Array form (not object) fixes the field order. */
function entryHash(prevHash: string, ev: AuditEvent): string {
  const material = JSON.stringify([ev.ts, ev.platform, ev.kind, ev.actor, ev.subject, ev.data]);
  return createHash("sha256").update(prevHash + material).digest("hex");
}

function nonEmptyLines(raw: string): string[] {
  return raw.split("\n").filter((l) => l.trim() !== "");
}

function loadPseudonymKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length >= 32) return key;
  }
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

export class FileAuditLog implements AuditLog {
  private readonly file: string;
  private readonly log: Logger;
  /** Hash of the last entry on disk (genesis when the chain is empty). */
  private tailHash: string;
  /** Serialises appends; each write awaits the previous one. */
  private queue: Promise<unknown> = Promise.resolve();

  /** HMAC key for member pseudonyms (see pseudonym()). */
  private readonly pseudonymKey: Buffer;

  constructor(dataDir: string, log: Logger) {
    this.log = log;
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "audit.jsonl");
    this.tailHash = this.recoverTailHash();
    this.pseudonymKey = loadPseudonymKey(join(dataDir, "audit-pseudonym.key"));
  }

  /**
   * A Telegram/Discord member id as the chain stores it: `tg:h:<hmac>`. The chain cannot
   * delete a line, so a raw id written here was kept forever; with a keyed pseudonym the
   * same member still links up across entries, and destroying the key unlinks them all
   * while every hash stays verifiable.
   */
  private pseudonym(value: string): string {
    const m = /^(tg|dc):(\d+)$/.exec(value);
    if (!m) return value;
    const tag = createHmac("sha256", this.pseudonymKey).update(value).digest("hex").slice(0, 20);
    return `${m[1]}:h:${tag}`;
  }

  /**
   * Recover the chain tail from the last line of an existing file. Any kind of
   * corruption (truncated JSON, missing/malformed hash) falls back to genesis —
   * the process must come up even over a damaged file; verify() reports the damage.
   */
  private recoverTailHash(): string {
    if (!existsSync(this.file)) return GENESIS_HASH;
    try {
      const lines = nonEmptyLines(readFileSync(this.file, "utf8"));
      const last = lines[lines.length - 1];
      if (last === undefined) return GENESIS_HASH; // file exists but is empty
      const parsed = JSON.parse(last) as Partial<AuditChainEntry>;
      if (typeof parsed.hash === "string" && SHA256_HEX_RE.test(parsed.hash)) {
        return parsed.hash;
      }
      throw new Error("last entry lacks a valid sha256 hash");
    } catch (err) {
      this.log.warn("audit tail unreadable — restarting chain at genesis", {
        file: this.file,
        error: String(err),
      });
      return GENESIS_HASH;
    }
  }

  append(raw: AuditEvent): Promise<AuditChainEntry> {
    const ev: AuditEvent = {
      ...raw,
      actor: typeof raw.actor === "string" ? this.pseudonym(raw.actor) : raw.actor,
      subject: typeof raw.subject === "string" ? this.pseudonym(raw.subject) : raw.subject,
    };
    const task = this.queue.then(async (): Promise<AuditChainEntry> => {
      const prevHash = this.tailHash;
      const entry: AuditChainEntry = { ...ev, prevHash, hash: entryHash(prevHash, ev) };
      await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
      this.tailHash = entry.hash; // advance only after the write landed
      return entry;
    });
    // A failed write must not poison the queue for later appends.
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * Recompute the whole chain from disk. Returns the index (0-based line number
   * among non-empty lines) of the first broken entry, or -1 when intact.
   * Runs behind the append queue so it never observes a half-written line.
   */
  verify(): Promise<number> {
    const task = this.queue.then(async (): Promise<number> => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch {
        return -1; // no file yet — an empty chain is intact
      }
      const lines = nonEmptyLines(raw);
      let prev = GENESIS_HASH;
      for (let i = 0; i < lines.length; i++) {
        let entry: AuditChainEntry;
        try {
          entry = JSON.parse(lines[i] ?? "") as AuditChainEntry;
        } catch {
          return i; // unparseable line = broken entry
        }
        if (entry.prevHash !== prev) return i;
        if (entryHash(prev, entry) !== entry.hash) return i;
        prev = entry.hash;
      }
      return -1;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
