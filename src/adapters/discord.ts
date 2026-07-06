/**
 * POLLUX's hall — the Discord adapter (discord.js v14).
 *
 * Responsibilities:
 *  - Q&A: answers via the injected Brain (persona "pollux") when the bot is
 *    mentioned, replied to, or DM'd. Guild-scoped slash commands /ask /links
 *    /help are registered on clientReady (/ask defers; links/help ephemeral).
 *  - Moderation: every guild message (bots/webhooks/system skipped) runs
 *    through the injected ModerationEngine. delete → message.delete();
 *    timeout → delete + member.timeout(ms) behind a moderatable-permission
 *    guard; warn → one reply notice per author per 10 minutes; escalate →
 *    embed to the mod-log channel. EVERY non-ok action gets a mod-log embed
 *    and an audit-chain entry (rule codes + reason, never raw hostile text).
 *  - Welcome: guildMemberAdd greeted by POLLUX in the announce channel,
 *    rate limited to one per minute.
 *  - Announce surface: announce / announceImage / announcePoll (native poll
 *    with plain-text fallback) into the announce channel. When the announce
 *    channel is a Discord Announcement channel, sent messages are auto-
 *    crossposted (own try/catch — the 10/hour crosspost limit never breaks a
 *    post) so other servers can Follow us: free, official syndication.
 *  - DISBOARD bump reminder (opt-in): when DISBOARD confirms a /bump in our
 *    guild, schedule ONE timer for cooldown + slack and remind the Keepers in
 *    the same channel. This is a reminder for HUMANS — the bot never calls
 *    /bump or interacts with DISBOARD (auto-bumping is against their rules).
 *
 * SECURITY: allowedMentions {parse: [], repliedUser: true} is set client-wide
 * so nothing this bot posts can ever ping @everyone/roles/users; names are
 * AEGIS-sanitised before they reach the Brain. The single sanctioned exception
 * is the bump reminder, which may mention exactly the Keeper role (explicit
 * allowedMentions.roles allow-list; parse stays empty). Every handler is
 * try/caught — a hostile message must never crash the gateway loop.
 */

import {
  ApplicationCommandOptionType,
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type SendableChannels,
} from "discord.js";
import { prepareUntrusted } from "../aegis/sanitize.js";
import { POLLUX } from "../personas/index.js";
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

/** Discord hard message cap is 2000; the Brain already stays under 1900. */
const CHUNK_LEN = 1990;
const NAME_MAX = 64;
const WARN_COOLDOWN_MS = 10 * 60 * 1000;
const WELCOME_COOLDOWN_MS = 60 * 1000;

/** DISBOARD's well-known bot user id — used only to RECOGNISE its bump confirmations. */
export const DISBOARD_BOT_ID = "302050872383242240";
/** DISBOARD /bump cooldown (2h) + 2 min of slack so we never remind early. */
const BUMP_REMINDER_DELAY_MS = (2 * 60 + 2) * 60 * 1000;
/** Same role name the provisioner creates (kept literal — no provision import). */
const KEEPER_ROLE_NAME = "Keeper";

/**
 * Pure seam (unit-tested): does this message look like DISBOARD confirming a
 * successful /bump? DISBOARD replies with an embed whose description contains
 * "Bump done". Detection is read-only — the bot NEVER calls /bump or interacts
 * with DISBOARD itself (their guidelines forbid auto-bumping; reminding humans
 * is the sanctioned pattern).
 */
export function isDisboardBumpSuccess(authorId: string, embedDescriptions: string[]): boolean {
  if (authorId !== DISBOARD_BOT_ID) return false;
  return embedDescriptions.some((d) => d.includes("Bump done"));
}

/**
 * Pure seam (unit-tested): the Keeper reminder posted when the bump cooldown
 * ends. This is the ONLY place a role mention is ever allowed — allowedMentions
 * pins exactly that role and parse stays empty, so nothing else can ping.
 */
