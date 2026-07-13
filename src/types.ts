/**
 * DIOSCURI — shared contract for every module.
 *
 * One mind, two heavens: CASTOR (Telegram) and POLLUX (Discord) are two personas
 * of a single process sharing one knowledge base (MNEMOSYNE) and one shield (AEGIS).
 *
 * RULES OF THE HOUSE
 *  - Cross-module dependencies go through the interfaces in this file ONLY.
 *    Concrete classes are wired together in src/index.ts (dependency injection).
 *  - Untrusted text (any platform message, any GitHub-synced document) must pass
 *    through AEGIS sanitation before it is stored, logged, or shown to a model.
 *  - The public Q&A path has ZERO tools: retrieval is deterministic and happens
 *    before the model call; the model can only produce text.
 */

// ---------------------------------------------------------------------------
// Severity & AEGIS (injection firewall)
// ---------------------------------------------------------------------------

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface AegisFinding {
  /** Stable machine code, e.g. INJECTION_CRITICAL, HIDDEN_UNICODE, BASE64_BLOB. */
  code: string;
  severity: Severity;
  message: string;
}

export type AegisAction =
  | "allow"     // clean — sanitizedText may be used
  | "reject";   // do not let this text reach a model; reply with canned refusal

export interface AegisVerdict {
  action: AegisAction;
  /** 0..1 trust score (1 = clean). Informational; action is authoritative. */
  score: number;
  findings: AegisFinding[];
  /** NFKC-normalised, control/zero-width-stripped, marker-neutralised, length-capped. */
  sanitizedText: string;
}

export interface AegisGate {
  /** Scan + sanitise one piece of untrusted text (a chat message, a doc chunk). */
  inspect(text: string, opts?: { maxLen?: number }): AegisVerdict;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateDecision {
  allowed: boolean;
  /** Milliseconds until the key may retry (present when !allowed). */
  retryAfterMs?: number;
  /** Tokens remaining in the current window. */
  remaining: number;
}

export interface RateLimiter {
  /** Consume one token for `key` (e.g. "tg:12345" or "dc:9876"). */
  check(key: string): RateDecision;
}

// ---------------------------------------------------------------------------
// MNEMOSYNE (knowledge base, self-updating from GitHub)
// ---------------------------------------------------------------------------

export type KnowledgeSource = "readme" | "release" | "repo-meta" | "doc" | "live";

export interface KnowledgeChunk {
  /** Stable id: `${repo}#${source}#${n}`. */
  id: string;
  repo: string;
  source: KnowledgeSource;
  title: string;
  url: string;
  /** AEGIS-sanitised plain text, ~<=1600 chars. */
  text: string;
  /** ISO timestamp of the upstream update. */
  updatedAt: string;
}

export interface RetrievalHit {
  chunk: KnowledgeChunk;
  score: number;
}

export interface ReleaseEvent {
  repo: string;
  tag: string;
  name: string;
  url: string;
  /** AEGIS-sanitised release notes excerpt. */
  summary: string;
  publishedAt: string;
}

export interface MnemosyneStats {
  chunks: number;
  repos: number;
  lastSyncAt: string | null;
  lastSyncOk: boolean;
}

export interface DemoMatch {
  repo: string;
  url: string;
}

export interface Mnemosyne {
  /** Deterministic lexical retrieval (BM25-ish). Never calls a model. */
  search(query: string, k: number): RetrievalHit[];
  stats(): MnemosyneStats;
  /** Fired once per NEW release discovered by a sync pass (not on first seed). */
  onRelease(cb: (ev: ReleaseEvent) => void): void;
  /** Run one sync pass now. Resolves when the store is updated. */
  syncOnce(): Promise<void>;
  /** Start periodic background sync. */
  start(): void;
  stop(): void;
  /** Per-repo demo page URLs from README extraction (repo slug → URL). */
  demoUrls?(): Record<string, string>;
  /** Match a content topic to a demo page for screenshots. */
  resolveDemoUrl?(topic: string): DemoMatch | null;
  /**
   * Optional external chunk injection (live showcase snapshots). Atomic per
   * sourceKey; implementations should NOT persist live data (stale "current
   * state" is worse than none).
   */
  ingest?(sourceKey: string, chunks: KnowledgeChunk[]): void;
}

// ---------------------------------------------------------------------------
// LLM client (multi-provider, fetch-based, no SDK deps)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object response (classifier calls). */
  json?: boolean;
}

