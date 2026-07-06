/**
 * PROVISION / discord — the executor that builds Pollux's heaven on boot.
 *
 * Owns a SHORT-LIVED discord.js client (Guilds intent only): connect, snapshot
 * the guild, ask structure.ts for the minimal creation plan, execute it, pin
 * the welcome manifest, disconnect. The long-lived bot adapter is a different
 * module — this one exists purely so a fresh server self-assembles.
 *
 * Failure philosophy (this function NEVER throws):
 *  - Per-step try/catch: one failed step is logged and skipped; the plan is
 *    idempotent, so the next boot heals whatever was missed.
 *  - Missing bot permissions produce ONE clear warning naming the permissions,
 *    execution of the plan is skipped, and whatever channels already exist are
 *    still discovered and returned so the rest of the service can run.
 *  - dryRun connects and logs the plan but changes nothing.
 *
 * Permission policies (applied only to entities WE create — adopted channels
 * keep whatever the admins configured):
 *  - readonly: @everyone denied SendMessages; the bot allowed (it announces).
 *  - modonly:  @everyone denied ViewChannel; Keeper role + bot allowed.
 *
 * Announcement upgrade: when the guild has the "COMMUNITY" feature,
 * #announcements is created as a GuildAnnouncement channel (followable by
 * other servers — the adapter auto-crossposts), and an existing plain-text
 * #announcements gets a best-effort setType upgrade (warn-and-continue; the
 * change needs Community). Non-community guilds keep plain text.
 */

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type NewsChannel,
  type TextChannel,
  type VoiceChannel,
} from "discord.js";
import type { CrossLinks, Logger } from "../types.js";
import { isDiscordWelcomeMessage } from "./dedup.js";
import {
  hasProvisionFlag,
  releaseProvisionLock,
  tryProvisionLock,
  writeProvisionFlag,
} from "./flags.js";
import {
  ANNOUNCE_CHANNEL,
  DESIRED_STRUCTURE,
  GATES_CATEGORY,
  KEEPER_ROLE,
  MOD_LOG_CHANNEL,
  WATCH_CATEGORY,
  WELCOME_CHANNEL,
  findExistingChannel,
  planProvision,
  type DesiredChannel,
  type ExistingEntity,
  type KeeperPermission,
  type OverwritePolicy,
  type ProvisionStep,
} from "./structure.js";

const PROVISION_REASON = "DIOSCURI provisioning (idempotent boot setup)";
const READY_TIMEOUT_MS = 30_000;

/** structure.ts speaks permission NAMES; only this file knows the bits. */
const KEEPER_PERMISSION_BITS: Record<KeeperPermission, bigint> = {
  ManageMessages: PermissionFlagsBits.ManageMessages,
  ModerateMembers: PermissionFlagsBits.ModerateMembers,
};

/** Channel kinds the provisioner manages (threads/forums/stages are ignored). */
type ProvisionableChannel = CategoryChannel | TextChannel | NewsChannel | VoiceChannel;

/** Announcement channels (followable + crosspostable) need the Community feature. */
function isCommunityGuild(guild: Guild): boolean {
  return guild.features.includes("COMMUNITY");
}

export interface ProvisionDiscordResult {
  announceChannelId: string;
  modLogChannelId: string;
  welcomeChannelId: string;
  /** Human-readable list of what this run created, e.g. "text:welcome". */
  created: string[];
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

/** Wait for the gateway READY (bounded); REST calls work either way. */
function waitForReady(client: Client, log: Logger, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn("discord gateway READY timed out — proceeding with REST only");
      resolve();
    }, timeoutMs);
    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Project live guild state into the pure ExistingEntity shape structure.ts diffs. */
function snapshot(guild: Guild): ExistingEntity[] {
  const out: ExistingEntity[] = [];
  for (const role of guild.roles.cache.values()) {
    out.push({ id: role.id, name: role.name, type: "role" });
  }
  for (const ch of guild.channels.cache.values()) {
    const type =
      ch.type === ChannelType.GuildCategory
        ? ("category" as const)
        : ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement
          ? ("text" as const)
          : ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
            ? ("voice" as const)
            : null;
    if (type === null) continue;
    const parentName = "parent" in ch && ch.parent !== null ? ch.parent.name : undefined;
    out.push({ id: ch.id, name: ch.name, type, ...(parentName !== undefined ? { parentName } : {}) });
  }
  return out;
}

