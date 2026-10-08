/**
 * AEGIS signature tables — the firewall's static knowledge.
 *
 * Ported from two battle-tested donors: the web backend's prompt_safety layer
 * (CRITICAL one-hit-rejects + STRONG layered patterns, EN + RU) and WARDEN's
 * static scanner in ARGUS (exfiltration phrasing, secret requests, dangerous
 * URL schemes, base64 blobs). Patterns are evaluated against text that has
 * already been NFKC-normalised by sanitize.ts, so homoglyph tricks collapse
 * before they reach these regexes.
 *
 * CALIBRATION (deliberate, do not "tighten" casually): this community
 * DISCUSSES prompt injection and AI security every day. "How does ARGUS block
 * prompt injection?" or "what is a system prompt?" must pass. Therefore:
 *  - bare topic words ("jailbreak", "system prompt", "exfiltration") are at
 *    most STRONG/advisory findings — never a rejection on their own;
 *  - only imperative override / role-hijack phrasing ("ignore all previous
 *    instructions", "DAN mode", chat-template tokens) is CRITICAL;
 *  - rejection thresholds themselves live in ./index.ts; every regex here is
 *    word-boundary anchored where the alphabet allows it. NOTE: JS \b only
 *    understands ASCII word chars, so Russian patterns must not use \b —
 *    they anchor on whitespace instead, exactly like the Python donor.
 */

import type { Severity } from "../types.js";

export interface SignaturePattern {
  re: RegExp;
  code: string;
  severity: Severity;
}

/** Stable machine codes for AegisFinding.code. */
export const CODE = {
  INJECTION_CRITICAL: "INJECTION_CRITICAL",
  INJECTION_STRONG: "INJECTION_STRONG",
  EXFIL: "EXFIL",
  SECRET_REQUEST: "SECRET_REQUEST",
  DATA_URL: "DATA_URL",
  BASE64_BLOB: "BASE64_BLOB",
  HIDDEN_UNICODE: "HIDDEN_UNICODE",
  ROLE_SMUGGLING: "ROLE_SMUGGLING",
  OVERSIZE: "OVERSIZE",
} as const;

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Penalty subtracted from the trust score for the WORST severity found. */
export const SEVERITY_PENALTY: Record<Severity, number> = {
  info: 0,
  low: 0.1,
  medium: 0.3,
  high: 0.6,
  critical: 1,
};

// ---------------------------------------------------------------------------
// Rejection calibration constants (referenced by ./index.ts and tests)
// ---------------------------------------------------------------------------

/** Raw inputs longer than this are rejected outright (donor: prompt_safety). */
export const MAX_RAW_LEN = 20_000;

/** Distinct STRONG patterns needed before layered injection is rejected. */
export const STRONG_REJECT_COUNT = 2;

/** Role-dialog smuggling: this many role-headed lines AND this much text. */
export const ROLE_SMUGGLING_MIN_LINES = 4;
export const ROLE_SMUGGLING_MIN_LEN = 400;

/** Lines that look like a simulated model dialog ("system: …", "user: …"). */
export const ROLE_LINE_RE = /^\s*(?:user|assistant|system|developer)\s*:/gim;

/**
 * Long base64-ish runs — hidden payloads / encoded instructions. Covers
 * standard AND URL-safe alphabets (RFC 4648 §4/§5), padding optional (JWTs
 * omit it). >=120 chars keeps ordinary hashes/ids below the trigger.
 */
export const BASE64_BLOB_RE = /[A-Za-z0-9+/_-]{120,}={0,2}/;

// ---------------------------------------------------------------------------
// CRITICAL — one hit ⇒ reject. Imperative override / role hijack / raw
// chat-template tokens only. High precision beats recall here.
// ---------------------------------------------------------------------------

