/**
 * RFC 8785 (JSON Canonicalization Scheme) as profiled by AWR/2 (`awr/SPEC.md` §4).
 *
 * WHY THIS FILE IS A COPY. The identical module already exists twice in the
 * ecosystem: `argus/src/warden/jcs.ts` (the WARDEN threat feed) and the `jcs()`
 * function in `momus/momus/warden_feed.py` (the publisher side). DIOSCURI needs
 * the same bytes to verify MOMUS's signed bulletin index — and it must NOT grow a
 * dependency on ARGUS to get them: DIOSCURI is a standalone community bot that
 * ships to its own repo, ARGUS exposes no such subpath, and a security-critical
 * verifier hidden behind a cross-satellite import is worse than a copy that is
 * read in full at review time.
 *
 * The contract is therefore BYTE COMPATIBILITY, not shared code: this file must
 * keep producing exactly the bytes the other two produce. Exported names are kept
 * identical to ARGUS's so a future extraction into a shared package is mechanical.
 *
 * `JSON.stringify` cannot do this job — its output depends on the key order the
 * wire happened to use, so one logical document serialises to different bytes on
 * the two sides and the signature fails for no security reason at all.
 *
 * The profile implemented here, rule by rule:
 *
 * 1. **Property names sort as arrays of UTF-16 code units** (RFC 8785 §3.2.3).
 *    JavaScript's default `Array.prototype.sort()` on strings compares exactly
 *    that, so this is the one rule the platform gives away for free.
 *    `String.prototype.localeCompare` does *not*: it depends on the host locale
 *    and ICU version, which makes it unusable as a digest input.
 * 2. **No Unicode normalization, ever** (SPEC §4.1 item 2). NFC would collide two
 *    property names that RFC 8785 keeps distinct. (Note the consequence for this
 *    feature: the *signed* text is canonicalized as received — NFKC sanitation
 *    happens later, in the renderer, and never on the bytes we verify.)
 * 3. **Two-character escapes plus lowercase `\uXXXX` for the remaining C0
 *    controls** (§3.2.2.2) — which is precisely what `JSON.stringify` emits for a
 *    string, so string bodies are delegated to it rather than re-implemented.
 * 4. **Lone surrogates terminate with an error** instead of being substituted
 *    (§4.1 item 4). `JSON.stringify` would quietly escape them into
 *    valid-looking bytes, so they are rejected before it is called.
 * 5. **Integers only, within ±(2^53−1)**; every non-integer number is refused
 *    rather than arbitrated (§4.3), because whether `1` parses as an integer or
 *    as a double is a language accident that silently changes the signed bytes.
 *
 * Scope: this module is *only* the byte-level canonicalization. It knows nothing
 * about advisories, bulletins, Discord or Telegram.
 */

/** Reason codes from the SPEC §11.2 `AWR-CANON-*` registry that this module raises. */
export type CanonicalizationCode =
  /** Non-integer JSON number present. */
  | "AWR-CANON-001"
  /** Integer outside ±(2^53−1). */
  | "AWR-CANON-002"
  /** Invalid Unicode (lone surrogate) in string data. */
  | "AWR-CANON-003"
  /** Duplicate object property name. */
  | "AWR-CANON-004"
  /** Input is not well-formed JSON / not representable in JSON. */
  | "AWR-CANON-005";

/**
 * A value could not be canonicalized (or parsed) under the AWR profile.
 *
 * Callers are expected to *handle* this rather than let it escape: refusing to
 * produce bytes is the honest outcome, but it must not crash a scheduled poll.
 */
export class CanonicalizationError extends Error {
  constructor(
    readonly code: CanonicalizationCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CanonicalizationError";
  }
}

/** Largest magnitude of a JSON integer permitted in canonical bytes (2^53−1). */
export const MAX_SAFE_JSON_INTEGER = 9007199254740991;

/**
 * Nesting bound. Canonicalization runs over attacker-influenced input (a remote
 * bulletin index), and an unbounded recursive walk is a denial-of-service
 * (SPEC §13.4).
 */
