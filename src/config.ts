/**
 * Configuration: env-first (secrets), optional dioscuri.config.json (tuning).
 *
 * Secrets NEVER live in the JSON file; the JSON file is mounted read-only in
 * Docker and holds non-secret knobs only (cadence, thresholds, repo list).
 */

import { readFileSync } from "node:fs";
import { z } from "zod";

const TuningSchema = z
  .object({
    githubOwner: z.string().min(1).default("alexar76"),
    /** Explicit repo allowlist; empty = all public repos of the owner. */
    githubRepos: z.array(z.string()).default([]),
    /** Minutes between MNEMOSYNE sync passes. */
    kbSyncIntervalMin: z.number().int().min(5).max(24 * 60).default(60),
    /** Hours between cross-promo posts (jittered ±20%). 0 disables. */
    promoIntervalHours: z.number().min(0).max(168).default(12),
    /** Max Q&A LLM calls per UTC day (cost guard). */
    maxLlmCallsPerDay: z.number().int().min(1).default(2000),
    /** Per-user Q&A messages per minute. */
    userRatePerMin: z.number().int().min(1).max(60).default(4),
    /** Per-channel Q&A messages per minute (global flood valve). */
    channelRatePerMin: z.number().int().min(1).max(600).default(20),
    moderation: z
      .object({
        enabled: z.boolean().default(true),
        /** Run the LLM classifier only when deterministic risk signals fire. */
        llmClassifier: z.boolean().default(true),
        /** Confidence needed before the classifier may delete. */
        deleteConfidence: z.number().min(0).max(1).default(0.8),
        /** Hard ceiling for automatic timeouts (ms). Default 10 minutes. */
        maxTimeoutMs: z
          .number()
          .int()
          .min(10_000)
          .max(60 * 60 * 1000)
          .default(10 * 60 * 1000),
        /** Domains allowed in links; empty = allow all except denylist. */
        linkAllowlist: z.array(z.string()).default([]),
        linkDenylist: z.array(z.string()).default([]),
      })
      .default({}),
    links: z
      .object({
        discordInvite: z.string().default(""),
        telegramChannel: z.string().default(""),
        telegramBot: z.string().default(""),
        siteUrl: z.string().default("https://magic-ai-factory.com"),
        githubOrg: z.string().default("https://github.com/alexar76"),
        theorosUrl: z.string().default("https://alexar76.github.io/theoros/"),
      })
      .default({}),
    /**
     * KERYX (the herald): outbound syndication of release announcements to
     * social sinks + a monthly digest article on dev.to. POST-ONLY by charter
     * (no engagement automation anywhere); sinks arm themselves from env
     * secrets; X additionally needs the X_SYNDICATION=1 opt-in (pay-per-use).
     */
    syndication: z
      .object({
        enabled: z.boolean().default(true),
        /** Post release announcements to Bluesky (needs BLUESKY_* env secrets). */
        bluesky: z.boolean().default(true),
        /** Bump reminder: ping Keepers when the DISBOARD /bump cooldown ends. */
        bumpReminder: z.boolean().default(true),
        /** Day of month (UTC) for the dev.to digest article. */
        devtoDigestDay: z.number().int().min(1).max(28).default(1),
        devtoDigestHourUtc: z.number().int().min(0).max(23).default(12),
      })
      .default({}),
    /**
     * Project showcase: read-only polling of the ecosystem's PUBLIC demo
     * endpoints. Snapshots land in MNEMOSYNE as "live" chunks so the twins
     * can answer "what's running right now" with facts, not folklore.
     */
    showcase: z
      .object({
        enabled: z.boolean().default(true),
        intervalMin: z.number().int().min(2).max(24 * 60).default(10),
        sources: z
          .array(
            z.object({
              name: z.string().min(1),
              url: z.string().url(),
              kind: z.enum(["json", "text"]).default("json"),
            }),
          )
          .default([
            { name: "alien-monitor", url: "https://magic-ai-factory.com/monitor/api/health", kind: "json" },
            { name: "monitor-chain", url: "https://magic-ai-factory.com/monitor/api/chain/status", kind: "json" },
          ]),
      })
      .default({}),
    content: z
      .object({
        enabled: z.boolean().default(true),
        /** Hard ceiling across ALL proactive posts (content + promo) per platform per UTC day. */
        maxPostsPerDay: z.number().int().min(1).max(12).default(3),
        /** No proactive posting inside [start, end) UTC hours (wraps midnight). */
        quietHoursUtc: z.tuple([z.number().min(0).max(23), z.number().min(0).max(23)]).default([22, 7]),
        /**
         * Weekly rhythm. Defaults hit the EU-evening/US-morning overlap.
         * ALL proactive content is English regardless of audience messages.
         */
        slots: z
          .array(
            z.object({
              kind: z.enum(["spotlight", "banter", "poll", "digest", "show-and-tell", "canon"]),
              day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
              hourUtc: z.number().int().min(0).max(23),
            }),
          )
          .default([
            { kind: "spotlight", day: "mon", hourUtc: 15 },
            { kind: "banter", day: "tue", hourUtc: 17 },
            { kind: "poll", day: "wed", hourUtc: 15 },
            { kind: "spotlight", day: "thu", hourUtc: 16 },
            { kind: "digest", day: "fri", hourUtc: 15 },
            { kind: "banter", day: "sat", hourUtc: 17 },
            { kind: "show-and-tell", day: "sat", hourUtc: 14 },
            { kind: "canon", day: "sun", hourUtc: 16 },
          ]),
        images: z
          .object({
            /** "" = off | openai | together | comfyui (GPU) | local (CPU sidecar). */
            aiProvider: z.enum(["", "openai", "together", "comfyui", "local"]).default(""),
            aiModel: z.string().default(""),
            /** Cap on AI-generated meme images per week (cost/cringe guard). */
            aiMemesPerWeek: z.number().int().min(0).max(14).default(2),
            /** README-sourced demo screenshots on spotlight (Playwright sidecar). */
            screenshots: z
              .object({
                enabled: z.boolean().default(true),
              })
              .default({}),
          })
          .default({}),
        /** Rotating grounding topics for spotlight/banter/poll generation. */
        topics: z
          .array(z.string())
          .default([
            "what shipped recently across the ecosystem (fresh commits and releases)",
            "AI Factory — the autonomous product pipeline",
            "verifiable oracles (LUMEN, CHRONOS, PLATON and the oracle family)",
            "AIMarket — the agent economy and paid MCP invokes",
            "ARGUS personal agent and the WARDEN MCP firewall",
            "Alien Monitor — the 3D ecosystem observatory",
            "the on-chain lottery on Base",
            "MCP integrations and the hub federation",
            "agent reputation and LUMEN trust scoring",
            "Agent Sovereignty Canon — preamble and seven precepts",
            "weak aggregation regression on Metis benchmarks",
            "verification as citizenship — verify_score and oracles",
            "WARDEN MCP border control in ARGUS",
            "invoke as contract — AIMarket Hub publish-and-earn",
            "benchmarks as jury duty — Council vs Solo challenge",
          ]),
      })
      .default({}),
  })
  .default({});

