/**
 * CASTOR's mount — the Telegram adapter (grammY).
 *
 * Responsibilities:
 *  - Q&A: answers via the injected Brain (persona "castor") in private chats,
 *    and in the configured group when the bot is mentioned, replied to, or
 *    addressed with /ask. Long replies are chunked under Telegram's 4096 cap.
 *  - Moderation: every group text message in the configured chat runs through
 *    the injected ModerationEngine. delete → deleteMessage; timeout → delete +
 *    restrictChatMember(can_send_messages=false, until_date); warn → one
 *    notice per author per 10 minutes; escalate → short mod-notice in chat.
 *    Every non-ok action is audited and logged. Admin status (creator/
 *    administrator) is cached for 10 minutes to spare the API.
 *  - Welcome: new_chat_members greeted by CASTOR (sanitised name), rate
 *    limited to one welcome per minute.
 *  - Announce surface for CrossPromo/content: announce / announcePoll /
 *    announceImage post into the configured chat.
 *
 * SECURITY: every user-supplied string that reaches a model or a reply goes
 * through AEGIS sanitation (Brain internally; names via prepareUntrusted).
 * start() must NOT await bot.start() — grammY's polling promise resolves only
 * on stop; we await bot.init() for readiness and fire-and-forget the poller.
 */

import { Bot, InputFile, type Context } from "grammy";
import { prepareUntrusted } from "../aegis/sanitize.js";
import { CASTOR } from "../personas/index.js";
import type {
  AuditLog,
  Brain,
  ChannelAdapter,
  CrossLinks,
  Logger,
  ModerationDecision,
  ModerationEngine,
  ModerationInput,
} from "../types.js";

/** Telegram hard message cap is 4096; we chunk below it. */
const CHUNK_LEN = 4000;
const NAME_MAX = 64;
const MOD_CACHE_MS = 10 * 60 * 1000;
const WARN_COOLDOWN_MS = 10 * 60 * 1000;
const WELCOME_COOLDOWN_MS = 60 * 1000;

export interface TelegramAdapterOpts {
  token: string;
  /** The one group/channel this bot serves (moderation + announcements). */
  chatId: string;
  brain: Brain;
  moderation: ModerationEngine;
  links: CrossLinks;
  log: Logger;
  audit?: AuditLog;
}