const MAX_DEPTH = 64;

/**
 * Return the RFC 8785 canonical serialization of `value` as a UTF-8-ready string.
 *
 * Throws {@link CanonicalizationError} rather than emitting bytes it cannot
 * defend: a non-integer number, an integer beyond 2^53−1, a lone surrogate, an
 * `undefined` property (which `JSON.stringify` would silently drop), a
 * non-plain object, or a cycle.
 */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  serialize(value, out, "$", 0, new Set<object>());
  return out.join("");
}

function serialize(value: unknown, out: string[], path: string, depth: number, seen: Set<object>): void {
  if (depth > MAX_DEPTH) {
    throw new CanonicalizationError("AWR-CANON-005", `nesting deeper than ${MAX_DEPTH} at ${path}`);
  }
  if (value === null) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      out.push(serializeNumber(value, path));
      return;
    case "string":
      out.push(serializeString(value, path));
      return;
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint: JSON has no representation, and
      // guessing one (JSON.stringify drops or throws depending on position) is
      // exactly the silent divergence this module exists to prevent.
      throw new CanonicalizationError("AWR-CANON-005", `${typeof value} at ${path} is not representable in JSON`);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizationError("AWR-CANON-005", `circular reference at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      out.push("[");
      for (let i = 0; i < obj.length; i++) {
        if (i > 0) out.push(",");
        serialize(obj[i], out, `${path}[${i}]`, depth + 1, seen);
      }
      out.push("]");
      return;
    }

    // Only plain records canonicalize. A Date, Map, RegExp or class instance has
    // no JSON form of its own; `JSON.stringify` would call `toJSON()` or emit
    // `{}`, inventing bytes the other implementation cannot reproduce.
    const proto = Object.getPrototypeOf(obj) as object | null;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError(
        "AWR-CANON-005",
        `${obj.constructor?.name ?? "object"} at ${path} is not a plain JSON object`,
      );
    }

    const record = obj as Record<string, unknown>;
    out.push("{");
    let first = true;
    // §3.2.3: sort as arrays of UTF-16 code units — the default string sort.
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (member === undefined) {
        throw new CanonicalizationError(
          "AWR-CANON-005",
          `property "${key}" at ${path} is undefined — JSON has no such value ` +
            `(JSON.stringify would drop it silently, changing the signed bytes)`,
        );
      }
      if (!first) out.push(",");
      first = false;
      out.push(serializeString(key, `property name "${key}" at ${path}`), ":");
      serialize(member, out, `${path}.${key}`, depth + 1, seen);
    }
    out.push("}");
  } finally {
    seen.delete(obj);
  }
}

/** §4.3: integers only, `[-(2^53-1), 2^53-1]`. Everything else is refused. */
function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError("AWR-CANON-001", `${String(n)} at ${path} is not a JSON number`);
  }
  if (!Number.isInteger(n)) {
    throw new CanonicalizationError("AWR-CANON-001", `non-integer JSON number ${n} at ${path}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new CanonicalizationError("AWR-CANON-002", `integer ${n} at ${path} is outside ±(2^53−1)`);
  }
  // Safe integers never render in exponential form, and `String(-0)` is "0".
  return String(n);
}

/**
 * §3.2.2.2 string serialization, delegated to `JSON.stringify` — which emits the
 * same two-character escapes and the same lowercase `\u00xx` for the remaining C0
 * controls, and leaves every other character literal. The one divergence is lone
 * surrogates, which it escapes and RFC 8785 forbids, so those are rejected first.
 */
function serializeString(text: string, path: string): string {
  assertWellFormed(text, path);
  return JSON.stringify(text);
}

