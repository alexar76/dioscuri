/**
 * Seed Castor's Telegram channel — English ecosystem primer + demo screenshots.
 * Text and screenshot album use separate flags so QC fixes can refresh photos only.
 */

import { Api, InputFile } from "grammy";
import type { CrossLinks, Logger } from "../types.js";
import { isTelegramEcosystemGuide } from "./dedup.js";
import {
  hasProvisionFlag,
  releaseProvisionLock,
  tryProvisionLock,
  writeProvisionFlag,
} from "./flags.js";
import {
  renderTelegramEcosystemGuide,
  TELEGRAM_ECOSYSTEM_MARKER,
  telegramDemoTargets,
  telegramGuideFlagKey,
} from "./guides.js";

const TG_MAX = 4000;
const TEXT_FLAG = "telegram-ecosystem";
const SCREENSHOTS_FLAG = "telegram-screenshots-v2";

function chunkTelegram(text: string, max = TG_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const slice = rest.slice(0, max);
    const nl = slice.lastIndexOf("\n");
    const cut = nl > max / 2 ? nl : max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

async function postValidatedAlbum(
  api: Api,
  chatId: string,
  targets: readonly { repo: string; url: string }[],
  captureScreenshot: (url: string) => Promise<Buffer>,
  log: Logger,
): Promise<number> {
  const accepted: { repo: string; url: string }[] = [];
  const media: { type: "photo"; media: InputFile; caption?: string }[] = [];
  for (const t of targets) {
    try {
      const png = await captureScreenshot(t.url);
      accepted.push(t);
      media.push({
        type: "photo",
        media: new InputFile(png, `${t.repo}-demo.png`),
      });
      log.info("telegram guide screenshot accepted", { repo: t.repo, url: t.url, bytes: png.length });
    } catch (err) {
      log.warn("telegram guide screenshot rejected", { repo: t.repo, url: t.url, error: String(err) });
    }
  }
  if (media.length === 0) {
    log.warn("no screenshots passed QC — skipping album");
    return 0;
  }
  media[0]!.caption =
    `${TELEGRAM_ECOSYSTEM_MARKER}\n` +
    `Validated live demos (${media.length}): ${accepted.map((a) => a.repo).join(", ")}\n` +
    "Full links in the pinned guide above.";
  await api.sendMediaGroup(chatId, media);
  return media.length;
}

export async function seedTelegramEcosystem(opts: {
  token: string;
  chatId: string;
  links: CrossLinks;
  githubOwner: string;
  demoUrls: Readonly<Record<string, string>>;
  dataDir: string;
  log: Logger;
  captureScreenshot?: (url: string) => Promise<Buffer>;
}): Promise<boolean> {
  const { log, links } = opts;
  if (opts.chatId === "") {
    log.warn("no telegram chat id — skipping ecosystem guide");
    return false;
  }

  const dataDir = opts.dataDir;
  const textDone = hasProvisionFlag(dataDir, TEXT_FLAG);
  const shotsDone = hasProvisionFlag(dataDir, SCREENSHOTS_FLAG);
  if (textDone && (shotsDone || opts.captureScreenshot === undefined)) {
    log.debug("telegram ecosystem guide complete — skipping");
    return false;
  }

  const lockKey = telegramGuideFlagKey();
  if (!tryProvisionLock(dataDir, lockKey)) {
    log.debug("another instance seeding telegram guide — skipping");
    return false;
  }

  const api = new Api(opts.token);
  let didWork = false;
  try {
    const me = await api.getMe();
    const member = await api.getChatMember(opts.chatId, me.id);
    const canPin =
      member.status === "creator" ||
      (member.status === "administrator" &&
        (member.can_pin_messages === true || member.can_edit_messages === true));
    if (!canPin) {
      log.warn("bot lacks pin rights — skipping telegram ecosystem guide", { status: member.status });
      return false;
    }

    if (!textDone) {
      const chat = await api.getChat(opts.chatId);
      if (isTelegramEcosystemGuide(chat.pinned_message, me.id, opts.chatId)) {
        writeProvisionFlag(dataDir, TEXT_FLAG, `msg=${chat.pinned_message?.message_id ?? "?"} pinned`);
      } else {
        const ctx = { links, githubOwner: opts.githubOwner, demoUrls: opts.demoUrls };
        const chunks = chunkTelegram(renderTelegramEcosystemGuide(ctx));
        let firstId: number | undefined;
        for (const chunk of chunks) {
          const sent = await api.sendMessage(opts.chatId, chunk, {
            link_preview_options: { is_disabled: true },
          });
          if (firstId === undefined) firstId = sent.message_id;
        }
        if (firstId !== undefined) {
          writeProvisionFlag(dataDir, TEXT_FLAG, `msg=${firstId}`);
          try {
            await api.pinChatMessage(opts.chatId, firstId, { disable_notification: true });
            log.info("telegram ecosystem guide posted and pinned", { messageId: firstId });
          } catch (err) {
            log.warn("telegram guide posted but pin failed", { messageId: firstId, error: String(err) });
          }
          didWork = true;
        }
      }
    }

    if (!shotsDone && opts.captureScreenshot !== undefined) {
      const targets = telegramDemoTargets(opts.demoUrls);
      const count = await postValidatedAlbum(api, opts.chatId, targets, opts.captureScreenshot, log);
      if (count > 0) {
        writeProvisionFlag(dataDir, SCREENSHOTS_FLAG, `photos=${count}`);
        log.info("telegram validated screenshot album posted", { photos: count });
        didWork = true;
      }
    }

    return didWork;
  } catch (err) {
    log.warn("telegram ecosystem guide seed failed", { error: String(err) });
    return false;
  } finally {
    releaseProvisionLock(dataDir, lockKey);
  }
}