export function buildBumpReminder(keeperRoleId: string | null): {
  content: string;
  allowedMentions: { roles: string[]; parse: never[] };
} {
  const text = "⏰ The DISBOARD altar is ready — Keepers, /bump when you have a moment.";
  if (keeperRoleId === null) {
    return { content: text, allowedMentions: { roles: [], parse: [] } };
  }
  return {
    content: `<@&${keeperRoleId}> ${text}`,
    allowedMentions: { roles: [keeperRoleId], parse: [] },
  };
}

const COMMANDS: ApplicationCommandDataResolvable[] = [
  {
    name: "ask",
    description: "Ask Pollux about the AICOM ecosystem",
    options: [
      {
        name: "question",
        description: "Your question (factory, oracles, AIMarket, ARGUS...)",
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  { name: "links", description: "Official AICOM links" },
  { name: "help", description: "What Pollux can do here" },
];

export interface DiscordAdapterOpts {
  token: string;
  guildId: string;
  modLogChannelId: string;
  announceChannelId: string;
  brain: Brain;
  moderation: ModerationEngine;
  links: CrossLinks;
  log: Logger;
  audit?: AuditLog;
  /** Remind Keepers ~2h after a DISBOARD bump succeeds (default false). */
  bumpReminder?: boolean;
}

/** Split long text on line/space boundaries under the Discord cap. */
function chunkText(text: string, max = CHUNK_LEN): string[] {
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

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = "discord" as const;

  private readonly client: Client;
  private ready = false;
  /** authorKey → last warn-notice timestamp (1 notice / author / 10 min). */
  private readonly warnAt = new Map<string, number>();
  private lastWelcomeAt = 0;
  /** At most ONE pending DISBOARD bump reminder (re-bump replaces it). */
  private bumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: DiscordAdapterOpts) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
      ],
      partials: [Partials.Channel], // DMs arrive as partial channels
      // Nothing this bot posts may ever ping people; replied-user only.
      allowedMentions: { parse: [], repliedUser: true },
    });
    this.wire();
  }

  // -- ChannelAdapter --------------------------------------------------------

  async start(): Promise<void> {
    const readyOnce = new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, () => resolve());
      this.client.once(Events.Error, (err) => reject(err));
    });
    await this.client.login(this.opts.token);
    await readyOnce;
    this.ready = true;
    this.opts.log.info("discord adapter started", { user: this.client.user?.tag ?? "?" });
  }

  async stop(): Promise<void> {
    this.ready = false;
    if (this.bumpTimer !== null) {
      clearTimeout(this.bumpTimer);
      this.bumpTimer = null;
    }
    await this.client.destroy();
  }

  isReady(): boolean {
    return this.ready && this.client.isReady();
  }

  async announce(text: string): Promise<void> {
    const channel = await this.sendable(this.opts.announceChannelId);
    for (const chunk of chunkText(text)) {
      const sent = await channel.send({ content: chunk });
      await this.crosspostIfAnnouncement(sent);
    }
  }

  async announceImage(image: Buffer, caption: string): Promise<void> {
    const channel = await this.sendable(this.opts.announceChannelId);
    const sent = await channel.send({
      content: caption.slice(0, CHUNK_LEN),
      files: [new AttachmentBuilder(image, { name: "card.png" })],
    });
    await this.crosspostIfAnnouncement(sent);
  }

  /**
   * Auto-crosspost: when #announcements is an Announcement channel, publish
   * the message so every server FOLLOWING us receives it — free, official
   * syndication. Strictly fail-soft: crossposting has its own rate limit
   * (10/hour), so failures are logged and swallowed, never rethrown.
   */
  private async crosspostIfAnnouncement(message: Message): Promise<void> {
    if (message.channel.type !== ChannelType.GuildAnnouncement) return;
    try {
      await message.crosspost();
      this.opts.log.debug("announcement crossposted to followers", { messageId: message.id });
    } catch (err) {
      this.opts.log.warn("crosspost failed (limit is 10/hour) — message still posted", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Native Discord poll; any failure falls back to a plain-text ballot. */
  async announcePoll(question: string, options: string[]): Promise<void> {
    const channel = await this.sendable(this.opts.announceChannelId);
    try {
      await channel.send({
        poll: {
          question: { text: question.slice(0, 300) },
          answers: options.map((o) => ({ text: o.slice(0, 55) })),
          duration: 24,
          allowMultiselect: false,
        },
      });
    } catch (err) {
      this.opts.log.warn("native poll failed — falling back to text", {
        error: err instanceof Error ? err.message : String(err),
      });
      await this.announce(
        `${question}\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\nVote with a reply!`,
      );
    }
  }

  // -- wiring ----------------------------------------------------------------

  private wire(): void {
    this.client.once(Events.ClientReady, () => {
      void this.registerCommands();
    });

    this.client.on(Events.Error, (err) => {
      this.opts.log.error("discord client error", { error: err.message });
    });

    // WebSocket-level errors (shard reconnect failures, etc.) — must be
    // handled explicitly or they become uncaught exceptions and crash the
    // process. The Telegram adapter has bot.catch() for the same reason.
    this.client.on(Events.ShardError, (err, shardId) => {
      this.opts.log.error("discord shard ws error", {
        shardId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.onMessage(message).catch((err: unknown) => {
        this.opts.log.error("discord message handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.onInteraction(interaction).catch((err: unknown) => {
        this.opts.log.error("discord interaction handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.client.on(Events.GuildMemberAdd, (member) => {
      void (async () => {
        try {
          if (member.guild.id !== this.opts.guildId || member.user.bot) return;
          const now = Date.now();
          if (now - this.lastWelcomeAt < WELCOME_COOLDOWN_MS) return;
          this.lastWelcomeAt = now;
          const name = prepareUntrusted(member.displayName, NAME_MAX) || "traveller";
          await this.announce(POLLUX.welcome(this.opts.links, name));
        } catch (err) {
          this.opts.log.error("discord welcome failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.client.application?.commands.set(COMMANDS, this.opts.guildId);
      this.opts.log.info("discord slash commands registered", { guildId: this.opts.guildId });
    } catch (err) {
      this.opts.log.error("slash command registration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -- messages: moderation first, then Q&A -----------------------------------

  private async onMessage(message: Message): Promise<void> {
    // DISBOARD is a bot, so its bump confirmation must be spotted BEFORE the
    // bot skip. Detection only — we never message or command DISBOARD.
    if (
      this.opts.bumpReminder === true &&
      message.guildId === this.opts.guildId &&
      isDisboardBumpSuccess(
        message.author.id,
        message.embeds.map((e) => e.description ?? ""),
      )
    ) {
      this.scheduleBumpReminder(message);
    }

    if (message.author.bot || message.webhookId !== null || message.system) return;

    if (message.guildId !== null) {
      if (message.guildId !== this.opts.guildId) return;
      const proceed = await this.moderate(message);
      if (!proceed) return;
    }

    // Q&A triggers: DM, direct mention, or a reply to one of our messages.
    const me = this.client.user;
    if (me === null) return;
    const isDm = message.guildId === null;
    const mentioned = message.mentions.has(me);
    const repliedToBot = message.mentions.repliedUser?.id === me.id;
    if (!isDm && !mentioned && !repliedToBot) return;

    const question = message.content
      .replaceAll(`<@${me.id}>`, "")
      .replaceAll(`<@!${me.id}>`, "")
      .trim();
    if (question === "") return;

    const reply = await this.opts.brain.answer(question, {
      platform: "discord",
      persona: "pollux",
      userDisplay: prepareUntrusted(message.member?.displayName ?? message.author.username, NAME_MAX),
      userKey: `dc:${message.author.id}`,
    });
    for (const chunk of chunkText(reply.text)) {
      await message.reply({ content: chunk });
    }
  }

  /**
   * DISBOARD bump reminder: one timer for cooldown + slack, replacing any
   * pending one (a manual re-bump restarts the clock). When it fires, remind
   * the Keepers in the SAME channel the bump happened in. Fail-soft: a failed
   * post is logged and dropped — the next bump schedules a fresh reminder.
   */
  private scheduleBumpReminder(message: Message): void {
    if (this.bumpTimer !== null) clearTimeout(this.bumpTimer);
    const channel = message.channel;
    const guild = message.guild;
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = null;
      void (async () => {
        try {
          if (!channel.isSendable()) return;
          const keeper = guild?.roles.cache.find(
            (r) => r.name.toLowerCase() === KEEPER_ROLE_NAME.toLowerCase(),
          );
          const reminder = buildBumpReminder(keeper?.id ?? null);
          // The ONLY sanctioned role mention: exactly the Keeper role, parse empty.
          await channel.send({
            content: reminder.content,
            allowedMentions: reminder.allowedMentions,
          });
          this.opts.log.debug("posted DISBOARD bump reminder", { channelId: channel.id });
        } catch (err) {
          this.opts.log.warn("bump reminder post failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }, BUMP_REMINDER_DELAY_MS);
    this.opts.log.debug("DISBOARD bump detected — reminder scheduled", {
      channelId: message.channelId,
      delayMs: BUMP_REMINDER_DELAY_MS,
    });
  }

  // -- interactions ------------------------------------------------------------

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    try {
      switch (interaction.commandName) {
        case "ask":
          await this.handleAsk(interaction);
          break;
        case "links":
          await interaction.reply({ content: this.linksText(), flags: MessageFlags.Ephemeral });
          break;
        case "help":
          await interaction.reply({
            content: [
              "I am Pollux — the immortal twin. What I do here:",
              "/ask — answer ecosystem questions from the shared knowledge base",
              "/links — the official AICOM links",
              "You can also mention me or reply to my messages.",
              `My mortal brother Castor rides Telegram: ${this.opts.links.telegramChannel}`,
            ].join("\n"),
            flags: MessageFlags.Ephemeral,
          });
          break;
        default:
          break;
      }
    } catch (err) {
      this.opts.log.error("slash command failed", {
        command: interaction.commandName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply();
    const question = interaction.options.getString("question", true);
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const reply = await this.opts.brain.answer(question, {
      platform: "discord",
      persona: "pollux",
      userDisplay: prepareUntrusted(member?.displayName ?? interaction.user.username, NAME_MAX),
      userKey: `dc:${interaction.user.id}`,
    });
    await interaction.editReply({ content: reply.text.slice(0, 2000) });
  }

  // -- moderation ---------------------------------------------------------------

  /** Returns true when the message survived and Q&A may look at it. */
  private async moderate(message: Message): Promise<boolean> {
    let decision: ModerationDecision;
    let input: ModerationInput;
    try {
      const member = message.member;
      input = {
        platform: "discord",
        text: message.content,
        authorDisplay: prepareUntrusted(member?.displayName ?? message.author.username, NAME_MAX),
        authorKey: `dc:${message.author.id}`,
        authorIsMod: member?.permissions.has(PermissionFlagsBits.ManageMessages) ?? false,
        mentionCount: message.mentions.users.size + message.mentions.roles.size,
        mentionsEveryone: message.mentions.everyone,
      };
      decision = await this.opts.moderation.review(input);
    } catch (err) {
      this.opts.log.error("discord moderation failed — letting message pass", {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
    if (decision.kind === "ok") return true;

    await this.applyDecision(message, input, decision);
    await this.modLog(input, decision);
    await this.auditDecision(input, decision);
    return decision.kind === "warn";
  }

  private async applyDecision(message: Message, input: ModerationInput, decision: ModerationDecision): Promise<void> {
    try {
      switch (decision.kind) {
        case "delete":
          await message.delete();
          break;
        case "timeout": {
          // "delete + timeout": remove the message, then mute the author —
          // but only when the hierarchy actually lets us (permission guard).
          await message.delete().catch(() => undefined);
          const member = message.member;
          const ms = decision.timeoutMs ?? 60_000;
          if (member !== null && member.moderatable) {
            await member.timeout(ms, decision.reason.slice(0, 512));
          } else {
            this.opts.log.warn("cannot timeout member (hierarchy/permissions)", {
              author: input.authorKey,
            });
          }
          break;
        }
        case "warn": {
          const now = Date.now();
          const last = this.warnAt.get(input.authorKey) ?? 0;
          if (now - last >= WARN_COOLDOWN_MS) {
            this.warnAt.set(input.authorKey, now);
            await message.reply({
              content: "Easy there — that message trips our community rules. Next one gets removed.",
            });
          }
          break;
        }
        case "escalate":
          // The embed to the mod-log channel (below) IS the escalation.
          break;
        case "ok":
          break;
      }
    } catch (err) {
      this.opts.log.error("discord moderation action failed", {
        kind: decision.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Every non-ok decision lands in the mod-log channel as an embed. */
  private async modLog(input: ModerationInput, decision: ModerationDecision): Promise<void> {
    try {
      const channel = await this.sendable(this.opts.modLogChannelId);
      const color = decision.kind === "escalate" ? 0xe74c3c : decision.kind === "warn" ? 0xf1c40f : 0xe67e22;
      const embed = new EmbedBuilder()
        .setTitle(`Moderation: ${decision.kind.toUpperCase()}`)
        .setColor(color)
        .addFields(
          { name: "Author", value: `${input.authorDisplay} (${input.authorKey})`.slice(0, 1024), inline: true },
          { name: "Rules", value: decision.ruleCodes.join(", ") || "—", inline: true },
          { name: "Reason", value: decision.reason.slice(0, 1024) || "—" },
        )
        .setTimestamp();
      if (decision.llmCategory !== undefined) {
        embed.addFields({ name: "Classifier", value: decision.llmCategory, inline: true });
      }
      if (decision.timeoutMs !== undefined) {
        embed.addFields({ name: "Timeout", value: `${Math.round(decision.timeoutMs / 1000)}s`, inline: true });
      }
      await channel.send({ embeds: [embed] });
    } catch (err) {
      this.opts.log.warn("mod-log embed failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async auditDecision(input: ModerationInput, decision: ModerationDecision): Promise<void> {
    this.opts.log.info("discord moderation action", {
      kind: decision.kind,
      author: input.authorKey,
      rules: decision.ruleCodes,
    });
    if (!this.opts.audit) return;
    try {
      await this.opts.audit.append({
        ts: new Date().toISOString(),
        platform: "discord",
        kind: `moderation.${decision.kind}`,
        actor: "pollux",
        subject: input.authorKey,
        data: {
          ruleCodes: decision.ruleCodes,
          reason: decision.reason,
          llmCategory: decision.llmCategory ?? null,
          timeoutMs: decision.timeoutMs ?? null,
        },
      });
    } catch (err) {
      this.opts.log.warn("discord moderation audit failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -- helpers -----------------------------------------------------------------

  /** Fetch a channel we can send to; throws with a clear message otherwise. */
  private async sendable(channelId: string): Promise<SendableChannels> {
    const channel = await this.client.channels.fetch(channelId);
    if (channel === null || !channel.isSendable()) {
      throw new Error(`channel ${channelId} is missing or not sendable`);
    }
    return channel;
  }

  private linksText(): string {
    const l = this.opts.links;
    return [
      "Official AICOM links (trust nothing else):",
      `Site: ${l.siteUrl}`,
      `GitHub: ${l.githubOrg}`,
      l.telegramChannel !== "" ? `Telegram (Castor's fast lane): ${l.telegramChannel}` : "",
      l.discordInvite !== "" ? `Discord invite: ${l.discordInvite}` : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }
}