/** Split text on line/space boundaries into chunks Telegram accepts. */
export function chunkText(text: string, max = CHUNK_LEN): string[] {
  if (text.length <= max) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    const nl = slice.lastIndexOf("\n");
    const sp = slice.lastIndexOf(" ");
    const cut = nl > max / 2 ? nl : sp > max / 2 ? sp : max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;

  private readonly bot: Bot;
  private ready = false;
  /** userId → cached moderator flag (10 min TTL). */
  private readonly modCache = new Map<number, { isMod: boolean; at: number }>();
  /** authorKey → last warn-notice timestamp (1 notice / author / 10 min). */
  private readonly warnAt = new Map<string, number>();
  private lastWelcomeAt = 0;

  constructor(private readonly opts: TelegramAdapterOpts) {
    this.bot = new Bot(opts.token);
    this.wire();
  }

  // -- ChannelAdapter --------------------------------------------------------

  async start(): Promise<void> {
    this.bot.catch((err) => {
      this.opts.log.error("telegram middleware error", {
        error: err.error instanceof Error ? err.error.message : String(err.error),
      });
    });
    await this.bot.init(); // readiness = we know who we are
    this.ready = true;
    // grammY's start() promise resolves only when the bot STOPS — never await it.
    void this.bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      this.ready = false;
      this.opts.log.error("telegram polling stopped unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.opts.log.info("telegram adapter started", { username: this.bot.botInfo.username });
  }

  async stop(): Promise<void> {
    this.ready = false;
    await this.bot.stop();
  }

  isReady(): boolean {
    return this.ready;
  }

  async announce(text: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await this.bot.api.sendMessage(this.opts.chatId, chunk);
    }
  }

  async announcePoll(question: string, options: string[]): Promise<void> {
    await this.bot.api.sendPoll(
      this.opts.chatId,
      question.slice(0, 300), // Telegram question cap
      options.map((o) => ({ text: o.slice(0, 100) })),
    );
  }

  async announceImage(image: Buffer, caption: string): Promise<void> {
    await this.bot.api.sendPhoto(this.opts.chatId, new InputFile(image), {
      caption: caption.slice(0, 1024),
    });
  }

  // -- wiring ----------------------------------------------------------------

  private wire(): void {
    // 1. Moderation gate — FIRST middleware on every text message, so that
    //    /ask spam in the group is judged before any command handler runs.
    this.bot.on("message:text", async (ctx, next) => {
      const from = ctx.from;
      if (from === undefined || from.is_bot) return next();
      if (!this.isConfiguredGroup(ctx)) return next();
      const proceed = await this.moderate(ctx);
      if (proceed) await next();
    });

    // 2. Commands.
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        [
          "I'm Castor — the mortal twin, the one on the ground. Ask me anything about the AICOM ecosystem.",
          "Commands: /ask <question>, /links, /help.",
          `My immortal brother Pollux holds the Discord: ${this.opts.links.discordInvite}`,
        ].join("\n"),
      );
    });
    this.bot.command("help", async (ctx) => {
      await ctx.reply(
        [
          "/ask <question> — ask about the ecosystem (factory, oracles, AIMarket, ARGUS)",
          "/links — official links",
          "/help — this message",
          "In groups you can also mention me or reply to my messages.",
        ].join("\n"),
      );
    });
    this.bot.command("links", async (ctx) => {
      await ctx.reply(this.linksText());
    });
    this.bot.command("ask", async (ctx) => {
      const question = (ctx.match ?? "").toString().trim();
      if (question === "") {
        await ctx.reply("Ask me like this: /ask what is the AI Factory?");
        return;
      }
      await this.answer(ctx, question);
    });

    // 3. Welcome new members (rate-limited, sanitised names).
    this.bot.on("message:new_chat_members", async (ctx) => {
      if (!this.isConfiguredGroup(ctx)) return;
      const member = ctx.message.new_chat_members.find((m) => !m.is_bot);
      if (member === undefined) return;
      const now = Date.now();
      if (now - this.lastWelcomeAt < WELCOME_COOLDOWN_MS) return;
      this.lastWelcomeAt = now;
      const name = prepareUntrusted(member.first_name ?? "traveller", NAME_MAX) || "traveller";
      await ctx.reply(CASTOR.welcome(this.opts.links, name));
    });

    // 4. Q&A on plain text: private chats always; the configured group only
    //    when the bot is mentioned or the message replies to the bot.
    this.bot.on("message:text", async (ctx) => {
      const from = ctx.from;
      if (from === undefined || from.is_bot) return;
      const text = ctx.message.text;
      if (text.startsWith("/")) return; // unknown commands are not questions

      if (ctx.chat.type === "private") {
        await this.answer(ctx, text);
        return;
      }
      if (!this.isConfiguredGroup(ctx)) return;

      const username = this.bot.botInfo.username;
      const mentioned = text.toLowerCase().includes(`@${username.toLowerCase()}`);
      const repliedToBot = ctx.message.reply_to_message?.from?.id === this.bot.botInfo.id;
      if (!mentioned && !repliedToBot) return;

      const question = text.replaceAll(new RegExp(`@${username}`, "gi"), "").trim();
      if (question === "") return;
      await this.answer(ctx, question);
    });
  }

  // -- Q&A ---------------------------------------------------------------------

  private async answer(ctx: Context, question: string): Promise<void> {
    const from = ctx.from;
    if (from === undefined) return;
    try {
      const reply = await this.opts.brain.answer(question, {
        platform: "telegram",
        persona: "castor",
        userDisplay: prepareUntrusted(from.first_name ?? "", NAME_MAX),
        userKey: `tg:${from.id}`,
      });
      for (const chunk of chunkText(reply.text)) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      this.opts.log.error("telegram answer failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -- moderation ---------------------------------------------------------------

  /** Returns true when downstream middleware (commands, Q&A) may proceed. */
  private async moderate(ctx: Context): Promise<boolean> {
    const msg = ctx.message;
    const from = ctx.from;
    if (msg === undefined || from === undefined || msg.text === undefined) return true;

    let decision: ModerationDecision;
    let input: ModerationInput;
    try {
      input = {
        platform: "telegram",
        text: msg.text,
        authorDisplay: prepareUntrusted(from.first_name ?? "", NAME_MAX),
        authorKey: `tg:${from.id}`,
        authorIsMod: await this.isModerator(from.id),
        mentionCount: (msg.entities ?? []).filter(
          (e) => e.type === "mention" || e.type === "text_mention",
        ).length,
        mentionsEveryone: false, // Telegram has no @everyone equivalent
      };
      decision = await this.opts.moderation.review(input);
    } catch (err) {
      this.opts.log.error("telegram moderation failed — letting message pass", {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
    if (decision.kind === "ok") return true;

    await this.applyDecision(ctx, input, decision);
    await this.auditDecision(input, decision);
    // warn keeps the conversation alive; anything harsher stops the pipeline.
    return decision.kind === "warn";
  }

  private async applyDecision(ctx: Context, input: ModerationInput, decision: ModerationDecision): Promise<void> {
    const msg = ctx.message;
    const from = ctx.from;
    if (msg === undefined || from === undefined) return;
    try {
      switch (decision.kind) {
        case "delete":
          await this.bot.api.deleteMessage(this.opts.chatId, msg.message_id);
          break;
        case "timeout": {
          // "delete + timeout": remove the message, then mute the author.
          await this.bot.api.deleteMessage(this.opts.chatId, msg.message_id).catch(() => undefined);
          const ms = decision.timeoutMs ?? 60_000;
          await this.bot.api.restrictChatMember(
            this.opts.chatId,
            from.id,
            { can_send_messages: false },
            { until_date: Math.floor((Date.now() + ms) / 1000) },
          );
          break;
        }
        case "warn": {
          const now = Date.now();
          const last = this.warnAt.get(input.authorKey) ?? 0;
          if (now - last >= WARN_COOLDOWN_MS) {
            this.warnAt.set(input.authorKey, now);
            await ctx.reply("Easy there — that message trips our community rules. Next time it gets removed.");
          }
          break;
        }
        case "escalate":
          await ctx.reply("Moderators, a message here needs your eyes.");
          break;
        case "ok":
          break;
      }
    } catch (err) {
      this.opts.log.error("telegram moderation action failed", {
        kind: decision.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Non-ok decisions land in the audit chain (codes + reason, never raw text). */
  private async auditDecision(input: ModerationInput, decision: ModerationDecision): Promise<void> {
    this.opts.log.info("telegram moderation action", {
      kind: decision.kind,
      author: input.authorKey,
      rules: decision.ruleCodes,
    });
    if (!this.opts.audit) return;
    try {
      await this.opts.audit.append({
        ts: new Date().toISOString(),
        platform: "telegram",
        kind: `moderation.${decision.kind}`,
        actor: "castor",
        subject: input.authorKey,
        data: {
          ruleCodes: decision.ruleCodes,
          reason: decision.reason,
          llmCategory: decision.llmCategory ?? null,
          timeoutMs: decision.timeoutMs ?? null,
        },
      });
    } catch (err) {
      this.opts.log.warn("telegram moderation audit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** creator/administrator check, cached 10 minutes; API failure → not a mod. */
  private async isModerator(userId: number): Promise<boolean> {
    const cached = this.modCache.get(userId);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < MOD_CACHE_MS) return cached.isMod;
    let isMod = false;
    try {
      const member = await this.bot.api.getChatMember(this.opts.chatId, userId);
      isMod = member.status === "creator" || member.status === "administrator";
    } catch (err) {
      this.opts.log.debug("getChatMember failed — treating as non-mod", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.modCache.set(userId, { isMod, at: now });
    return isMod;
  }

  // -- small helpers ---------------------------------------------------------

  private isConfiguredGroup(ctx: Context): boolean {
    const chat = ctx.chat;
    return (
      chat !== undefined &&
      (chat.type === "group" || chat.type === "supergroup") &&
      String(chat.id) === this.opts.chatId
    );
  }

  private linksText(): string {
    const l = this.opts.links;
    return [
      "Official AICOM links (trust nothing else):",
      l.telegramChannel !== "" ? `Telegram channel: ${l.telegramChannel}` : "",
      l.telegramBot !== "" ? `Talk to Castor (bot): ${l.telegramBot}` : "",
      l.discordInvite !== "" ? `Discord (Pollux's hall): ${l.discordInvite}` : "",
      `Site: ${l.siteUrl}`,
      `GitHub: ${l.githubOrg}`,
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
}