export interface LlmClient {
  /** Returns assistant text. Throws LlmError / LlmBudgetError on failure. */
  chat(opts: ChatOptions): Promise<string>;
}

export class LlmError extends Error {}
export class LlmBudgetError extends LlmError {}

// ---------------------------------------------------------------------------
// Personas & cross-promotion
// ---------------------------------------------------------------------------

export type PersonaId = "castor" | "pollux";
export type Platform = "telegram" | "discord";

export interface CrossLinks {
  discordInvite: string;
  telegramChannel: string;
  /** Public bot link for DMs (/ask in private chat). */
  telegramBot: string;
  siteUrl: string;
  githubOrg: string;
  /** THEOROS canon landing + GitHub Pages. */
  theorosUrl: string;
}

/** Structured THEOROS column for #the-canon — branded separately from Pollux. */
export interface CanonDiscordPost {
  chapterLabel: string;
  body: string;
  debateHook: string;
  canonUrl: string;
}

export interface Persona {
  id: PersonaId;
  platform: Platform;
  /** Display name, e.g. "Castor". */
  name: string;
  /** Sibling persona display name + where he lives. */
  sibling: { name: string; platform: Platform };
  /** Full system prompt (identity + hard security rules + cross-promo policy). */
  systemPrompt(links: CrossLinks): string;
  /** Rotating cross-promo lines pointing at the sibling's channel. */
  promoLines(links: CrossLinks): string[];
  /** Welcome for a new member (already sanitised display name). */
  welcome(links: CrossLinks, memberName: string): string;
  /** Release announcement in this persona's voice. */
  releaseAnnouncement(links: CrossLinks, ev: ReleaseEvent): string;
}

// ---------------------------------------------------------------------------
// Brain (persona-voiced Q&A over MNEMOSYNE, guarded by AEGIS)
// ---------------------------------------------------------------------------

export interface AskContext {
  platform: Platform;
  persona: PersonaId;
  /** Sanitised display name of the asker (for tone only, never trusted). */
  userDisplay: string;
  /** Stable rate-limit key, e.g. "tg:12345". */
  userKey: string;
}

export interface BrainReply {
  text: string;
  /** True when AEGIS rejected the input or budget/rate limits refused the call. */
  refused: boolean;
}

