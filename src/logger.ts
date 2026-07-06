/** Structured JSON-lines logger (stdout), docker-log friendly. */

import type { Logger } from "./types.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const minLevel: Level = (process.env.DIOSCURI_LOG_LEVEL as Level) || "info";
const minIdx = Math.max(0, LEVELS.indexOf(minLevel));

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS.indexOf(level) < minIdx) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...extra });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
    child: (s) => createLogger(`${scope}.${s}`),
  };
}
