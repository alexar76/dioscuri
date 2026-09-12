/**
 * Persistent provision flags — one-time setup messages must never repeat across
 * reboots, even when pins are missing or two containers boot at once.
 */

import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function provisionFlagPath(dataDir: string, key: string): string {
  return join(dataDir, `provision-${key}.flag`);
}

function provisionLockPath(dataDir: string, key: string): string {
  return join(dataDir, `provision-${key}.lock`);
}

export function hasProvisionFlag(dataDir: string, key: string): boolean {
  if (dataDir === "") return false;
  return existsSync(provisionFlagPath(dataDir, key));
}

/** Record that a one-time setup message was posted (message id optional). */
export function writeProvisionFlag(dataDir: string, key: string, note = ""): void {
  if (dataDir === "") return;
  mkdirSync(dataDir, { recursive: true });
  const line = note === "" ? `${new Date().toISOString()}\n` : `${new Date().toISOString()} ${note}\n`;
  writeFileSync(provisionFlagPath(dataDir, key), line, "utf8");
}

export function readProvisionFlag(dataDir: string, key: string): string {
  if (dataDir === "") return "";
  try {
    return readFileSync(provisionFlagPath(dataDir, key), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Short-lived exclusive lock for check-and-post windows. Returns false when
 * another instance holds the lock (EEXIST). Stale locks from crashed processes
 * are removed when older than maxAgeMs (default 10 min).
 */
export function tryProvisionLock(dataDir: string, key: string, maxAgeMs = 10 * 60 * 1000): boolean {
  if (dataDir === "") return true;
  mkdirSync(dataDir, { recursive: true });
  const lockPath = provisionLockPath(dataDir, key);
  if (existsSync(lockPath)) {
    try {
      const raw = readFileSync(lockPath, "utf8").trim();
      const ts = Date.parse(raw);
      if (!Number.isNaN(ts) && Date.now() - ts > maxAgeMs) {
        unlinkSync(lockPath);
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeFileSync(fd, `${new Date().toISOString()}\n`);
    closeSync(fd);
    return true;
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as Error & { code: string }).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export function releaseProvisionLock(dataDir: string, key: string): void {
  if (dataDir === "") return;
  try {
    unlinkSync(provisionLockPath(dataDir, key));
  } catch {
    // already gone
  }
}
