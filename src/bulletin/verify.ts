/**
 * BULLETIN / verify — the gate every advisory passes before the twins say a word.
 *
 * MOMUS publishes its security bulletin as ONE signed index:
 *
 *   { "advisories": Advisory[], "timestamp": <epoch ms int>, "signature": "<hex ed25519>" }
 *
 * where `signature` is Ed25519 over the RFC 8785 (JCS) canonical form of
 * `{advisories, timestamp}` — the same envelope shape MOMUS already uses for the
 * WARDEN threat feed (`momus/momus/warden_feed.py`) and the same verification
 * shape ARGUS applies to it (`argus/src/warden/threat-feed.ts`). Deliberately so:
 * one envelope, one canonicalizer (./jcs.ts), one failure philosophy.
 *
 * WHY THIS EXISTS AT ALL. Everything DIOSCURI posts goes out under our own
 * community bot, in our own name, into a public channel. An unverified advisory
 * would mean whoever controls the network path between us and MOMUS — a proxy, a
 * DNS answer, a compromised edge — gets to publish security accusations against
 * named components as if we had made them. Signature verification is therefore
 * not a nicety here; it is the difference between a bulletin and a megaphone
 * pointed at strangers.
 *
 * Three properties are enforced FAIL-CLOSED. Any of them failing posts NOTHING
 * and logs why — never a partial post, never a "best effort" fallback:
 *
 * - **Authenticity.** Ed25519 against a PINNED public key from config. No key
 *   configured means no posting at all: an unsigned bulletin is refused rather
 *   than trusted-because-it-arrived.
 * - **Freshness.** The signed `timestamp` must sit inside a window (default 24 h).
 *   Without it, whoever serves the URL can replay a months-old snapshot forever
 *   and silently erase every advisory published since — a signature says *who*
 *   wrote a document, never *when you were handed it*. For a bulletin that
 *   erasure is the whole attack: the advisory the operator most wants suppressed
 *   is the newest one.
 * - **Determinism.** The signed bytes are RFC 8785 canonical, so publisher and
 *   verifier agree on them regardless of the key order the wire used.
 *
 * WHAT THIS MODULE DOES *NOT* DO. It does not decide what to say. It extracts an
 * ALLOW-LIST of fields (see {@link toAdvisory}) and nothing else — no
 * `reproducer`, no `evidence`, no `target`, no `poc`, whatever else the payload
 * may carry. That is structural, not a filter: a field this module never reads
 * cannot reach a renderer, so an exploit cannot be published through the
 * community bot even if MOMUS's disclosure layer regresses and starts serving one.
 */

import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import type { Logger } from "../types.js";
import { CanonicalizationError, canonicalize, parseJsonStrict } from "./jcs.js";

/** Default freshness window for the signed index: 24 h. */
export const DEFAULT_BULLETIN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Tolerance for an index timestamp in the future — publisher/host clock skew.
 * Beyond it the index is refused: a future-dated snapshot would otherwise pass
 * the freshness check for as long as the date it claims.
 */
export const BULLETIN_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Hard cap on the index response body (OOM guard). */
const MAX_BULLETIN_BYTES = 512_000;

/** A hanging endpoint must never stall the poll loop. */
const FETCH_TIMEOUT_MS = 10_000;

/** Upper bound on advisories accepted from one index (runaway/DoS guard). */
const MAX_ADVISORIES = 500;

/** Longest raw string we keep from any advisory field before rendering caps it again. */
const MAX_FIELD_LEN = 4000;

export type AdvisoryStatus = "open" | "fixed" | "withdrawn";
const ADVISORY_STATUSES: readonly AdvisoryStatus[] = ["open", "fixed", "withdrawn"];

/** Severities MOMUS publishes. Anything else renders as "unspecified" — see {@link toAdvisory}. */
const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type AdvisorySeverity = (typeof SEVERITIES)[number] | "unspecified";

/**
 * The ONLY shape of an advisory this bot knows about.
 *
 * Every string in here is UNTRUSTED remote input — validated for shape, never for
 * truth — and is escaped/neutralised again by ./render.ts before it reaches a
 * platform. Field names follow MOMUS's `advisories` table (`momus/momus/store.py`).
 */
export interface Advisory {
  /** MOMUS-YYYY-NNNN. Charset-restricted (see ID_RE) because it lands in a title. */
  id: string;
  status: AdvisoryStatus;
  severity: AdvisorySeverity;
  /** Affected component, e.g. "aimarket-hub". Untrusted text. */
  component: string;
  /** One-paragraph description. Untrusted text — an advisory summary is remote input. */
  summary: string;
  /**
   * Link to the advisory page, or "" when the payload offered none — or offered
   * one that failed the origin check (see {@link isAllowedAdvisoryUrl}).
   */
  url: string;
  /** ISO-8601 publication date, or "". */
  published: string;
  /** ISO-8601 last-modified date, or "". This is the revision key for the diff. */
  modified: string;
}

