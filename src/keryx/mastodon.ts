/**
 * KERYX sink — Mastodon, POST-ONLY by charter.
 *
 * Publishes one public status to OUR OWN account via POST /api/v1/statuses
 * with a Bearer token. Nothing else: no replies, boosts, favourites, follows,
 * DMs, or reading anyone's content.
 *
 * Constraints honoured here:
 *  - 500-character cap: truncate on a sentence boundary + "…".
 *  - 15s timeout (AbortController).
 *  - Fail-soft contract: throws on failure (caller logs + skips); error
 *    messages are scrubbed of the access token — secrets never leak into logs.
 */

import type { Logger, SyndicationSink } from "../types.js";
import { truncateChars } from "../shared/index.js";

const TIMEOUT_MS = 15_000;
const MAX_CHARS = 500;

export function createMastodonSink(opts: {
  baseUrl: string;
  accessToken: string;
  log: Logger;
  fetchFn?: typeof fetch;
}): SyndicationSink {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const log = opts.log.child("mastodon");

  const scrub = (msg: string): string =>
    opts.accessToken === "" ? msg : msg.split(opts.accessToken).join("***");

  return {
    name: "mastodon",
    async post(text: string): Promise<void> {
      const status = truncateChars(text, MAX_CHARS);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchFn(`${base}/api/v1/statuses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${opts.accessToken}`,
          },
          body: JSON.stringify({ status, visibility: "public" }),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new Error(scrub(`mastodon request failed: ${String(err)}`));
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`mastodon status post failed: HTTP ${res.status}`);
      log.info("posted", { chars: status.length });
    },
  };
}
