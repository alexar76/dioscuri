/**
 * KERYX sink — Bluesky (AT Protocol), POST-ONLY by charter.
 *
 * Publishes one short text post to OUR OWN account via
 * com.atproto.server.createSession + com.atproto.repo.createRecord. Nothing
 * else: no replies, likes, follows, DMs, or reading anyone's content.
 *
 * Constraints honoured here:
 *  - 300-GRAPHEME limit (Bluesky counts graphemes, not code units): truncate
 *    on a sentence boundary + "…" BEFORE facets are computed.
 *  - Link facets use BYTE offsets (UTF-8), not char offsets — the post text
 *    may contain emoji/multibyte, so prefixes go through Buffer.byteLength.
 *  - Lazy session: created on first post, cached, re-created ONCE on a 401.
 *  - 15s timeout per HTTP call (AbortController).
 *  - Fail-soft contract: throws on failure (caller logs + skips); error
 *    messages are scrubbed of the app password and JWTs — secrets never leak
 *    into logs.
 */

import type { Logger, SyndicationSink } from "../types.js";
import { graphemes, truncateGraphemes } from "../shared/index.js";

const TIMEOUT_MS = 15_000;
const MAX_GRAPHEMES = 300;
const URL_RE = /https:\/\/[^\s<>]+/g;

interface BskySession {
  accessJwt: string;
  did: string;
}

interface LinkFacet {
  index: { byteStart: number; byteEnd: number };
  features: { $type: "app.bsky.richtext.facet#link"; uri: string }[];
}

/** Byte-offset link facets for every https URL in the (already capped) text. */
export function linkFacets(text: string): LinkFacet[] {
  const facets: LinkFacet[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const uri = m[0].replace(/[.,;:!?…)\]]+$/, ""); // drop trailing punctuation
    if (uri.length <= "https://".length) continue;
    const byteStart = Buffer.byteLength(text.slice(0, m.index), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(uri, "utf8");
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    });
  }
  return facets;
}

function scrub(msg: string, secrets: string[]): string {
  let out = msg;
  for (const s of secrets) if (s !== "") out = out.split(s).join("***");
  return out;
}

export function createBlueskySink(opts: {
  identifier: string;
  appPassword: string;
  log: Logger;
  fetchFn?: typeof fetch;
  service?: string;
}): SyndicationSink {
  const fetchFn = opts.fetchFn ?? fetch;
  const service = (opts.service ?? "https://bsky.social").replace(/\/+$/, "");
  const log = opts.log.child("bluesky");
  let session: BskySession | null = null;

  const secrets = (): string[] => [opts.appPassword, session?.accessJwt ?? ""];

  async function request(path: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetchFn(`${service}${path}`, { ...init, signal: ctrl.signal });
    } catch (err) {
      throw new Error(scrub(`bluesky request failed: ${String(err)}`, secrets()));
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureSession(): Promise<BskySession> {
    if (session !== null) return session;
    const res = await request("/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: opts.identifier, password: opts.appPassword }),
    });
    if (!res.ok) throw new Error(`bluesky createSession failed: HTTP ${res.status}`);
    const data = (await res.json()) as { accessJwt?: string; did?: string };
    if (typeof data.accessJwt !== "string" || typeof data.did !== "string") {
      throw new Error("bluesky createSession: malformed response");
    }
    session = { accessJwt: data.accessJwt, did: data.did };
    log.debug("session created");
    return session;
  }

  async function createRecord(sess: BskySession, text: string): Promise<Response> {
    const facets = linkFacets(text);
    const record: Record<string, unknown> = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
    };
    if (facets.length > 0) record.facets = facets;
    return request("/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${sess.accessJwt}`,
      },
      body: JSON.stringify({ repo: sess.did, collection: "app.bsky.feed.post", record }),
    });
  }

  return {
    name: "bluesky",
    async post(text: string): Promise<void> {
      const body = truncateGraphemes(text, MAX_GRAPHEMES); // BEFORE facets
      let sess = await ensureSession();
      let res = await createRecord(sess, body);
      if (res.status === 401) {
        // Expired token: re-create the session exactly once and retry.
        session = null;
        sess = await ensureSession();
        res = await createRecord(sess, body);
      }
      if (!res.ok) throw new Error(`bluesky createRecord failed: HTTP ${res.status}`);
      log.info("posted", { graphemes: graphemes(body).length });
    },
  };
}