/**
 * An advisory id is rendered into an embed title, used as a state-file key, and — the
 * reason this is strict rather than merely charset-restricted — printed on OUR OWN header
 * line, outside the quoted region that holds everything the feed wrote.
 *
 * The permissive version allowed dots and hyphens, so `momus-patch.xn--p1ai` was a VALID
 * id and rendered as a live host inside our own header: the one line a reader is entitled
 * to treat as ours. Validating against the contract MOMUS actually mints
 * (`MOMUS-YYYY-NNNN`) rejects it at the boundary, before any renderer has to be clever.
 * That is the right place: sanitising at render means every future renderer must remember.
 */
const ID_RE = /^MOMUS-\d{4}-\d{4,6}$/;

/** Dates are displayed verbatim, so they may only contain date characters. */
const DATE_RE = /^[0-9][0-9T:.+\-Z ]{3,39}$/;

/** Machine-readable refusal codes. Logged; never posted. */
export type BulletinRefusalCode =
  | "NO_PUBKEY"
  | "NO_URL"
  | "FETCH_FAILED"
  | "HTTP_ERROR"
  | "OVERSIZED"
  | "UNPARSEABLE"
  | "MALFORMED"
  | "BAD_PUBKEY"
  | "NO_CANONICAL_FORM"
  | "SIGNATURE_INVALID"
  | "STALE"
  | "FUTURE_DATED";

export interface VerifiedBulletin {
  advisories: Advisory[];
  /** The signed snapshot timestamp (epoch ms). */
  timestamp: number;
  /** Records dropped for failing shape validation (logged, never posted). */
  dropped: number;
  /** Advisory links dropped for pointing off the index's own origin. */
  droppedLinks: number;
}

export type VerifyResult =
  | { ok: true; bulletin: VerifiedBulletin }
  | { ok: false; code: BulletinRefusalCode; detail: string };

export interface VerifyOptions {
  /** Ed25519 public key of the bulletin publisher, hex-encoded SPKI DER. */
  publicKeyHex: string;
  /**
   * Maximum age of the signed `timestamp`. A non-finite or non-positive value
   * falls back to {@link DEFAULT_BULLETIN_MAX_AGE_MS} rather than disabling the
   * check — "freshness off" is not a configuration we offer.
   */
  maxAgeMs?: number;
  /**
   * Origin advisory links must sit under (normally the index URL's own origin).
   * A link that fails is dropped, not followed: see {@link isAllowedAdvisoryUrl}.
   */
  allowedUrlOrigin?: string;
  now?: () => number;
}

/**
 * Fetch and verify the signed index. NEVER throws and NEVER partially succeeds —
 * a scheduled publisher that crashes because a feed was down is worse than one
 * that skips a cycle.
 */
