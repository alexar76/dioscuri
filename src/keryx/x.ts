/**
 * KERYX sink — X (Twitter) v2, POST-ONLY by charter.
 *
 * Publishes one tweet to OUR OWN account via POST https://api.x.com/2/tweets
 * with OAuth 1.0a User Context signing done by hand on node:crypto
 * (HMAC-SHA1) — no SDK. Nothing else: no replies, likes, retweets, follows,
 * DMs, or reading anyone's content.
 *
 * COST NOTE: on X, every URL is wrapped by t.co and billed at a flat ~23
 * characters (~13x the cost of a short word) — keep URLs out of tweets unless
 * essential. Our release format includes the GitHub release URL deliberately:
 * exactly ONE URL per post, budgeted into the 280-char cap.
 *
 * Signing recipe (RFC 5849 for this exact endpoint):
 *  - oauth_* params only — the JSON body is NOT part of the signature base
 *    for api.x.com v2 (only form-encoded bodies/query params would be, and
 *    this request has neither).
 *  - percent-encoding per RFC 3986: encodeURIComponent + escape !'()*.
 *  - base string = "POST" & enc(url) & enc(sorted "k=v" params joined by &).
 *  - signing key = enc(consumerSecret) & enc(tokenSecret).
 *
 * Constraints honoured here:
 *  - 280-character cap: truncate on a sentence boundary + "…".
 *  - 15s timeout (AbortController).
 *  - Fail-soft contract: throws on failure (caller logs + skips); error
 *    messages are scrubbed of all four secrets — they never leak into logs.
 */

import { createHmac, randomBytes } from "node:crypto";
import type { Logger, SyndicationSink } from "../types.js";
import { truncateChars } from "../shared/index.js";

const TIMEOUT_MS = 15_000;
const MAX_CHARS = 280;
const TWEETS_URL = "https://api.x.com/2/tweets";

/** RFC 3986 percent-encoding (strict): encodeURIComponent + escape !'()*. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Build the OAuth 1.0a Authorization header for POST {TWEETS_URL}. */
function oauthHeader(creds: {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}): string {
  const params: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const paramString = Object.keys(params)
    .map((k) => [rfc3986(k), rfc3986(params[k] ?? "")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `POST&${rfc3986(TWEETS_URL)}&${rfc3986(paramString)}`;
  const signingKey = `${rfc3986(creds.apiSecret)}&${rfc3986(creds.accessSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  const all: Record<string, string> = { ...params, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(all)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(all[k] ?? "")}"`)
      .join(", ")
  );
}

export function createXSink(opts: {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  log: Logger;
  fetchFn?: typeof fetch;
}): SyndicationSink {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log.child("x");
  const secrets = [opts.apiKey, opts.apiSecret, opts.accessToken, opts.accessSecret];

  const scrub = (msg: string): string => {
    let out = msg;
    for (const s of secrets) if (s !== "") out = out.split(s).join("***");
    return out;
  };

  return {
    name: "x",
    async post(text: string): Promise<void> {
      const body = truncateChars(text, MAX_CHARS);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchFn(TWEETS_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: oauthHeader(opts),
          },
          body: JSON.stringify({ text: body }),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new Error(scrub(`x request failed: ${String(err)}`));
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`x tweet failed: HTTP ${res.status}`);
      log.info("posted", { chars: body.length });
    },
  };
}
