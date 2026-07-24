/**
 * Tests for src/core/llm.ts — request shapes per provider, retry policy,
 * daily budget, and API-key hygiene in error messages. All through an
 * injected fake fetch; no network, injected clock for the budget.
 */

import { describe, expect, it } from "vitest";
import type { LlmConfig } from "../src/config.js";
import { createLlmClient } from "../src/core/llm.js";
import { LlmBudgetError, LlmError, type ChatOptions, type Logger } from "../src/types.js";

const API_KEY = "sk-super-secret-KEY";

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

function cfg(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "anthropic",
    apiKey: API_KEY,
    model: "claude-x",
    baseUrl: "https://api.example.com",
    timeoutMs: 5000,
    ...overrides,
  };
}

function fetchQueue(items: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = items.shift();
    if (next === undefined) throw new Error("fetch queue empty");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

const anthropicOk = (text: string) =>
  new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
const openaiOk = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }), {
    status: 200,
  });
const deepseekReasoningOk = (reasoning: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "", reasoning_content: reasoning } }],
    }),
    { status: 200 },
  );

const ask: ChatOptions = { system: "sys", messages: [{ role: "user", content: "q" }] };

describe("createLlmClient — request shapes", () => {
  it("anthropic: /v1/messages, x-api-key, top-level system, json suffix", async () => {
    const { fn, calls } = fetchQueue([anthropicOk("hi")]);
    const client = createLlmClient(cfg(), log, { fetchFn: fn });
    const out = await client.chat({ ...ask, json: true, temperature: 0.2 });

    expect(out).toBe("hi");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.example.com/v1/messages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBe(1024); // default
    expect(body.system).toContain("sys");
    expect(body.system).toContain("Respond with a single valid JSON object");
    expect(body.messages).toEqual([{ role: "user", content: "q" }]);
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toBeUndefined();
  });

  it("deepseek/openai-compatible: /chat/completions, Bearer auth, system message, response_format", async () => {
    const { fn, calls } = fetchQueue([openaiOk("hola")]);
    const client = createLlmClient(
      cfg({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
      log,
      { fetchFn: fn },
    );
    const out = await client.chat({ ...ask, json: true, maxTokens: 256 });

    expect(out).toBe("hola");
    expect(calls[0]!.url).toBe("https://api.deepseek.com/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("sys");
    expect(body.messages[1]).toEqual({ role: "user", content: "q" });
    expect(body.max_tokens).toBe(256);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("no json mode: plain system, no response_format", async () => {
    const { fn, calls } = fetchQueue([openaiOk("x")]);
    const client = createLlmClient(cfg({ provider: "openai-compatible" }), log, { fetchFn: fn });
    await client.chat(ask);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.messages[0].content).toBe("sys");
    expect(body.response_format).toBeUndefined();
  });
});

describe("createLlmClient — retries and errors", () => {
  it("retries on 429 then succeeds", async () => {
    const { fn, calls } = fetchQueue([new Response("slow down", { status: 429 }), anthropicOk("ok!")]);
    const client = createLlmClient(cfg(), log, { fetchFn: fn });
    await expect(client.chat(ask)).resolves.toBe("ok!");
    expect(calls).toHaveLength(2);
  });

  it("gives up after 3 attempts on network errors", async () => {
    const { fn, calls } = fetchQueue([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const client = createLlmClient(cfg(), log, { fetchFn: fn });
    const err: unknown = await client.chat(ask).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(3); // 1 + 2 retries, then stop
  }, 15000);

  it("fails fast on 401 without retrying; body trimmed; api key never leaks", async () => {
    const echoed = `invalid key ${API_KEY} provided ` + "x".repeat(500);
    const { fn, calls } = fetchQueue([new Response(echoed, { status: 401 })]);
    const client = createLlmClient(cfg(), log, { fetchFn: fn });
    const err: unknown = await client.chat(ask).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect(err).not.toBeInstanceOf(LlmBudgetError);
    const msg = (err as Error).message;
    expect(msg).toContain("401");
    expect(msg).not.toContain(API_KEY); // redacted even when the server echoes it
    expect(msg.length).toBeLessThan(300); // 200-char body excerpt + prefix
    expect(calls).toHaveLength(1); // no retry on non-retryable status
  });

  it("throws LlmError on malformed provider response", async () => {
    const { fn } = fetchQueue([new Response(JSON.stringify({ nope: true }), { status: 200 })]);
    const client = createLlmClient(cfg(), log, { fetchFn: fn });
    await expect(client.chat(ask)).rejects.toBeInstanceOf(LlmError);
  });

  it("uses reasoning_content as plain text when content is empty and no JSON tail", async () => {
    const { fn } = fetchQueue([deepseekReasoningOk("thinking only, no object here")]);
    const client = createLlmClient(cfg({ provider: "deepseek" }), log, { fetchFn: fn });
    await expect(client.chat(ask)).resolves.toBe("thinking only, no object here");
  });

  it("deepseek reasoning models: extracts JSON from reasoning_content when content is empty", async () => {
    const json = '{"setup":"a","punchline":"b"}';
    const { fn } = fetchQueue([
      deepseekReasoningOk(`Drafting twin banter… Final answer: ${json}`),
    ]);
    const client = createLlmClient(cfg({ provider: "deepseek" }), log, { fetchFn: fn });
    await expect(client.chat({ ...ask, json: true })).resolves.toBe(json);
  });
});

describe("createLlmClient — daily budget", () => {
  it("throws LlmBudgetError after N calls and resets on UTC date change", async () => {
    let t = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { fn } = fetchQueue([anthropicOk("a"), anthropicOk("b"), anthropicOk("c")]);
    const client = createLlmClient(cfg(), log, { fetchFn: fn, maxCallsPerDay: 2, now: () => t });

    await expect(client.chat(ask)).resolves.toBe("a");
    await expect(client.chat(ask)).resolves.toBe("b");
    const err: unknown = await client.chat(ask).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmBudgetError);

    t += 24 * 3600 * 1000; // next UTC day → counter resets
    await expect(client.chat(ask)).resolves.toBe("c");
  });
});
