/**
 * Health endpoint — a tiny node:http server, the container's only inbound surface.
 *
 * GET /health returns liveness + a status snapshot (adapter readiness, MNEMOSYNE
 * stats, dry-run flag) as JSON; every other path is a JSON 404. Docker's
 * HEALTHCHECK and compose probe this URL.
 *
 * Constraints:
 *  - Request bodies are never read: nothing inbound is parsed, stored or logged,
 *    so this surface is inert to injection by construction.
 *  - The server is deliberately NOT unref()'d — in dry-run mode (no platform
 *    adapters) it is what keeps the process alive.
 *  - getStatus() is caller-supplied (DI); a throwing snapshot degrades to a 500
 *    instead of crashing the process.
 */

import { createServer } from "node:http";
import type { Logger, MnemosyneStats } from "./types.js";

export interface HealthServerOptions {
  port: number;
  version: string;
  log: Logger;
  getStatus: () => { adapters: Record<string, boolean>; kb: MnemosyneStats; dryRun: boolean };
}

export function createHealthServer(opts: HealthServerOptions): { close(): Promise<void> } {
  const { port, version, log, getStatus } = opts;

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && path === "/health") {
      try {
        const status = getStatus();
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: true,
            version,
            uptimeSec: Math.round(process.uptime()),
            adapters: status.adapters,
            kb: status.kb,
            dryRun: status.dryRun,
          }),
        );
      } catch (err) {
        log.error("health snapshot failed", { error: String(err) });
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });

  server.on("error", (err) => {
    log.error("health server error", { port, error: String(err) });
  });

  server.listen(port, () => {
    log.info("health endpoint listening", { port });
  });

  return {
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.closeAllConnections(); // drop keep-alive probes so close() cannot hang
        server.close(() => resolve());
      });
    },
  };
}
