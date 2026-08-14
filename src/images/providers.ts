/**
 * IMAGES/providers — optional AI image generation backends (env-gated, OFF
 * by default; see tuning.content.images.aiProvider).
 *
 * Three providers behind the one ImageProvider interface from types.ts:
 *   - "openai"   POST {base||api.openai.com/v1}/images/generations → data[0].b64_json
 *   - "together" POST {base||api.together.xyz/v1}/images/generations
 *                (width/height + response_format:"b64_json") → data[0].b64_json
 *   - "local"    CPU diffusers sidecar (scripts/local_image_server.py) — slow but
 *                free; default http://127.0.0.1:8766/v1/images/generations
 *                workflow (our prompt goes into the positive CLIPTextEncode
 *                node), poll GET /history/{prompt_id} every 2s until outputs
 *                appear, then GET /view?filename=… for the raw image bytes.
 *
 * Hardening (same discipline as core/llm.ts):
 *   - one overall deadline per generate() (default 120s) enforced with
 *     AbortController on every fetch; timeouts are NEVER retried;
 *   - exactly one immediate retry per HTTP call on 5xx / network failure
 *     (image jobs are slow and expensive — no exponential ladder needed);
 *   - the API key is never logged and is scrubbed from every error message;
 *   - every failure is an ImageProviderError carrying provider name + status.
 *
 * SECURITY: prompts arriving here must be composed ONLY from baked templates
 * (src/images/memes.ts) + config topics. User text must NEVER reach an image
 * prompt. fetch is injectable for tests; no SDK dependencies.
 */

import type { ImageProvider, Logger } from "../types.js";

export type ImageProviderKind = "openai" | "together" | "comfyui" | "local";

export interface ImageProviderOpts {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  log: Logger;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Every provider failure carries the provider name and (if any) HTTP status. */
export class ImageProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ImageProviderError";
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Local CPU diffusion can take several minutes per 512² frame. */
const LOCAL_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 2_000;
/** Max chars of a provider response body quoted into an error message. */
const BODY_EXCERPT_CHARS = 240;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse "1024x1024"-style size strings; anything else → 1024×1024. */
function parseSize(size: string): { width: number; height: number } {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (m === null) return { width: 1024, height: 1024 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Extract data[0].b64_json from an OpenAI/Together images response. */
function readB64(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const data = (parsed as Record<string, unknown>)["data"];
  if (!Array.isArray(data) || data.length === 0) return undefined;
  const first = data[0];
  if (typeof first !== "object" || first === null) return undefined;
  const b64 = (first as Record<string, unknown>)["b64_json"];
  return typeof b64 === "string" && b64 !== "" ? b64 : undefined;
}

interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** Find the first output image ref in a ComfyUI /history/{id} response. */
function findComfyImage(hist: unknown, promptId: string): ComfyImageRef | null {
  if (typeof hist !== "object" || hist === null) return null;
  const entry = (hist as Record<string, unknown>)[promptId];
  if (typeof entry !== "object" || entry === null) return null;
  const outputs = (entry as Record<string, unknown>)["outputs"];
  if (typeof outputs !== "object" || outputs === null) return null;
  for (const node of Object.values(outputs as Record<string, unknown>)) {
    if (typeof node !== "object" || node === null) continue;
    const images = (node as Record<string, unknown>)["images"];
    if (!Array.isArray(images)) continue;
    for (const img of images) {
      if (typeof img !== "object" || img === null) continue;
      const r = img as Record<string, unknown>;
      if (typeof r["filename"] === "string" && r["filename"] !== "") {
        return {
          filename: r["filename"],
          subfolder: typeof r["subfolder"] === "string" ? r["subfolder"] : "",
          type: typeof r["type"] === "string" ? r["type"] : "output",
        };
      }
    }
  }
  return null;
}

/**
 * Minimal baked ComfyUI text2img workflow (API format). Only `text` of the
 * positive CLIPTextEncode node ("6") carries our prompt; everything else is
 * static plumbing: checkpoint → latent → sampler → VAE decode → save.
 */
function buildComfyWorkflow(
  prompt: string,
  width: number,
  height: number,
  ckpt: string,
  seed: number,
): Record<string, unknown> {
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: 20,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "5": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "text, letters, watermark, signature, low quality, deformed", clip: ["4", 1] },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "dioscuri", images: ["8", 0] } },
  };
}