/** Case-insensitive channel lookup in the live cache, preferring the desired category. */
function findLiveChannel(
  guild: Guild,
  name: string,
  parentName?: string,
): ProvisionableChannel | undefined {
  const matches: ProvisionableChannel[] = [];
  for (const ch of guild.channels.cache.values()) {
    if (
      ch.type !== ChannelType.GuildCategory &&
      ch.type !== ChannelType.GuildText &&
      ch.type !== ChannelType.GuildAnnouncement &&
      ch.type !== ChannelType.GuildVoice
    ) {
      continue;
    }
    if (norm(ch.name) !== norm(name)) continue;
    matches.push(ch);
  }
  if (parentName !== undefined) {
    const inPlace = matches.find((ch) => ch.parent !== null && norm(ch.parent.name) === norm(parentName));
    if (inPlace) return inPlace;
  }
  return matches[0];
}

function findLiveCategory(guild: Guild, name: string): CategoryChannel | undefined {
  for (const ch of guild.channels.cache.values()) {
    if (ch.type === ChannelType.GuildCategory && norm(ch.name) === norm(name)) return ch;
  }
  return undefined;
}

function findDesiredChannel(name: string): DesiredChannel | undefined {
  for (const cat of DESIRED_STRUCTURE.categories) {
    const hit = cat.channels.find((c) => norm(c.name) === norm(name));
    if (hit) return hit;
  }
  return undefined;
}

/** Guild-wide permissions the plan needs; returns the human names of missing ones. */
async function missingPermissions(guild: Guild): Promise<string[]> {
  let me = guild.members.me;
  if (!me) {
    try {
      me = await guild.members.fetchMe();
    } catch {
      return []; // cannot tell — attempt the plan; per-step catch reports reality
    }
  }
  const needed: Array<[bigint, string]> = [
    [PermissionFlagsBits.ManageRoles, "Manage Roles"],
    [PermissionFlagsBits.ManageChannels, "Manage Channels"],
  ];
  return needed.filter(([bit]) => !me.permissions.has(bit)).map(([, label]) => label);
}

/**
 * Apply a permission policy via permissionOverwrites.edit (MERGES with any
 * admin-made overwrites — .set would wipe them, which violates "never delete").
 */
async function applyOverwrites(guild: Guild, target: ProvisionableChannel, policy: OverwritePolicy): Promise<void> {
  const everyone = guild.roles.everyone;
  const botId = guild.client.user?.id;
  if (policy === "readonly") {
    await target.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: PROVISION_REASON });
    if (botId) {
      await target.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true }, { reason: PROVISION_REASON });
    }
    return;
  }
  // modonly
  await target.permissionOverwrites.edit(everyone, { ViewChannel: false }, { reason: PROVISION_REASON });
  const keeper = guild.roles.cache.find((r) => norm(r.name) === norm(KEEPER_ROLE));
  if (keeper) {
    await target.permissionOverwrites.edit(keeper, { ViewChannel: true, SendMessages: true }, { reason: PROVISION_REASON });
  }
  if (botId) {
    await target.permissionOverwrites.edit(botId, { ViewChannel: true, SendMessages: true }, { reason: PROVISION_REASON });
  }
}

async function executeStep(guild: Guild, step: ProvisionStep, created: string[], log: Logger): Promise<void> {
  switch (step.op) {
    case "createRole": {
      const desired = DESIRED_STRUCTURE.roles.find((r) => norm(r.name) === norm(step.name));
      await guild.roles.create({
        name: step.name,
        color: desired?.color ?? 0,
        mentionable: desired?.mentionable ?? false,
        permissions: (desired?.permissions ?? []).map((p) => KEEPER_PERMISSION_BITS[p]),
        reason: PROVISION_REASON,
      });
      created.push(`role:${step.name}`);
      log.info("created role", { name: step.name });
      return;
    }
    case "createCategory": {
      await guild.channels.create({
        name: step.name,
        type: ChannelType.GuildCategory,
        reason: PROVISION_REASON,
      });
      created.push(`category:${step.name}`);
      log.info("created category", { name: step.name });
      return;
    }
    case "createText": {
      const parent = step.parentName !== undefined ? findLiveCategory(guild, step.parentName) : undefined;
      const desired = findDesiredChannel(step.name);
      // Community guilds get a followable Announcement channel for #announcements
      // (other servers can Follow it; the adapter auto-crossposts every post).
      const asAnnouncement = norm(step.name) === norm(ANNOUNCE_CHANNEL) && isCommunityGuild(guild);
      await guild.channels.create({
        name: step.name,
        type: asAnnouncement ? ChannelType.GuildAnnouncement : ChannelType.GuildText,
        parent: parent?.id,
        topic: desired?.topic,
        reason: PROVISION_REASON,
      });
      created.push(`text:${step.name}`);
      log.info("created text channel", {
        name: step.name,
        parent: step.parentName,
        announcement: asAnnouncement,
      });
      return;
    }
    case "createVoice": {
      const parent = step.parentName !== undefined ? findLiveCategory(guild, step.parentName) : undefined;
      await guild.channels.create({
        name: step.name,
        type: ChannelType.GuildVoice,
        parent: parent?.id,
        reason: PROVISION_REASON,
      });
      created.push(`voice:${step.name}`);
      log.info("created voice channel", { name: step.name, parent: step.parentName });
      return;
    }
    case "setPermissions": {
      if (!step.overwrites) return;
      const target = findLiveChannel(guild, step.name, step.parentName);
      if (!target) {
        log.warn("setPermissions target not found (creation may have failed)", { name: step.name });
        return;
      }
      await applyOverwrites(guild, target, step.overwrites);
      log.info("applied permission policy", { name: step.name, policy: step.overwrites });
      return;
    }
  }
}

