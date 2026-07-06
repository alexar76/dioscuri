/**
 * Seed Discord channel guides — idempotent ecosystem primers with optional
 * demo screenshots. Runs on boot after structure + welcome manifest.
 */

import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type TextChannel,
} from "discord.js";
import type { CrossLinks, Logger } from "../types.js";
import {
  CHANNEL_GUIDES,
  DISCORD_GUIDE_MARKER,
  guideDemoTargets,
  guideFlagKey,
  guideScreenshotFlagKey,
  renderChannelGuide,
  type ChannelGuideDef,
} from "./guides.js";
import {
  hasProvisionFlag,
  readProvisionFlag,
  releaseProvisionLock,
  tryProvisionLock,
  writeProvisionFlag,
} from "./flags.js";

const READY_TIMEOUT_MS = 30_000;

function norm(name: string): string {
  return name.trim().toLowerCase();
}

function waitForReady(client: Client, log: Logger): Promise<void> {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn("discord gateway READY timed out — proceeding with REST only");
      resolve();
    }, READY_TIMEOUT_MS);
    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function resolveChannelId(guild: Guild, def: ChannelGuideDef): string | undefined {
  const matches: { id: string; parent?: string }[] = [];
  for (const ch of guild.channels.cache.values()) {
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) continue;
    if (norm(ch.name) !== norm(def.channel)) continue;
    const parent = "parent" in ch && ch.parent !== null ? ch.parent.name : undefined;
    matches.push({ id: ch.id, parent });
  }
  const inCategory = matches.find((m) => m.parent !== undefined && norm(m.parent) === norm(def.category));
  if (inCategory !== undefined) return inCategory.id;
  return matches[0]?.id;
}

function isOurGuide(content: string, channel: string, authorId: string, botId: string): boolean {
  return authorId === botId && content.includes(DISCORD_GUIDE_MARKER) && content.includes(`#${channel}`);
}

function parseMsgId(flagBody: string): string | undefined {
  const m = flagBody.match(/msg=(\d+)/);
  return m?.[1];
}

async function deletePreviousGuide(ch: TextChannel, dataDir: string, textFlag: string, log: Logger): Promise<void> {
  const msgId = parseMsgId(readProvisionFlag(dataDir, textFlag));
  if (msgId === undefined) return;
  try {
    await ch.messages.delete(msgId);
    log.info("deleted previous channel guide for QC refresh", { messageId: msgId });
  } catch (err) {
    log.warn("could not delete previous channel guide", { messageId: msgId, error: String(err) });
  }
}

async function captureGuideAttachments(
  targets: readonly { repo: string; url: string }[],
  captureScreenshot: ((url: string) => Promise<Buffer>) | undefined,
  log: Logger,
): Promise<AttachmentBuilder[]> {
  if (captureScreenshot === undefined) return [];
  const attachments: AttachmentBuilder[] = [];
  for (const t of targets) {
    try {
      const png = await captureScreenshot(t.url);
      attachments.push(new AttachmentBuilder(png, { name: `${t.repo}-demo.png` }));
      log.info("discord guide screenshot accepted", { repo: t.repo, url: t.url, bytes: png.length });
    } catch (err) {
      log.warn("discord guide screenshot rejected", { repo: t.repo, url: t.url, error: String(err) });
    }
  }
  return attachments;
}

async function ensureChannelGuide(
  guild: Guild,
  channelId: string,
  def: ChannelGuideDef,
  text: string,
  attachments: AttachmentBuilder[],
  dataDir: string,
  log: Logger,
): Promise<boolean> {
  const botId = guild.client.user?.id;
  if (botId === undefined) return false;

  const textFlag = guideFlagKey(def.channel);
  const shotsFlag = guideScreenshotFlagKey(def.channel);

  if (hasProvisionFlag(dataDir, shotsFlag)) {
    log.debug("channel guide QC complete — skipping", { channel: def.channel });
    return false;
  }

  if (!tryProvisionLock(dataDir, textFlag)) {
    log.debug("another instance seeding channel guide — skipping", { channel: def.channel });
    return false;
  }

  try {
    const ch = guild.channels.cache.get(channelId);
    if (ch === undefined || (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement)) {
      return false;
    }
    const textCh = ch as TextChannel;

    if (hasProvisionFlag(dataDir, textFlag)) {
      await deletePreviousGuide(textCh, dataDir, textFlag, log);
    } else {
      const pinned = await textCh.messages.fetchPins();
      for (const pin of pinned.items) {
        if (isOurGuide(pin.message.content, def.channel, botId, botId)) {
          try {
            await pin.message.delete();
            log.info("deleted pinned channel guide for QC refresh", { messageId: pin.message.id });
          } catch (err) {
            log.warn("could not delete pinned channel guide", { error: String(err) });
          }
          break;
        }
      }
    }

    const msg = await textCh.send({
      content: text,
      files: attachments,
      allowedMentions: { parse: [] },
    });
    writeProvisionFlag(dataDir, textFlag, `msg=${msg.id}`);
    writeProvisionFlag(dataDir, shotsFlag, `photos=${attachments.length}`);

    if (def.pin === true) {
      try {
        await msg.pin();
      } catch (err) {
        log.warn("channel guide posted but pin failed", { channel: def.channel, error: String(err) });
      }
    }

    log.info("channel guide seeded", {
      channel: def.channel,
      messageId: msg.id,
      screenshots: attachments.length,
    });
    return true;
  } catch (err) {
    log.warn("could not seed channel guide", { channel: def.channel, error: String(err) });
    return false;
  } finally {
    releaseProvisionLock(dataDir, textFlag);
  }
}

export async function seedDiscordGuides(opts: {
  token: string;
  guildId: string;
  links: CrossLinks;
  githubOwner: string;
  demoUrls: Readonly<Record<string, string>>;
  dataDir: string;
  log: Logger;
  dryRun?: boolean;
  captureScreenshot?: (url: string) => Promise<Buffer>;
}): Promise<{ seeded: string[] }> {
  const log = opts.log;
  const seeded: string[] = [];
  if (opts.dryRun === true) {
    log.info("dry-run: would seed channel guides", { channels: CHANNEL_GUIDES.map((g) => g.channel) });
    return { seeded };
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(opts.token);
    await waitForReady(client, log);
    const guild = await client.guilds.fetch(opts.guildId);
    await guild.channels.fetch();

    const ctx = {
      links: opts.links,
      githubOwner: opts.githubOwner,
      demoUrls: opts.demoUrls,
    };

    for (const def of CHANNEL_GUIDES) {
      const channelId = resolveChannelId(guild, def);
      if (channelId === undefined) {
        log.warn("channel guide target not found", { channel: def.channel, category: def.category });
        continue;
      }

      const text = renderChannelGuide(def, ctx);
      const targets = guideDemoTargets(def, opts.demoUrls);
      const attachments = await captureGuideAttachments(targets, opts.captureScreenshot, log);

      const ok = await ensureChannelGuide(guild, channelId, def, text, attachments, opts.dataDir, log);
      if (ok) seeded.push(def.channel);
    }

    return { seeded };
  } catch (err) {
    log.error("channel guide seeding failed (service continues)", { error: String(err) });
    return { seeded };
  } finally {
    try {
      await client.destroy();
    } catch {
      /* closed */
    }
  }
}
