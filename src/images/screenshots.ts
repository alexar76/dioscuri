/**
 * Screenshot capture via the optional Playwright sidecar (scripts/screenshot_server.py).
 *
 * POST {base}/v1/screenshots/capture with a demo URL from MNEMOSYNE's registry;
 * the sidecar pre-checks HTTP status, captures a PNG, and rejects blank/error
 * frames before returning bytes. Any failure throws ScreenshotProviderError —
 * callers fall back to text-only posts.
 */

import type { Logger, ScreenshotProvider } from "../types.js";
import { validatePngScreenshot } from "./screenshot-qc.js";

export class ScreenshotProviderError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotProviderError";
  }
}

export interface ScreenshotProviderOpts {
  baseUrl: string;
  log: Logger;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const BODY_EXCERPT = 200;

function scrub(msg: string, secrets: string[]): string {
  let out = msg;
  for (const s of secrets) if (s !== "") out = out.split(s).join("[redacted]");
  return out;
}

export function createScreenshotProvider(opts: ScreenshotProviderOpts): ScreenshotProvider {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log.child("screenshot");

  if (base === "") {
    throw new ScreenshotProviderError(undefined, "screenshot baseUrl is required");
  }

  return {
    name: "screenshot",
    async capture(url: string, o?: { viewport?: string }): Promise<Buffer> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchFn(`${base}/v1/screenshots/capture`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url,
            viewport: o?.viewport ?? "1280x720",
            wait_ms: 8000,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const excerpt = scrub(await res.text().catch(() => ""), []).slice(0, BODY_EXCERPT);
          throw new ScreenshotProviderError(res.status, `screenshot capture failed: ${excerpt}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const qc = validatePngScreenshot(buf);
        if (!qc.ok) {
          throw new ScreenshotProviderError(res.status, `screenshot QC failed: ${qc.reason}`);
        }
        log.info("captured", { url, bytes: buf.length });
        return buf;
      } catch (err) {
        if (err instanceof ScreenshotProviderError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw new ScreenshotProviderError(undefined, `screenshot network error: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