export interface Brain {
  answer(question: string, ctx: AskContext): Promise<BrainReply>;
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * Action ceiling is deliberate: the bot may warn, delete and timeout.
 * BAN IS NEVER AUTOMATIC — worst case is "escalate" (ping human mods).
 */
export type ModerationActionKind = "ok" | "warn" | "delete" | "timeout" | "escalate";

export interface ModerationInput {
  platform: Platform;
  /** Raw message text (will be AEGIS-sanitised internally). */
  text: string;
  /** Sanitised author display name. */
  authorDisplay: string;
  /** Stable author key for flood tracking. */
  authorKey: string;
  /** True if the author is a moderator/admin — deterministic rules soften. */
  authorIsMod: boolean;
  /** Mentions count (platform-parsed), incl. @everyone equivalents. */
  mentionCount: number;
  mentionsEveryone: boolean;
}

export interface ModerationDecision {
  kind: ModerationActionKind;
  /** Deterministic rule codes that fired, e.g. FOREIGN_INVITE, FLOOD, MASS_MENTION. */
  ruleCodes: string[];
  /** Category from the LLM classifier when it ran (spam/scam/toxicity/nsfw/none). */
  llmCategory?: string;
  /** Human-readable reason for the mod-log. */
  reason: string;
  /** Only for kind === "timeout"; capped by config.moderation.maxTimeoutMs. */
  timeoutMs?: number;
}

export interface ModerationEngine {
  review(input: ModerationInput): Promise<ModerationDecision>;
}

// ---------------------------------------------------------------------------
// Audit (hash-chained, append-only)
// ---------------------------------------------------------------------------

export interface AuditEvent {
  ts: string;
  platform: Platform | "system";
  kind: string; // e.g. "moderation.delete", "aegis.reject", "promo.post", "kb.sync"
  actor: string;
  subject: string;
  data: Record<string, unknown>;
}

export interface AuditChainEntry extends AuditEvent {
  hash: string;
  prevHash: string;
}

export interface AuditLog {
  append(ev: AuditEvent): Promise<AuditChainEntry>;
  /** Verify the whole chain on disk; returns first broken index or -1 if intact. */
  verify(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface ChannelAdapter {
  readonly platform: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Post to the main announce channel (promo, releases, content). */
  announce(text: string): Promise<void>;
  /**
   * Post to the builders' gallery spotlight channel (show-and-tell nudges).
   * Optional — falls back to announce() when not configured.
   */
  announceGallery?(text: string): Promise<void>;
  /** Post to #the-canon (THEOROS weekly column). Optional — canon slot skipped when missing. */
  announceCanon?(post: CanonDiscordPost): Promise<void>;
  /** Post to #general (Pollux pointers — canon launch, etc.). Optional — skipped when missing. */
  announceGeneral?(text: string): Promise<void>;
  /**
   * Native platform poll in the announce channel (Telegram sendPoll /
   * Discord poll). Optional — callers must fall back to announce() text.
   */
  announcePoll?(question: string, options: string[]): Promise<void>;
  /**
   * Post an image with caption to the announce channel (Telegram sendPhoto /
   * Discord attachment). Optional — callers must fall back to announce() text.
   */
  announceImage?(image: Buffer, caption: string): Promise<void>;
  /** True once connected and authenticated. */
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// THEOXENIA (content engine — the feast the twins host)
//
// Named for the festival where the Dioscuri were the honoured guests. Fills
// both channels on a weekly rhythm with KB-grounded, persona-voiced content.
// ALL proactive content is English (community default language).
// ---------------------------------------------------------------------------

export type ContentKind =
  | "spotlight"      // deep-dive on one ecosystem component, grounded in MNEMOSYNE
  | "banter"         // cross-platform joke: setup on one platform, punchline on the other
  | "poll"           // engagement question (native platform poll when supported)
  | "digest"         // "This week in the forge" — recent releases/updates from the KB
  | "show-and-tell"  // nudge to share what people built (Discord-first)
  | "canon";         // THEOROS weekly column — Discord-only, KB-grounded

export interface ContentSlot {
  kind: ContentKind;
  /** Day of week, lowercase: mon..sun. */
  day: "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
  /** Posting hour, UTC (jittered ±30 min at runtime). */
  hourUtc: number;
}

/** Author's manual topic queue item (data/content-queue.json) — consumed first. */
export interface QueuedTopic {
  kind?: ContentKind;
  topic: string;
  note?: string;
}

export interface ContentEngine {
  start(): void;
  stop(): void;
  /** Generate + post one slot immediately (manual trigger / tests). */
  runSlotNow(kind: ContentKind): Promise<void>;
}

// ---------------------------------------------------------------------------
// KERYX (the herald) — outbound syndication beyond the twins' own channels
//
// SAFETY CHARTER (non-negotiable, keep implementations inside it):
//  - POST-ONLY: sinks publish our own guarded text to OUR OWN accounts.
//    No replies, likes, follows, DMs or any engagement automation — that is
//    the platform-manipulation ban vector on every network.
//  - Low volume by design: release announcements + a monthly digest article.
//  - Fail-soft: a broken sink logs and is skipped; it never breaks the twins.
// ---------------------------------------------------------------------------

export interface SyndicationSink {
  readonly name: string;
  /** Publish one short post to our own account. Throws on failure (caller logs+skips). */
  post(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Images — optional AI memes + demo screenshots
// ---------------------------------------------------------------------------

/**
 * Optional AI image generation (env-gated, OFF by default).
 * SECURITY: prompts are built ONLY from our own templates + config topics.
 * User-supplied text must NEVER reach an image prompt.
 */
export interface ImageProvider {
  readonly name: string;
  generate(prompt: string, opts?: { size?: string }): Promise<Buffer>;
}

/** README demo-page capture via the Playwright sidecar. */
export interface ScreenshotProvider {
  readonly name: "screenshot";
  capture(url: string, opts?: { viewport?: string }): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
}