export async function fetchBulletinIndex(
  indexUrl: string,
  opts: VerifyOptions & { fetchFn?: typeof fetch; log?: Logger },
): Promise<VerifyResult> {
  if (indexUrl.trim() === "") {
    return { ok: false, code: "NO_URL", detail: "no bulletin index URL configured" };
  }
  // The pin is checked before the request: without it there is nothing to verify
  // against, so fetching would only teach us what an attacker wants us to say.
  if (opts.publicKeyHex.trim() === "") {
    return {
      ok: false,
      code: "NO_PUBKEY",
      detail:
        "bulletin index URL configured but no pinned publisher key — REFUSED; " +
        "posting an unverified advisory under our own bot would let whoever controls " +
        "the network path publish accusations in our name",
    };
  }

  const fetchFn = opts.fetchFn ?? fetch;
  let body: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetchFn(indexUrl, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      return { ok: false, code: "HTTP_ERROR", detail: `bulletin index fetch returned ${res.status}` };
    }
    // Reject oversized responses before reading them (OOM guard).
    const cl = res.headers.get("content-length");
    if (cl !== null && Number(cl) > MAX_BULLETIN_BYTES) {
      return {
        ok: false,
        code: "OVERSIZED",
        detail: `content-length ${cl} exceeds the ${MAX_BULLETIN_BYTES} byte limit`,
      };
    }
    // Read text, not res.json(): the received CHARACTERS are what the canonical
    // parser needs for its duplicate-key and number-literal checks, and what the
    // signature was computed over.
    body = await res.text();
  } catch (err) {
    return {
      ok: false,
      code: "FETCH_FAILED",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (Buffer.byteLength(body, "utf8") > MAX_BULLETIN_BYTES) {
    return {
      ok: false,
      code: "OVERSIZED",
      detail: `body exceeds the ${MAX_BULLETIN_BYTES} byte limit (content-length absent or wrong)`,
    };
  }
  return verifyBulletinPayload(body, {
    ...opts,
    allowedUrlOrigin: opts.allowedUrlOrigin ?? originOf(indexUrl),
  });
}

/**
 * Verify an already-fetched index body. Pure (no I/O, injectable clock) so the
 * whole crypto path is unit-testable without a network.
 *
 * Order is load-bearing:
 *  1. strict parse (duplicate keys / non-integer literals are the publisher's
 *     decision to make, not the parser's),
 *  2. envelope shape,
 *  3. signature,
 *  4. freshness — LAST, because until the signature verifies, `timestamp` is a
 *     number an attacker chose and refusing on it would prove nothing,
 *  5. per-advisory shape validation, which drops records instead of the index:
 *     one malformed advisory must not silence the ones that are fine.
 */
export function verifyBulletinPayload(body: string, opts: VerifyOptions): VerifyResult {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs =
    opts.maxAgeMs != null && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs > 0
      ? opts.maxAgeMs
      : DEFAULT_BULLETIN_MAX_AGE_MS;

  if (opts.publicKeyHex.trim() === "") {
    return { ok: false, code: "NO_PUBKEY", detail: "no pinned publisher key configured" };
  }

  let data: unknown;
  try {
    data = parseJsonStrict(body);
  } catch (err) {
    const detail = err instanceof CanonicalizationError ? err.message : (err as Error).message;
    return { ok: false, code: "UNPARSEABLE", detail };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: "MALFORMED", detail: "index is not a JSON object" };
  }

  const pkg = data as Record<string, unknown>;
  const advisories = pkg.advisories;
  const signature = pkg.signature;
  const timestamp = pkg.timestamp;
  if (!Array.isArray(advisories) || typeof signature !== "string") {
    return { ok: false, code: "MALFORMED", detail: "missing or invalid fields (advisories, signature)" };
  }
  if (advisories.length > MAX_ADVISORIES) {
    return {
      ok: false,
      code: "OVERSIZED",
      detail: `${advisories.length} advisories exceeds the ${MAX_ADVISORIES} limit`,
    };
  }
  // The timestamp is REQUIRED: it is what the freshness check is made of, and an
  // optional one would mean "an index that omits it is fresh forever".
  if (typeof timestamp !== "number" || !Number.isInteger(timestamp)) {
    return {
      ok: false,
      code: "MALFORMED",
      detail: "missing or non-integer `timestamp` (epoch ms) — freshness cannot be checked",
    };
  }

  let canonical: string;
  try {
    canonical = canonicalize({ advisories, timestamp });
  } catch (err) {
    const detail = err instanceof CanonicalizationError ? err.message : (err as Error).message;
    return { ok: false, code: "NO_CANONICAL_FORM", detail };
  }

  let pubKey;
  try {
    pubKey = createPublicKey({
      key: Buffer.from(opts.publicKeyHex.trim(), "hex"),
      format: "der",
      type: "spki",
    });
  } catch (err) {
    // A misconfigured pin must say so out loud: silently degrading here would
    // look exactly like "the bulletin had nothing new".
    return {
      ok: false,
      code: "BAD_PUBKEY",
      detail: `pinned key is not a valid hex SPKI DER Ed25519 key (${(err as Error).message})`,
    };
  }

  let signatureOk = false;
  try {
    signatureOk = ed25519Verify(null, Buffer.from(canonical, "utf8"), pubKey, Buffer.from(signature, "hex"));
  } catch (err) {
    // A malformed signature (odd hex, wrong length) verifies as "no", not as a throw.
    return { ok: false, code: "SIGNATURE_INVALID", detail: `signature unusable (${(err as Error).message})` };
  }
  if (!signatureOk) {
    return {
      ok: false,
      code: "SIGNATURE_INVALID",
      detail: "Ed25519 signature does not match the pinned key — index REJECTED, nothing posted",
    };
  }

  const age = now() - timestamp;
  if (age > maxAgeMs) {
    return {
      ok: false,
      code: "STALE",
      detail:
        `signed snapshot is ${formatDuration(age)} old, past the ${formatDuration(maxAgeMs)} limit — ` +
        `REJECTED as a possible replay hiding newer advisories`,
    };
  }
  if (age < -BULLETIN_CLOCK_SKEW_MS) {
    return {
      ok: false,
      code: "FUTURE_DATED",
      detail:
        `signed snapshot is dated ${formatDuration(-age)} in the future, beyond the ` +
        `${formatDuration(BULLETIN_CLOCK_SKEW_MS)} clock-skew allowance — REJECTED`,
    };
  }

  const parsed: Advisory[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let droppedLinks = 0;
  for (const raw of advisories) {
    const advisory = toAdvisory(raw, opts.allowedUrlOrigin);
    if (advisory === null) {
      dropped++;
      continue;
    }
    // A duplicate id in one index is a publisher bug; keeping the first occurrence
    // keeps the diff (which is keyed on id) deterministic.
    if (seen.has(advisory.advisory.id)) {
      dropped++;
      continue;
    }
    seen.add(advisory.advisory.id);
    if (advisory.linkDropped) droppedLinks++;
    parsed.push(advisory.advisory);
  }

  return { ok: true, bulletin: { advisories: parsed, timestamp, dropped, droppedLinks } };
}

/**
 * Project one raw record onto {@link Advisory} — the ALLOW-LIST that makes
 * publishing an exploit structurally impossible.
 *
 * Only these keys are ever read. A `reproducer`, `evidence`, `poc`, `target_url`
 * or any other field in the payload is not filtered out downstream; it is simply
 * never loaded, so no renderer can reach it and no future edit to a template can
 * accidentally interpolate it. MOMUS's disclosure design already omits those
 * fields from `open` advisories — this is the second lock, on our side of the
 * wire, because "the publisher promised" is not a control we own.
 *
 * `advisory_id` is MOMUS's own column name; `id` is accepted as an alias so the
 * publisher may serve either without a coordinated release.
 *
 * Returns null for a record we cannot render honestly (bad id, unknown status).
 * An unknown STATUS is a drop rather than a default: showing a fixed bug as open
 * (or the reverse) is a lie either way, and silence is the honest option.
 */
function toAdvisory(
  raw: unknown,
  allowedUrlOrigin?: string,
): { advisory: Advisory; linkDropped: boolean } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const id = str(r.advisory_id ?? r.id, 64);
  if (!ID_RE.test(id)) return null;

  const status = str(r.status, 20).toLowerCase();
  if (!ADVISORY_STATUSES.includes(status as AdvisoryStatus)) return null;

  const rawSeverity = str(r.severity, 20).toLowerCase();
  // Never echo an unrecognised severity: it would be attacker-chosen text in a
  // field readers scan for exactly one of five known words.
  const severity: AdvisorySeverity = (SEVERITIES as readonly string[]).includes(rawSeverity)
    ? (rawSeverity as AdvisorySeverity)
    : "unspecified";

  const published = keepIfDate(str(r.published, 40));
  const modified = keepIfDate(str(r.modified, 40)) || published;

  const rawUrl = str(r.url ?? r.advisory_url, 500);
  const urlAllowed = rawUrl !== "" && isAllowedAdvisoryUrl(rawUrl, allowedUrlOrigin);

  return {
    advisory: {
      id,
      status: status as AdvisoryStatus,
      severity,
      component: str(r.component, MAX_FIELD_LEN),
      summary: str(r.summary ?? r.title, MAX_FIELD_LEN),
      url: urlAllowed ? rawUrl : "",
      published,
      modified,
    },
    linkDropped: rawUrl !== "" && !urlAllowed,
  };
}

/**
 * Is this advisory link safe to put in front of the community?
 *
 * https only, and under the same origin as the bulletin index itself. The index
 * is signed, so an off-origin link means either a publisher mistake or a
 * publisher we no longer control — and in both cases a clickable link in a
 * security bulletin is the most trusted link in the channel. Defence in depth:
 * we verified WHO wrote the index, which is not a promise about where it points.
 *
 * A dropped link degrades the post (id without a hyperlink), never the advisory.
 */
export function isAllowedAdvisoryUrl(url: string, allowedOrigin?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (allowedOrigin === undefined || allowedOrigin === "") return true;
  return parsed.origin.toLowerCase() === allowedOrigin.toLowerCase();
}

/** Origin of a URL, or "" when it does not parse (then no origin check applies). */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** A remote value used as text: strings only, hard-capped. Anything else is "". */
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** Keep a date only if it looks like one — it is displayed verbatim. */
function keepIfDate(v: string): string {
  return DATE_RE.test(v) ? v : "";
}

/** Human-readable duration for log lines: minutes under an hour, else hours. */
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (Math.abs(minutes) < 60) return `${minutes} min`;
  return `${Math.round(ms / 360_000) / 10} h`;
}
