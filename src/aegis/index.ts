/**
 * AEGIS — the injection firewall in front of everything DIOSCURI reads.
 *
 * One entry point: inspect(text). It sanitises (NFKC, control/zero-width
 * strip, marker neutralisation, length cap — see ./sanitize.ts), scans the
 * SANITIZED text against the signature tables in ./patterns.ts, and returns
 * an authoritative allow/reject verdict plus a 0..1 trust score.
 *
 * Rejection is RULE-based, not score-based (calibrated for a community that
 * discusses prompt injection daily — see patterns.ts):
 *   1. any CRITICAL imperative-override / role-hijack hit;
 *   2. >= 2 DISTINCT STRONG hits (layered injection);
 *   3. role-dialog smuggling (>= 4 role-headed lines in > 400 chars);
 *   4. raw input longer than 20k chars;
 *   5. BASE64_BLOB + any other medium+ finding (blob alone only tanks score).
 * Everything else passes with findings attached; downstream modules may use
 * the score, but `action` is the word of law.
 *
 * Finding messages carry the SIGNATURE, never the attacker's text — verdicts
 * get logged, and logs must not become a second injection surface.
 */

import type { AegisFinding, AegisGate, AegisVerdict, Severity } from "../types.js";
import { HIDDEN_UNICODE_TEST, prepareUntrusted } from "./sanitize.js";
import {
  ALL_ADVISORY_PATTERNS,
  BASE64_BLOB_RE,
  CODE,
  CRITICAL_PATTERNS,
  MAX_RAW_LEN,
  ROLE_LINE_RE,
  ROLE_SMUGGLING_MIN_LEN,
  ROLE_SMUGGLING_MIN_LINES,
  SEVERITY_PENALTY,
  SEVERITY_RANK,
  STRONG_PATTERNS,
  STRONG_REJECT_COUNT,
  type SignaturePattern,
} from "./patterns.js";

/** Default sanitised-length cap; callers may widen/narrow per surface. */
const DEFAULT_MAX_LEN = 4000;

export class Aegis implements AegisGate {
  constructor(private readonly defaultMaxLen: number = DEFAULT_MAX_LEN) {}

  inspect(text: string, opts?: { maxLen?: number }): AegisVerdict {
    const raw = text ?? "";
    const maxLen = opts?.maxLen ?? this.defaultMaxLen;
    const findings: AegisFinding[] = [];
    let reject = false;

    // Oversize is judged on the RAW input: the cap below would silently hide it.
    if (raw.length > MAX_RAW_LEN) {
      findings.push({
        code: CODE.OVERSIZE,
        severity: "high",
        message: `Raw input is ${raw.length} chars (limit ${MAX_RAW_LEN}).`,
      });
      reject = true;
    }

    // Hidden unicode is judged on the RAW input too — sanitisation strips the
    // characters, so scanning afterwards would never see them. The text stays
    // usable (they are gone from sanitizedText); the finding still registers.
    if (HIDDEN_UNICODE_TEST.test(raw)) {
      findings.push({
        code: CODE.HIDDEN_UNICODE,
        severity: "medium",
        message: "Zero-width/bidi characters found and stripped during sanitisation.",
      });
    }

    // Everything else scans the sanitised text: NFKC has collapsed homoglyphs
    // and the cap means we only judge what could actually reach a model.
    const sanitized = prepareUntrusted(raw, maxLen);

    const criticalHits = matches(CRITICAL_PATTERNS, sanitized);
    findings.push(...criticalHits.map(toFinding));
    if (criticalHits.length >= 1) reject = true;

    const strongHits = matches(STRONG_PATTERNS, sanitized);
    findings.push(...strongHits.map(toFinding));
    if (strongHits.length >= STRONG_REJECT_COUNT) reject = true;

    // Advisory groups (EXFIL / SECRET_REQUEST / DATA_URL): findings only.
    findings.push(...matches(ALL_ADVISORY_PATTERNS, sanitized).map(toFinding));

    // Role-dialog smuggling: a wall of "system:/user:" lines is a scripted
    // conversation, not a question — reject regardless of individual patterns.
    const roleLines = sanitized.match(ROLE_LINE_RE)?.length ?? 0;
    if (roleLines >= ROLE_SMUGGLING_MIN_LINES && sanitized.length > ROLE_SMUGGLING_MIN_LEN) {
      findings.push({
        code: CODE.ROLE_SMUGGLING,
        severity: "critical",
        message: `${roleLines} role-headed dialog lines in ${sanitized.length} chars — simulated model dialog.`,
      });
      reject = true;
    }

    const hasBase64 = BASE64_BLOB_RE.test(sanitized);
    if (hasBase64) {
      findings.push({
        code: CODE.BASE64_BLOB,
        severity: "high",
        message: "Long base64-like blob (>=120 chars) — possible hidden payload.",
      });
      // A blob alone may be an innocent hash dump / JWT question; a blob PLUS
      // any other medium+ signal is a payload with a delivery mechanism.
      const other = findings.some(
        (f) => f.code !== CODE.BASE64_BLOB && SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium,
      );
      if (other) reject = true;
    }

    return {
      action: reject ? "reject" : "allow",
      score: scoreFor(findings),
      findings,
      sanitizedText: sanitized,
    };
  }
}

/** Distinct signature entries that match (each pattern counted once). */
function matches(patterns: SignaturePattern[], text: string): SignaturePattern[] {
  return patterns.filter((p) => p.re.test(text));
}

function toFinding(p: SignaturePattern): AegisFinding {
  return {
    code: p.code,
    severity: p.severity,
    message: `Matches ${p.code} signature (${describe(p.re)}).`,
  };
}

/** 1 minus the penalty of the worst severity found; clamped to [0,1]. */
function scoreFor(findings: AegisFinding[]): number {
  let worst: Severity = "info";
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return Math.max(0, Math.min(1, 1 - SEVERITY_PENALTY[worst]));
}

/** Short human label for a signature regex — never echoes attacker text. */
function describe(re: RegExp): string {
  return re.source.length > 48 ? `${re.source.slice(0, 45)}…` : re.source;
}