export const CRITICAL_PATTERNS: SignaturePattern[] = [
  // Raw chat-template / role tokens — no legitimate reason to type these.
  { re: /\[\s*\/?\s*INST\s*\]/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /<\s*\|\s*im_(?:start|end)\s*\|\s*>/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /<\s*\/?\s*system\s*>/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  // Imperative override of prior instructions (EN).
  { re: /\boverride\s+(?:the\s+|all\s+)?(?:above|prior|previous)\s+instructions?\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /\bignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|preceding)\s+instructions?\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /\bdisregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|preceding)\s+instructions?\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /\bforget\s+(?:everything|all)\s+(?:you|above|prior|previous)\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  // Named jailbreak modes. Bare "jailbreak"/"developer mode" as a TOPIC is
  // only STRONG (see below) — the "…enabled/on" / "…mode" forms are the tell.
  { re: /\bdeveloper\s+mode\b[\s\S]{0,80}\b(?:enabled|on)\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /\bDAN\s+mode\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /\bjailbreak\s+mode\b/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  // Russian imperative overrides (no \b — ASCII-only in JS regexes).
  { re: /сброс(?:ь)?\s+контекст/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /игнорируй\s+(?:все\s+)?(?:предыдущ|вышеуказан)/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /забудь\s+(?:все\s+)?(?:инструкц|правил)/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /нов(?:ые|ая|ый)\s+системн(?:ые|ая|ый)\s+инструкц/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /ты\s+теперь\s+(?:не\s+)?(?:бот|ассистент)/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
  { re: /раскрой\s+системн/i, code: CODE.INJECTION_CRITICAL, severity: "critical" },
];

// ---------------------------------------------------------------------------
// STRONG — two DISTINCT hits ⇒ reject. Each is common enough in benign
// security talk that a single hit must pass ("what is a jailbreak?").
// ---------------------------------------------------------------------------

export const STRONG_PATTERNS: SignaturePattern[] = [
  { re: /\bact\s+as\s+(?:if\s+you\s+are|a|an)\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\bpretend\s+(?:to\s+be|you\s+are)\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\byou\s+are\s+now\s+(?:a|an|the)\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\bsimulate\s+being\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\brole\s*play\s+as\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /###\s*(?:assistant|system)\s*:/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /^\s*(?:system|assistant|developer)\s*:\s*$/im, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\bend\s+of\s+system\s+prompt\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\bbase64[\s–—-]*decode\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\bignore\s+the\s+above\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /\bdisregard\s+the\s+above\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  // Classic tool-poisoning tell; in chat it only makes sense inside a payload.
  { re: /\bdo\s+not\s+(?:tell|inform|mention|notify)\s+(?:the\s+)?user\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  // Bare "jailbreak" is a legitimate TOPIC here — STRONG, never CRITICAL.
  { re: /\bjailbreak\b/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /прикинься(?:\s*,)?\s+что\s+ты/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /выполни\s+команду\s+shell/i, code: CODE.INJECTION_STRONG, severity: "medium" },
  { re: /выполни\s+python/i, code: CODE.INJECTION_STRONG, severity: "medium" },
];

// ---------------------------------------------------------------------------
// Advisory groups — findings only, never a rejection by themselves (DIOSCURI's
// Q&A path has zero tools, so exfil/secret phrasing cannot execute; it still
// tanks the trust score and combines with BASE64_BLOB into a rejection).
// ---------------------------------------------------------------------------

export const EXFIL_PATTERNS: SignaturePattern[] = [
  // Topic word ("how does WARDEN detect exfiltration?") — medium, not critical.
  { re: /\bexfiltrat\w*/i, code: CODE.EXFIL, severity: "medium" },
  { re: /\b(?:send|post|forward|relay)\s+(?:it|them|this|the\s+\w+|all|results?|output|data|contents?)\s+to\b/i, code: CODE.EXFIL, severity: "medium" },
  { re: /\b(?:post|send|put)\s+to\s+https?:\/\//i, code: CODE.EXFIL, severity: "high" },
  { re: /\bupload\b[\s\S]{0,40}\bto\s+(?:https?:\/\/|[\w.-]+\.[a-z]{2,})/i, code: CODE.EXFIL, severity: "medium" },
];

export const SECRET_PATTERNS: SignaturePattern[] = [
  // Wallet-grade secrets — medium (crypto community discusses these daily).
  { re: /\bprivate[_\s-]?key\b/i, code: CODE.SECRET_REQUEST, severity: "medium" },
  { re: /\bseed[_\s-]?phrase\b|\bmnemonic\b/i, code: CODE.SECRET_REQUEST, severity: "medium" },
  { re: /~\/\.ssh|\bid_rsa\b|\.ssh\/[\w.-]+/i, code: CODE.SECRET_REQUEST, severity: "medium" },
  // Everyday dev vocabulary — low ("how do I set my api key?" is support talk).
  { re: /\bapi[_\s-]?key\b/i, code: CODE.SECRET_REQUEST, severity: "low" },
  { re: /\bpassword\b|\bpasswd\b/i, code: CODE.SECRET_REQUEST, severity: "low" },
  { re: /(?:^|[^.\w])\.env\b/i, code: CODE.SECRET_REQUEST, severity: "low" },
  { re: /\baccess[_\s-]?token\b|\bbearer\s+token\b/i, code: CODE.SECRET_REQUEST, severity: "low" },
];

export const URL_SCHEME_PATTERNS: SignaturePattern[] = [
  { re: /\bdata:[\w/+.-]+;base64,/i, code: CODE.DATA_URL, severity: "high" },
  { re: /\bjavascript:/i, code: CODE.DATA_URL, severity: "high" },
];

/** Everything scanned uniformly by Aegis.inspect, in evaluation order. */
export const ALL_ADVISORY_PATTERNS: SignaturePattern[] = [
  ...EXFIL_PATTERNS,
  ...SECRET_PATTERNS,
  ...URL_SCHEME_PATTERNS,
];
