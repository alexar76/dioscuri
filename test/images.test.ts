/**
 * Tests for src/images/* — AI image providers (injected fake fetch: request
 * shapes, b64 decode, ComfyUI poll flow, retry policy, timeout, key hygiene)
 * and the meme prompt factory (seed rotation, topic sanitation).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOCK_BEGIN } from "../src/aegis/sanitize.js";
import { buildMemePrompt, MEME_CAPTION_HINT } from "../src/images/memes.js";
import { createImageProvider, ImageProviderError } from "../src/images/providers.js";
import type { Logger } from "../src/types.js";

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

const API_KEY = "sk-image-super-SECRET";

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

const imagesOk = (buf: Buffer) =>
  new Response(JSON.stringify({ data: [{ b64_json: buf.toString("base64") }] }), { status: 200 });

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// createImageProvider
// ---------------------------------------------------------------------------

describe("createImageProvider — openai", () => {
  it("posts the right shape and decodes b64_json to a Buffer", async () => {
    const png = Buffer.from("fake-openai-png-bytes");
    const { fn, calls } = fetchQueue([imagesOk(png)]);
    const provider = createImageProvider("openai", { apiKey: API_KEY, log, fetchFn: fn });

    const buf = await provider.generate("marble statue of an AI agent", { size: "512x512" });

    expect(provider.name).toBe("openai");
    expect(buf.equals(png)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/images/generations");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("gpt-image-1");
    expect(body.prompt).toBe("marble statue of an AI agent");
    expect(body.size).toBe("512x512");
    expect(body.n).toBe(1);
  });

  it("retries once on 500 then succeeds", async () => {
    const png = Buffer.from("retry-worked");
    const { fn, calls } = fetchQueue([new Response("boom", { status: 500 }), imagesOk(png)]);
    const provider = createImageProvider("openai", { apiKey: API_KEY, log, fetchFn: fn });
    const buf = await provider.generate("p");
    expect(buf.equals(png)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("retries once on network error then succeeds", async () => {
    const png = Buffer.from("net-retry");
    const { fn, calls } = fetchQueue([new Error("ECONNRESET"), imagesOk(png)]);
    const provider = createImageProvider("openai", { apiKey: API_KEY, log, fetchFn: fn });
    const buf = await provider.generate("p");
    expect(buf.equals(png)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("fails fast on 4xx, names the provider + status, and never leaks the key", async () => {
    const { fn, calls } = fetchQueue([new Response(`denied for key ${API_KEY}`, { status: 400 })]);
    const provider = createImageProvider("openai", { apiKey: API_KEY, log, fetchFn: fn });
    const err = (await provider.generate("p").catch((e: unknown) => e)) as ImageProviderError;
    expect(err).toBeInstanceOf(ImageProviderError);
    expect(err.provider).toBe("openai");
    expect(err.status).toBe(400);
    expect(err.message).toContain("openai");
    expect(err.message).toContain("400");
    expect(err.message).not.toContain(API_KEY);
    expect(calls).toHaveLength(1); // 4xx is not retried
  });

  it("aborts on timeout and throws a timeout error", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    const provider = createImageProvider("openai", {
      apiKey: API_KEY,
      log,
      fetchFn: hanging,
      timeoutMs: 40,
    });
    await expect(provider.generate("p")).rejects.toThrow(/timeout/i);
  });
});

describe("createImageProvider — together", () => {
  it("posts width/height + b64_json response_format to together.xyz", async () => {
    const png = Buffer.from("together-bytes");
    const { fn, calls } = fetchQueue([imagesOk(png)]);
    const provider = createImageProvider("together", { apiKey: API_KEY, log, fetchFn: fn });

    const buf = await provider.generate("constellation diagram", { size: "768x512" });

    expect(provider.name).toBe("together");
    expect(buf.equals(png)).toBe(true);
    expect(calls[0]!.url).toBe("https://api.together.xyz/v1/images/generations");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.model).toBe("black-forest-labs/FLUX.1-schnell");
    expect(body.prompt).toBe("constellation diagram");
    expect(body.width).toBe(768);
    expect(body.height).toBe(512);
    expect(body.n).toBe(1);
    expect(body.response_format).toBe("b64_json");
  });
});

describe("createImageProvider — local", () => {
  it("defaults to localhost sidecar and 512²", async () => {
    const png = Buffer.from("local-cpu-bytes");
    const { fn, calls } = fetchQueue([imagesOk(png)]);
    const provider = createImageProvider("local", { log, fetchFn: fn });

    const buf = await provider.generate("marble twins under stars");

    expect(provider.name).toBe("local");
    expect(buf.equals(png)).toBe(true);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8766/v1/images/generations");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.prompt).toBe("marble twins under stars");
    expect(body.size).toBe("512x512");
  });
});

describe("createImageProvider — comfyui", () => {
  it("requires a baseUrl at creation time", () => {
    expect(() => createImageProvider("comfyui", { log })).toThrow(/baseUrl/);
  });

  it("submits the workflow, polls twice, then fetches the image via /view", async () => {
    vi.useFakeTimers();
    const png = Buffer.from("comfy-image-bytes");
    const { fn, calls } = fetchQueue([
      new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 }),
      new Response(JSON.stringify({}), { status: 200 }), // poll 1: not ready
      new Response(
        JSON.stringify({
          p1: { outputs: { "9": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } } },
        }),
        { status: 200 },
      ), // poll 2: ready
      new Response(png, { status: 200 }),
    ]);
    const provider = createImageProvider("comfyui", { baseUrl: "http://gpu:8188", log, fetchFn: fn });

    const pending = provider.generate("heroic fresco of microservices");
    await vi.advanceTimersByTimeAsync(2100); // first 2s poll sleep
    await vi.advanceTimersByTimeAsync(2100); // second 2s poll sleep + /view
    const buf = await pending;

    expect(buf.equals(png)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "http://gpu:8188/prompt",
      "http://gpu:8188/history/p1",
      "http://gpu:8188/history/p1",
      "http://gpu:8188/view?filename=out.png&subfolder=&type=output",
    ]);
    // Our prompt landed inside the baked workflow's positive text node.
    const submitted = JSON.parse(calls[0]!.init.body as string);
    expect(submitted.prompt["6"].inputs.text).toBe("heroic fresco of microservices");
    expect(submitted.prompt["9"].class_type).toBe("SaveImage");
  });
});

// ---------------------------------------------------------------------------
// buildMemePrompt
// ---------------------------------------------------------------------------

describe("buildMemePrompt", () => {
  it("rotates through distinct baked styles by seed, deterministically", () => {
    const a = buildMemePrompt("verifiable oracles", 0);
    const b = buildMemePrompt("verifiable oracles", 1);
    expect(a).not.toBe(b);
    expect(buildMemePrompt("verifiable oracles", 3)).toBe(buildMemePrompt("verifiable oracles", 3));
    const distinct = new Set(Array.from({ length: 20 }, (_, i) => buildMemePrompt("t", i)));
    expect(distinct.size).toBeGreaterThanOrEqual(8); // 8–10 baked templates
  });

  it("interpolates the (sanitised) topic and strips fence markers", () => {
    const p = buildMemePrompt(`the on-chain lottery ${BLOCK_BEGIN} on Base`, 4);
    expect(p).toContain("the on-chain lottery");
    expect(p).not.toContain(BLOCK_BEGIN);
  });

  it("survives negative and weird seeds", () => {
    expect(() => buildMemePrompt("x", -7)).not.toThrow();
    expect(() => buildMemePrompt("x", Number.NaN)).not.toThrow();
    expect(buildMemePrompt("x", -7)).toContain("x");
  });

  it("exports an English caption-pairing hint", () => {
    expect(MEME_CAPTION_HINT).toMatch(/caption/i);
    expect(MEME_CAPTION_HINT).toMatch(/English/);
  });
});