/** Short EN manifest pinned into #welcome — the twins + five laws + links. */
function welcomeManifest(links: CrossLinks): string {
  const lines = [
    "⚔️ **THE HOUSE OF THE TWINS**",
    "",
    "Two brothers keep this place: **Pollux** here on Discord, **Castor** on Telegram.",
    "One shared memory — MNEMOSYNE, synced from the ecosystem's GitHub. Ask either of us anything about AICOM.",
    "",
    "**The five laws of the house:**",
    "1. Be kind — argue with ideas, never with people.",
    "2. English is the default tongue; the twins answer yours when they can.",
    "3. No financial hype — no price talk, no investment advice.",
    "4. No spam, no foreign invites — only the official links below are ours.",
    "5. Keepers moderate, the twins assist. Their word stands.",
    "",
    `🌐 Site: ${links.siteUrl}`,
    `🐙 GitHub: ${links.githubOrg}`,
  ];
  if (links.discordInvite !== "") lines.push(`⚔️ Discord (Pollux): ${links.discordInvite}`);
  if (links.telegramChannel !== "") lines.push(`🐎 Castor's Telegram channel: ${links.telegramChannel}`);
  if (links.telegramBot !== "") lines.push(`🤖 Talk to Castor: ${links.telegramBot}`);
  return lines.join("\n");
}

const WELCOME_FLAG = "discord-welcome";
const WELCOME_HISTORY_LIMIT = 40;

function findExistingWelcome(
  messages: Iterable<{ id: string; author: { id: string }; content: string; pinned?: boolean }>,
  botId: string,
): { id: string; pinned?: boolean } | undefined {
  for (const m of messages) {
    if (isDiscordWelcomeMessage(m.content, m.author.id, botId)) return m;
  }
  return undefined;
}

/**
 * Post + pin the manifest into #welcome — idempotent across reboots, unpinned
 * leftovers, and parallel boots. Checks: flag file → pinned → recent history.
 */
async function ensureWelcomeManifest(
  guild: Guild,
  welcomeChannelId: string,
  links: CrossLinks,
  dataDir: string,
  log: Logger,
): Promise<void> {
  if (welcomeChannelId === "") return;
  const botId = guild.client.user?.id;
  if (botId === undefined) return;

  if (hasProvisionFlag(dataDir, WELCOME_FLAG)) {
    log.debug("welcome manifest flag set — skipping");
    return;
  }

  const locked = tryProvisionLock(dataDir, WELCOME_FLAG);
  if (!locked) {
    log.debug("another instance is posting the welcome manifest — skipping");
    return;
  }

  try {
    const ch = guild.channels.cache.get(welcomeChannelId);
    if (!ch || ch.type !== ChannelType.GuildText) return;

    const pinned = await ch.messages.fetchPins();
    const pinnedExisting = findExistingWelcome(
      pinned.items.map((p) => p.message),
      botId,
    );
    if (pinnedExisting !== undefined) {
      writeProvisionFlag(dataDir, WELCOME_FLAG, `msg=${pinnedExisting.id} pinned`);
      log.debug("welcome manifest already pinned");
      return;
    }

    const recent = await ch.messages.fetch({ limit: WELCOME_HISTORY_LIMIT });
    const historyExisting = findExistingWelcome(recent.values(), botId);
    if (historyExisting !== undefined) {
      writeProvisionFlag(dataDir, WELCOME_FLAG, `msg=${historyExisting.id} history`);
      log.info("welcome manifest already in channel — not reposting", { messageId: historyExisting.id });
      if (!historyExisting.pinned) {
        try {
          const msg = await ch.messages.fetch(historyExisting.id);
          await msg.pin();
          log.info("re-pinned existing welcome manifest", { messageId: historyExisting.id });
        } catch (err) {
          log.warn("could not re-pin existing welcome manifest", { error: String(err) });
        }
      }
      return;
    }

    const msg = await ch.send(welcomeManifest(links));
    writeProvisionFlag(dataDir, WELCOME_FLAG, `msg=${msg.id}`);
    try {
      await msg.pin();
      log.info("welcome manifest posted and pinned", { channelId: welcomeChannelId, messageId: msg.id });
    } catch (err) {
      log.warn("welcome manifest posted but pin failed (needs Manage Messages in #welcome)", {
        messageId: msg.id,
        error: String(err),
      });
    }
  } catch (err) {
    log.warn("could not post/pin welcome manifest (needs Send Messages + Manage Messages in #welcome)", {
      error: String(err),
    });
  } finally {
    releaseProvisionLock(dataDir, WELCOME_FLAG);
  }
}