/** §4.1 item 4 / `AWR-CANON-003`: unpaired surrogates are an error, not a substitution. */
function assertWellFormed(text: string, path: string): void {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new CanonicalizationError(
          "AWR-CANON-003",
          `lone high surrogate U+${unit.toString(16).toUpperCase()} at index ${i} in ${path}`,
        );
      }
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalizationError(
        "AWR-CANON-003",
        `lone low surrogate U+${unit.toString(16).toUpperCase()} at index ${i} in ${path}`,
      );
    }
  }
}

/**
 * Parse JSON with the profile's parser requirements, for input whose bytes were
 * signed by someone else.
 *
 * `JSON.parse` alone is not enough on a verification path:
 *
 * - **Duplicate property names** (§4.1 item 5, `AWR-CANON-004`) are resolved
 *   last-wins and silently, which would let the parser — not the signer — decide
 *   which of two advisories was the signed one.
 * - **Non-integer number literals** (§4.3, `AWR-CANON-001`) are rejected
 *   *lexically*, not by value: `2340.0` and `2340` parse to the same JavaScript
 *   number, and a publisher written in a language that distinguishes them would
 *   have signed different bytes.
 *
 * Both checks run over the received text after `JSON.parse` has confirmed it is
 * well-formed, so the scanner below only has to find tokens, never validate
 * grammar.
 */
export function parseJsonStrict(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new CanonicalizationError("AWR-CANON-005", `not well-formed JSON: ${(err as Error).message}`);
  }
  auditTokens(text);
  return value;
}

type Token =
  | { kind: "{" | "}" | "[" | "]" | ":" | "," }
  | { kind: "string"; value: string }
  | { kind: "number"; literal: string };

function auditTokens(text: string): void {
  const tokens = tokenize(text);

  for (const token of tokens) {
    if (token.kind === "number") assertIntegerLiteral(token.literal);
  }

  // A string immediately followed by `:` inside an object is a property name;
  // in well-formed JSON nothing else can occupy that position.
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "{") stack.push(new Set<string>());
    else if (token.kind === "[") stack.push(null);
    else if (token.kind === "}" || token.kind === "]") stack.pop();
    else if (token.kind === "string") {
      const names = stack[stack.length - 1];
      if (names && tokens[i + 1]?.kind === ":") {
        if (names.has(token.value)) {
          throw new CanonicalizationError("AWR-CANON-004", `duplicate object property name "${token.value}"`);
        }
        names.add(token.value);
      }
    }
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        const c = text[i]!;
        if (c === "\\") {
          i += 2;
          continue;
        }
        i++;
        if (c === '"') break;
      }
      // The slice is a valid JSON string literal (JSON.parse already accepted the
      // whole document), so decoding it cannot fail — and decoding is required:
      // "a" and "a" are the same property name.
      tokens.push({ kind: "string", value: JSON.parse(text.slice(start, i)) as string });
      continue;
    }
    if (ch === "{" || ch === "}" || ch === "[" || ch === "]" || ch === ":" || ch === ",") {
      tokens.push({ kind: ch });
      i++;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const start = i;
      i++;
      while (i < text.length && /[0-9eE+.\-]/.test(text[i]!)) i++;
      tokens.push({ kind: "number", literal: text.slice(start, i) });
      continue;
    }
    // Whitespace and the letters of true/false/null carry nothing we check.
    i++;
  }
  return tokens;
}

function assertIntegerLiteral(literal: string): void {
  if (/[.eE]/.test(literal)) {
    throw new CanonicalizationError("AWR-CANON-001", `non-integer JSON number literal ${literal}`);
  }
  // BigInt, not Number: a 20-digit literal loses precision before it can be
  // compared, and would slip through as a "safe" integer.
  let asInt: bigint;
  try {
    asInt = BigInt(literal);
  } catch {
    throw new CanonicalizationError("AWR-CANON-005", `malformed number literal ${literal}`);
  }
  const limit = BigInt(MAX_SAFE_JSON_INTEGER);
  if (asInt > limit || asInt < -limit) {
    throw new CanonicalizationError("AWR-CANON-002", `integer literal ${literal} is outside ±(2^53−1)`);
  }
}