export type Tuning = z.infer<typeof TuningSchema>;

/**
 * Wire protocol the client speaks. User-facing DIOSCURI_LLM_PROVIDER accepts
 * friendly aliases (ollama, lmstudio, llamacpp, anthropic-compatible, openai)
 * which resolve to one of these two protocols + sensible defaults.
 */
export type LlmProviderKind = "deepseek" | "anthropic" | "openai-compatible";

export interface LlmConfig {
  provider: LlmProviderKind;
  /** Empty is valid for local servers (ollama/lmstudio/llama.cpp ignore auth). */
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export interface DioscuriConfig {
  httpPort: number;
  dataDir: string;
  /** No tokens required; adapters disabled; health + KB still run. */
  dryRun: boolean;
  telegram: {
    token: string;
    chatId: string;
    enabled: boolean;
    /** On boot: set bot commands menu, pin the links message (needs admin). */
    autoSetup: boolean;
  };
  discord: {
    token: string;
    guildId: string;
    /** Empty = auto-created/discovered by the provisioner on boot. */
    modLogChannelId: string;
    announceChannelId: string;
    /** Empty = auto-created/discovered (#gallery-spotlight). */
    gallerySpotlightChannelId: string;
    /** Empty = auto-created/discovered (#the-canon). */
    canonChannelId: string;
    /** Empty = auto-created/discovered (#general). */
    generalChannelId: string;
    enabled: boolean;
    /** On boot: idempotently create the optimal server structure (never deletes). */
    autoStructure: boolean;
  };
  llm: LlmConfig;
  /** Secondary provider for failover; null = single-provider mode. */
  llmFallback: LlmConfig | null;
  githubToken: string;
  /** Secrets for the optional AI-image provider (tuning content.images.aiProvider). */
  images: { apiKey: string; baseUrl: string };
  /** Optional Playwright screenshot sidecar (README demo pages). */
  screenshots: { baseUrl: string };
  /**
   * KERYX syndication secrets. A sink is armed by its secrets being present;
   * X additionally requires the explicit X_SYNDICATION=1 opt-in (pay-per-use).
   */
  syndication: {
    bluesky: { identifier: string; appPassword: string };
    mastodon: { baseUrl: string; accessToken: string };
    x: {
      enabled: boolean;
      apiKey: string;
      apiSecret: string;
      accessToken: string;
      accessSecret: string;
    };
    devto: { apiKey: string };
  };
  tuning: Tuning;
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Read a secret: direct env var first, then FILE env var (Docker secrets /
 * Kubernetes).  The FILE variant trumps the direct one when both are set,
 * because a secrets-manager-managed file is more trustworthy than an env var.
 *
 *   DISCORD_BOT_TOKEN=...                  ← direct
 *   DISCORD_BOT_TOKEN_FILE=/run/secrets/dt ← Docker/K8s secret
 *
 * Either form works; both absent = fallback.
 */
function secretFromEnv(name: string, fallback = ""): string {
  const direct = process.env[name];
  if (direct !== undefined && direct !== "") return direct;
  const filePath = process.env[`${name}_FILE`];
  if (filePath !== undefined && filePath !== "") {
    try {
      return readFileSync(filePath, "utf8").trim();
    } catch {
      // File pointer is set but unreadable — treat as absent.
    }
  }
  return fallback;
}

/** Resolve an API key: try the named env-var, then the *_FILE pointer. */
function secretKey(name: string, fallback = ""): string {
  return secretFromEnv(name, fallback);
}

/**
 * For provider presets: probe every listed key-env name using the _FILE-aware
 * resolver, return the first non-empty value.
 */
function firstSecretKey(names: string[]): string {
  for (const n of names) {
    const v = secretFromEnv(n);
    if (v !== "") return v;
  }
  return "";
}

interface ProviderPreset {
  kind: LlmProviderKind;
  base: string;
  model: string;
  /** Env var names probed for the key, in order. Empty list = keyless (local). */
  keyEnvs: string[];
}

/**
 * Friendly provider names → wire protocol + defaults. Local servers
 * (ollama / LM Studio / llama.cpp server) all speak the OpenAI protocol.
 */
const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    kind: "deepseek",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyEnvs: ["DEEPSEEK_API_KEY"],
  },
  anthropic: {
    kind: "anthropic",
    base: "https://api.anthropic.com",
    model: "claude-haiku-4-5-20251001",
    keyEnvs: ["ANTHROPIC_API_KEY"],
  },
  /** Any proxy/gateway exposing the Anthropic Messages API — base URL required. */
  "anthropic-compatible": {
    kind: "anthropic",
    base: "",
    model: "claude-haiku-4-5-20251001",
    keyEnvs: ["DIOSCURI_LLM_API_KEY", "ANTHROPIC_API_KEY"],
  },
  "openai-compatible": {
    kind: "openai-compatible",
    base: "",
    model: "gpt-4o-mini",
    keyEnvs: ["DIOSCURI_LLM_API_KEY", "OPENAI_API_KEY"],
  },
  openai: {
    kind: "openai-compatible",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyEnvs: ["OPENAI_API_KEY", "DIOSCURI_LLM_API_KEY"],
  },
  ollama: {
    kind: "openai-compatible",
    base: "http://localhost:11434/v1",
    model: "llama3.1",
    keyEnvs: [],
  },
  lmstudio: {
    kind: "openai-compatible",
    base: "http://localhost:1234/v1",
    model: "local-model",
    keyEnvs: [],
  },
  llamacpp: {
    kind: "openai-compatible",
    base: "http://localhost:8080/v1",
    model: "local-model",
    keyEnvs: [],
  },
  "llama.cpp": {
    kind: "openai-compatible",
    base: "http://localhost:8080/v1",
    model: "local-model",
    keyEnvs: [],
  },
};