export function createImageProvider(kind: ImageProviderKind, opts: ImageProviderOpts): ImageProvider {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs =
    kind === "local" ? (opts.timeoutMs ?? LOCAL_TIMEOUT_MS) : (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const apiKey = opts.apiKey ?? "";
  const log = opts.log.child(`images.${kind}`);
  let baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");

  if (kind === "comfyui" && baseUrl === "") {
    throw new ImageProviderError("comfyui", undefined, "comfyui: baseUrl is required (self-hosted ComfyUI URL)");
  }
  if (kind === "local" && baseUrl === "") {
    baseUrl = "http://127.0.0.1:8766/v1";
  }

  /** Scrub the API key from any text that may end up in an error message. */
  function redact(s: string): string {
    return apiKey === "" ? s : s.split(apiKey).join("[redacted]");
  }

  /** Throw a redacted, provider-tagged error. */
  function fail(status: number | undefined, detail: string): never {
    const safe = redact(detail).slice(0, BODY_EXCERPT_CHARS);
    const msg = status === undefined ? `${kind}: ${safe}` : `${kind}: HTTP ${status}: ${safe}`;
    throw new ImageProviderError(kind, status, msg);
  }

  /** One fetch bounded by the overall deadline via AbortController. */
  async function request(url: string, init: RequestInit, deadlineAt: number): Promise<Response> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) fail(undefined, `timeout after ${timeoutMs}ms`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      return await fetchFn(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if (ctrl.signal.aborted) fail(undefined, `timeout after ${timeoutMs}ms`);
      throw err; // plain network error — retryable by the caller below
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One immediate retry on 5xx / network failure. Timeouts (already an
   * ImageProviderError) propagate untouched. A second 5xx is returned so the
   * caller reports the real status.
   */
  async function requestWithRetry(url: string, init: RequestInit, deadlineAt: number): Promise<Response> {
    let lastNetwork = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await request(url, init, deadlineAt);
        if (res.status >= 500 && attempt === 0) {
          log.warn("retryable 5xx from image provider", { status: res.status, attempt });
          continue;
        }
        return res;
      } catch (err) {
        if (err instanceof ImageProviderError) throw err;
        lastNetwork = err instanceof Error ? err.message : String(err);
        if (attempt === 0) log.warn("network error calling image provider, retrying", { attempt });
      }
    }
    fail(undefined, `network error: ${lastNetwork}`);
  }

  /** Read body; on !ok throw with status; on ok parse JSON or throw. */
  async function jsonOrFail(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) fail(res.status, text);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      fail(res.status, `malformed JSON response: ${text}`);
    }
  }

  async function generateOpenAi(prompt: string, size: string): Promise<Buffer> {
    const base = baseUrl === "" ? "https://api.openai.com/v1" : baseUrl;
    const deadlineAt = Date.now() + timeoutMs;
    const res = await requestWithRetry(
      `${base}/images/generations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: opts.model || "gpt-image-1", prompt, size, n: 1 }),
      },
      deadlineAt,
    );
    const b64 = readB64(await jsonOrFail(res));
    if (b64 === undefined) fail(undefined, "response missing data[0].b64_json");
    return Buffer.from(b64, "base64");
  }

  async function generateTogether(prompt: string, size: string): Promise<Buffer> {
    const base = baseUrl === "" ? "https://api.together.xyz/v1" : baseUrl;
    const { width, height } = parseSize(size);
    const deadlineAt = Date.now() + timeoutMs;
    const res = await requestWithRetry(
      `${base}/images/generations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: opts.model || "black-forest-labs/FLUX.1-schnell",
          prompt,
          width,
          height,
          n: 1,
          response_format: "b64_json",
        }),
      },
      deadlineAt,
    );
    const b64 = readB64(await jsonOrFail(res));
    if (b64 === undefined) fail(undefined, "response missing data[0].b64_json");
    return Buffer.from(b64, "base64");
  }

  async function generateComfy(prompt: string, size: string): Promise<Buffer> {
    const deadlineAt = Date.now() + timeoutMs;
    const { width, height } = parseSize(size);
    const workflow = buildComfyWorkflow(
      prompt,
      width,
      height,
      opts.model || "sd_xl_base_1.0.safetensors",
      Date.now() >>> 0,
    );
    const submitRes = await requestWithRetry(
      `${baseUrl}/prompt`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
      },
      deadlineAt,
    );
    const submitParsed = await jsonOrFail(submitRes);
    const promptId =
      typeof submitParsed === "object" && submitParsed !== null
        ? (submitParsed as Record<string, unknown>)["prompt_id"]
        : undefined;
    if (typeof promptId !== "string" || promptId === "") fail(undefined, "response missing prompt_id");

    // Poll /history every 2s until the job's outputs appear or we run out of time.
    for (;;) {
      if (Date.now() >= deadlineAt) fail(undefined, `timeout after ${timeoutMs}ms waiting for ComfyUI result`);
      await sleep(POLL_INTERVAL_MS);
      const histRes = await requestWithRetry(
        `${baseUrl}/history/${encodeURIComponent(promptId)}`,
        { method: "GET" },
        deadlineAt,
      );
      const img = findComfyImage(await jsonOrFail(histRes), promptId);
      if (img === null) continue;
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
      const viewRes = await requestWithRetry(`${baseUrl}/view?${q.toString()}`, { method: "GET" }, deadlineAt);
      if (!viewRes.ok) fail(viewRes.status, await viewRes.text());
      return Buffer.from(await viewRes.arrayBuffer());
    }
  }

  return {
    name: kind,
    async generate(prompt: string, o?: { size?: string }): Promise<Buffer> {
      const size = o?.size ?? (kind === "local" ? "512x512" : "1024x1024");
      log.debug("image generation requested", { size, promptChars: prompt.length });
      if (kind === "openai" || kind === "local") return generateOpenAi(prompt, size);
      if (kind === "together") return generateTogether(prompt, size);
      return generateComfy(prompt, size);
    },
  };
}
