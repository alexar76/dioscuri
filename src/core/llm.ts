/**
 * Multi-provider LLM client — plain fetch, no SDK dependencies.
 *
 * Providers: "anthropic" (Messages API) and "deepseek" / "openai-compatible"
 * (Chat Completions API). One hardened path for all of them:
 *  - timeout via AbortController (cfg.timeoutMs);
 *  - up to 2 extra attempts on 429 / 5xx / network failure, exponential
 *    backoff 500ms * 2^n plus jitter;
 *  - non-retryable HTTP (400/401/403/...) → LlmError immediately with the
 *    status and a body excerpt trimmed to 200 chars;
 *  - a daily UTC call budget (cost guard) → LlmBudgetError once spent, reset
 *    on date change through the injected clock;
 *  - the API key is NEVER logged and is scrubbed from every error message,
 *    even if a hostile/echoing server reflects it back in a response body.
 *
 * The clock and fetch are injectable so budget and retry logic are testable
 * without wall time or network.
 */

import type { LlmConfig } from "../config.js";
import { LlmBudgetError, LlmError, type ChatOptions, type LlmClient, type Logger } from "../types.js";

const ANTHROPIC_VERSION = "2023-06-01";
/** Extra attempts after the first one. */
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const JITTER_MS = 250;
/** Max chars of a provider response body quoted into an error message. */
const BODY_EXCERPT_CHARS = 200;

/**
 * Appended to the system prompt in json mode. Chat-completions providers also
 * get response_format json_object, but they typically require the prompt to
 * mention JSON anyway, so the suffix is applied for every provider.
 */
const JSON_MODE_SUFFIX = "Respond with a single valid JSON object and nothing else.";

interface LlmClientOpts {
  /** Q&A cost guard; omitted = unlimited (index.ts wires tuning.maxLlmCallsPerDay). */
  maxCallsPerDay?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Last balanced `{…}` slice in `text` that parses as JSON, if any. */
function extractTrailingJson(text: string): string | undefined {
  const lastBrace = text.lastIndexOf("{");
  if (lastBrace < 0) return undefined;
  for (let end = text.length; end > lastBrace; end--) {
    const slice = text.slice(lastBrace, end).trim();
    if (!slice.endsWith("}")) continue;
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* try a shorter tail */
    }
  }
  return undefined;
}

function nonEmptyString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Pull the assistant text out of a parsed provider response, or undefined. */
function extractText(provider: LlmConfig["provider"], parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (provider === "anthropic") {
    const content = obj["content"];
    if (!Array.isArray(content) || content.length === 0) return undefined;
    const first = content[0] as Record<string, unknown> | undefined;
    return nonEmptyString(first?.["text"]);
  }
  const choices = obj["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as Record<string, unknown> | undefined)?.["message"] as
    | Record<string, unknown>
    | undefined;
  const content = nonEmptyString(message?.["content"]);
  if (content !== undefined) return content;
  // deepseek-v4-pro (and similar reasoning models) may leave content empty and
  // put the final JSON at the tail of reasoning_content.
  const reasoning = nonEmptyString(message?.["reasoning_content"]);
  if (reasoning === undefined) return undefined;
  return extractTrailingJson(reasoning) ?? reasoning;
}

export function createLlmClient(cfg: LlmConfig, log: Logger, opts: LlmClientOpts = {}): LlmClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const maxCallsPerDay = opts.maxCallsPerDay ?? Number.POSITIVE_INFINITY;
  const base = cfg.baseUrl.replace(/\/+$/, "");

  let budgetDay = "";
  let callsToday = 0;

  /** One chat() == one budget unit; retries inside a call are not re-counted. */
  function takeBudget(): void {
    const today = new Date(now()).toISOString().slice(0, 10); // UTC date
    if (today !== budgetDay) {
      budgetDay = today;
      callsToday = 0;
    }
    if (callsToday >= maxCallsPerDay) {
      throw new LlmBudgetError(`daily LLM budget exhausted (${maxCallsPerDay} calls/day)`);
    }
    callsToday++;
  }

  /** Scrub the API key from any text that may end up in an error message. */
  function redact(s: string): string {
    return cfg.apiKey === "" ? s : s.split(cfg.apiKey).join("[redacted]");
  }

  function buildRequest(o: ChatOptions): { url: string; headers: Record<string, string>; body: string } {
    const maxTokens = o.maxTokens ?? 1024;
    const system = o.json ? `${o.system}\n${JSON_MODE_SUFFIX}` : o.system;
    if (cfg.provider === "anthropic") {
      return {
        url: `${base}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: maxTokens,
          system,
          messages: o.messages,
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        }),
      };
    }
    // deepseek and openai-compatible share the chat-completions wire format.
    return {
      url: `${base}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: system }, ...o.messages],
        max_tokens: maxTokens,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.json ? { response_format: { type: "json_object" } } : {}),
      }),
    };
  }

  return {
    async chat(o: ChatOptions): Promise<string> {
      takeBudget();
      const req = buildRequest(o);
      let lastErr: LlmError | null = null;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1) + Math.random() * JITTER_MS);
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
          let res: Response;
          try {
            res = await fetchFn(req.url, {
              method: "POST",
              headers: req.headers,
              body: req.body,
              signal: ctrl.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          const bodyText = await res.text();
          if (res.ok) {
            let text: string | undefined;
            try {
              text = extractText(cfg.provider, JSON.parse(bodyText));
            } catch {
              text = undefined;
            }
            if (text === undefined) {
              throw new LlmError(
                `malformed ${cfg.provider} response: ${redact(bodyText).slice(0, BODY_EXCERPT_CHARS)}`,
              );
            }
            return text;
          }

          const excerpt = redact(bodyText).slice(0, BODY_EXCERPT_CHARS);
          if (res.status === 429 || res.status >= 500) {
            lastErr = new LlmError(`HTTP ${res.status} from ${cfg.provider}: ${excerpt}`);
            log.warn("llm retryable http error", { provider: cfg.provider, status: res.status, attempt });
            continue;
          }
          // 400/401/403/... — retrying cannot help; fail fast.
          throw new LlmError(`HTTP ${res.status} from ${cfg.provider}: ${excerpt}`);
        } catch (err) {
          // LlmError reaching here is non-retryable (bad status / malformed body).
          if (err instanceof LlmError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          lastErr = new LlmError(
            `network error calling ${cfg.provider}: ${redact(msg).slice(0, BODY_EXCERPT_CHARS)}`,
          );
          log.warn("llm network error", { provider: cfg.provider, attempt });
        }
      }
      throw lastErr ?? new LlmError(`llm call to ${cfg.provider} failed`);
    },
  };
}