function resolveLlm(prefix: string, providerName: string): LlmConfig | null {
  const preset = PROVIDER_PRESETS[providerName.toLowerCase().trim()];
  if (!preset) return null;
  const key = firstSecretKey(preset.keyEnvs);
  return {
    provider: preset.kind,
    apiKey: key,
    model: env(`${prefix}_MODEL`, preset.model),
    baseUrl: env(`${prefix}_BASE_URL`, preset.base),
    timeoutMs: Number(env(`${prefix}_TIMEOUT_MS`, env("DIOSCURI_LLM_TIMEOUT_MS", "30000"))),
  };
}

function defaultLlm(): LlmConfig {
  return (
    resolveLlm("DIOSCURI_LLM", env("DIOSCURI_LLM_PROVIDER", "deepseek")) ??
    resolveLlm("DIOSCURI_LLM", "deepseek")!
  );
}

/** Optional secondary provider — used by the failover client when the primary trips its breaker. */
function fallbackLlm(): LlmConfig | null {
  const name = env("DIOSCURI_LLM_FALLBACK_PROVIDER");
  if (name === "") return null;
  return resolveLlm("DIOSCURI_LLM_FALLBACK", name);
}

/** Load config from env + optional JSON tuning file. Throws on invalid tuning. */
export function loadConfig(tuningPath = env("DIOSCURI_CONFIG", "dioscuri.config.json")): DioscuriConfig {
  let rawTuning: unknown = {};
  try {
    rawTuning = JSON.parse(readFileSync(tuningPath, "utf8"));
  } catch {
    // Missing/unreadable tuning file is fine — defaults apply.
  }
  const tuning = TuningSchema.parse(rawTuning);

  const telegramToken = secretFromEnv("TELEGRAM_BOT_TOKEN");
  const discordToken = secretFromEnv("DISCORD_BOT_TOKEN");
  const dryRun = env("DIOSCURI_DRY_RUN") === "1";

  return {
    httpPort: Number(env("DIOSCURI_HTTP_PORT", "8790")),
    dataDir: env("DIOSCURI_DATA_DIR", "./data"),
    dryRun,
    telegram: {
      token: telegramToken,
      chatId: env("TELEGRAM_CHAT_ID"),
      enabled: !dryRun && telegramToken !== "" && env("TELEGRAM_DISABLED") !== "1",
      autoSetup: env("TELEGRAM_AUTOSETUP", "1") === "1",
    },
    discord: {
      token: discordToken,
      guildId: env("DISCORD_GUILD_ID"),
      modLogChannelId: env("DISCORD_MOD_LOG_CHANNEL_ID"),
      announceChannelId: env("DISCORD_ANNOUNCE_CHANNEL_ID"),
      gallerySpotlightChannelId: env("DISCORD_GALLERY_SPOTLIGHT_CHANNEL_ID"),
      canonChannelId: env("DISCORD_CANON_CHANNEL_ID"),
      generalChannelId: env("DISCORD_GENERAL_CHANNEL_ID"),
      enabled: !dryRun && discordToken !== "" && env("DISCORD_DISABLED") !== "1",
      autoStructure: env("DISCORD_AUTOSTRUCTURE", "1") === "1",
    },
    llm: defaultLlm(),
    llmFallback: fallbackLlm(),
    githubToken: secretFromEnv("GITHUB_TOKEN"),
    images: {
      // Provider-specific key first, generic override wins if set explicitly.
      apiKey:
        secretFromEnv("DIOSCURI_IMAGE_API_KEY") ||
        (tuning.content.images.aiProvider === "openai"
          ? secretFromEnv("OPENAI_API_KEY")
          : tuning.content.images.aiProvider === "together"
            ? secretFromEnv("TOGETHER_API_KEY")
            : ""),
      baseUrl: env("DIOSCURI_IMAGE_BASE_URL"), // required for comfyui
    },
    screenshots: {
      baseUrl: env("DIOSCURI_SCREENSHOT_BASE_URL"),
    },
    syndication: {
      bluesky: tuning.syndication.bluesky
        ? {
            identifier: secretFromEnv("BLUESKY_IDENTIFIER"),
            appPassword: secretFromEnv("BLUESKY_APP_PASSWORD"),
          }
        : { identifier: "", appPassword: "" },
      mastodon: {
        baseUrl: env("MASTODON_BASE_URL"), // URL, not a secret
        accessToken: secretFromEnv("MASTODON_ACCESS_TOKEN"),
      },
      x: {
        enabled: env("X_SYNDICATION") === "1",
        apiKey: secretFromEnv("X_API_KEY"),
        apiSecret: secretFromEnv("X_API_SECRET"),
        accessToken: secretFromEnv("X_ACCESS_TOKEN"),
        accessSecret: secretFromEnv("X_ACCESS_SECRET"),
      },
      devto: { apiKey: secretFromEnv("DEVTO_API_KEY") },
    },
    tuning,
  };
}