/**
 * Best-effort upgrade of an EXISTING plain-text #announcements to a
 * GuildAnnouncement channel on Community guilds (adopted channels created
 * before the guild enabled Community, or by hand). Warn-and-continue: the
 * setType call needs the Community feature and Manage Channels — a refusal
 * must never break provisioning. Non-community guilds are left untouched.
 */
async function upgradeAnnounceChannel(guild: Guild, log: Logger): Promise<void> {
  try {
    if (!isCommunityGuild(guild)) return;
    const ch = findLiveChannel(guild, ANNOUNCE_CHANNEL, GATES_CATEGORY);
    if (!ch || ch.type !== ChannelType.GuildText) return; // missing, or already an Announcement channel
    await ch.setType(ChannelType.GuildAnnouncement, PROVISION_REASON);
    log.info("upgraded #announcements to an Announcement channel (followable)", { id: ch.id });
  } catch (err) {
    log.warn("could not upgrade #announcements to Announcement type (needs Community + Manage Channels)", {
      error: String(err),
    });
  }
}

/** Resolve the three well-known channel ids from a snapshot (empty string = not found). */
function resolveWellKnown(existing: readonly ExistingEntity[]): Omit<ProvisionDiscordResult, "created"> {
  const welcome = findExistingChannel(existing, WELCOME_CHANNEL, "text", GATES_CATEGORY);
  const announce = findExistingChannel(existing, ANNOUNCE_CHANNEL, "text", GATES_CATEGORY);
  const modLog = findExistingChannel(existing, MOD_LOG_CHANNEL, "text", WATCH_CATEGORY);
  return {
    announceChannelId: announce?.id ?? "",
    modLogChannelId: modLog?.id ?? "",
    welcomeChannelId: welcome?.id ?? "",
  };
}

export async function provisionDiscord(opts: {
  token: string;
  guildId: string;
  links: CrossLinks;
  log: Logger;
  dataDir?: string;
  dryRun?: boolean;
}): Promise<ProvisionDiscordResult> {
  const log = opts.log;
  const created: string[] = [];
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  try {
    await client.login(opts.token);
    await waitForReady(client, log);

    const guild = await client.guilds.fetch(opts.guildId);
    await guild.roles.fetch();
    await guild.channels.fetch();

    const plan = planProvision(snapshot(guild));

    if (plan.length === 0) {
      log.info("discord structure already provisioned — nothing to create");
    } else if (opts.dryRun === true) {
      log.info("dry-run: computed provisioning plan, executing nothing", {
        steps: plan.map((s) => `${s.op}:${s.name}`),
      });
    } else {
      const missing = await missingPermissions(guild);
      if (missing.length > 0) {
        log.warn(
          `cannot build server structure — the bot is missing permissions: ${missing.join(", ")}. ` +
            "Grant them (or re-invite with Manage Roles + Manage Channels) and restart; " +
            "provisioning is idempotent and will pick up where it left off.",
          { missing, plannedSteps: plan.length },
        );
      } else {
        for (const step of plan) {
          try {
            await executeStep(guild, step, created, log);
          } catch (err) {
            log.warn("provision step failed — continuing (a rerun heals the rest)", {
              op: step.op,
              name: step.name,
              error: String(err),
            });
          }
        }
      }
    }

    // Adopted #announcements may predate Community — try the followable upgrade.
    if (opts.dryRun !== true) {
      await upgradeAnnounceChannel(guild, log);
    }

    // Re-snapshot: creations above are in the cache now.
    const ids = resolveWellKnown(snapshot(guild));
    if (opts.dryRun !== true) {
      await ensureWelcomeManifest(guild, ids.welcomeChannelId, opts.links, opts.dataDir ?? "", log);
    }
    return { ...ids, created };
  } catch (err) {
    log.error("discord provisioning failed (service continues without it)", { error: String(err) });
    return { announceChannelId: "", modLogChannelId: "", welcomeChannelId: "", created };
  } finally {
    try {
      await client.destroy();
    } catch {
      // already closed — nothing to do
    }
  }
}
