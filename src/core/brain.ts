/**
 * DIOSCURI Brain — persona-voiced Q&A over MNEMOSYNE, guarded by AEGIS.
 *
 * THE PUBLIC PATH HAS ZERO TOOLS BY DESIGN: retrieval is deterministic and
 * happens before the model call; the model can only produce text. The gauntlet
 * a question runs, in order:
 *
 *   1. rate limits (channel valve first, then per-user) — blocked → canned
 *      line, the model is never called;
 *   2. AEGIS inspection — reject → canned refusal + audit entry that carries
 *      finding CODES only, never the hostile text itself;
 *   3. deterministic retrieval; the corpus and the question are fenced with
 *      the AEGIS markers so the model treats both as data;
 *   4. one LLM call (provider failures → canned "catching his breath" line);
 *   5. OUTPUT GUARD — the model's reply is itself treated as semi-trusted:
 *      fence markers stripped, system-prompt leakage deflected, @everyone
 *      neutralised, foreign invite links removed, platform length caps applied.
 *
 * All collaborators arrive via constructor injection (interfaces from
 * ../types.js); only pure helpers are imported directly.
 */

import {
  BLOCK_BEGIN,
  BLOCK_END,
  CORPUS_BEGIN,
  CORPUS_END,
  prepareUntrusted,
  wrapCorpus,
  wrapUserText,
} from "../aegis/sanitize.js";
import { personaFor } from "../personas/index.js";
import { auditSafe, stripForeignInvites, truncateChars } from "../shared/index.js";
import type {
  AegisGate,
  AskContext,
  AuditLog,
  Brain,
  BrainReply,
  CrossLinks,
  LlmClient,
  Logger,
  Mnemosyne,
  Platform,
  RateLimiter,
} from "../types.js";
import { deflectionLine, detectLanguage, rateLimitLine, refusalLine, unavailableLine, type Lang } from "./language.js";

/** Corpus budget (chars) handed to wrapCorpus — ~6 chunks of ~1600 chars fit. */
const CORPUS_MAX_CHARS = 9000;
const QUESTION_MAX_CHARS = 4000;
const DISPLAY_NAME_MAX_CHARS = 64;
const RETRIEVAL_K = 6;
/** Platform reply caps (Telegram hard limit 4096, Discord 2000 — kept under). */
const CAP_TELEGRAM = 3500;
const CAP_DISCORD = 1900;

/**
 * OUTPUT GUARD — exported for tests. Order matters: exact fence markers are
 * stripped first, so any REMAINING "«DIOSCURI_" fragment is a mutated marker
 * (or a smuggling attempt) and the whole reply is replaced with a deflection.
 */
export function guardOutput(text: string, links: CrossLinks, platform: Platform, lang: Lang = "en"): string {
  let out = text
    .replaceAll(BLOCK_BEGIN, "")
    .replaceAll(BLOCK_END, "")
    .replaceAll(CORPUS_BEGIN, "")
    .replaceAll(CORPUS_END, "");
  // System-prompt leakage: our rules heading or marker fragments in the reply.
  if (out.includes("SECURITY RULES") || out.includes("«DIOSCURI_")) {
    return deflectionLine(lang);
  }
  out = out.replaceAll("@everyone", "everyone").replaceAll("@here", "everyone");
  out = stripForeignInvites(out, links, "[link removed]");
  return truncateChars(out, platform === "telegram" ? CAP_TELEGRAM : CAP_DISCORD);
}

export interface BrainDeps {
  aegis: AegisGate;
  kb: Mnemosyne;
  llm: LlmClient;
  links: CrossLinks;
  userLimiter: RateLimiter;
  channelLimiter: RateLimiter;
  log: Logger;
  audit?: AuditLog;
}

export class DioscuriBrain implements Brain {
  constructor(private readonly deps: BrainDeps) {}

  async answer(question: string, ctx: AskContext): Promise<BrainReply> {
    const d = this.deps;
    // Pure label-picking — safe on raw text (nothing stored/logged/prompted).
    const lang = detectLanguage(question);

    // (a) Channel valve first so one flooded channel cannot drain user tokens.
    if (!d.channelLimiter.check(`ch:${ctx.platform}`).allowed) {
      return { text: rateLimitLine(lang), refused: true };
    }
    if (!d.userLimiter.check(ctx.userKey).allowed) {
      return { text: rateLimitLine(lang), refused: true };
    }

    // (b) AEGIS gate. On reject we audit finding codes only — the hostile text
    // itself must never reach storage or logs.
    const verdict = d.aegis.inspect(question);
    if (verdict.action === "reject") {
      await auditSafe(this.deps.audit, {
        ts: new Date().toISOString(),
        platform: ctx.platform,
        kind: "aegis.reject",
        actor: ctx.userKey,
        subject: ctx.persona,
        data: { codes: verdict.findings.map((f) => f.code), score: verdict.score },
      }, d.log);
      return { text: refusalLine(lang), refused: true };
    }

    // (c) Deterministic retrieval over the sanitised question.
    const hits = d.kb.search(verdict.sanitizedText, RETRIEVAL_K);
    const corpusText =
      hits.length > 0
        ? hits.map((h) => `[${h.chunk.title}](${h.chunk.url}):\n${h.chunk.text}`).join("\n\n")
        : "The knowledge base is empty right now. Say so honestly and point to the docs.";
    const corpus = wrapCorpus(corpusText, CORPUS_MAX_CHARS);

    // (d) Assemble the prompt. Everything untrusted is fenced or sanitised.
    const persona = personaFor(ctx.persona);
    const system = persona.systemPrompt(d.links) + "\n\n# Retrieved knowledge\n" + corpus;
    const userMsg =
      wrapUserText(verdict.sanitizedText, QUESTION_MAX_CHARS) +
      "\nAsker display name (untrusted): " +
      prepareUntrusted(ctx.userDisplay, DISPLAY_NAME_MAX_CHARS) +
      "\nDetected language: " +
      lang +
      ". Answer the question inside the fenced block, in that language.";

    // (e) The single model call of the public path.
    let raw: string;
    try {
      raw = await d.llm.chat({
        system,
        messages: [{ role: "user", content: userMsg }],
        maxTokens: 1024,
        temperature: 0.6,
      });
    } catch (err) {
      // LlmBudgetError / LlmError / anything else → same graceful canned line.
      d.log.error("llm call failed", {
        persona: ctx.persona,
        error: err instanceof Error ? err.message : String(err),
      });
      return { text: unavailableLine(lang), refused: true };
    }

    // (f)+(g) Guard the model's own output before it touches a channel.
    return { text: guardOutput(raw, d.links, ctx.platform, lang), refused: false };
  }
}
