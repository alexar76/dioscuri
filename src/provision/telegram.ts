/**
 * PROVISION / telegram — Castor sets his own table on boot.
 *
 * Uses a standalone grammY Api instance (no long-lived Bot, no polling): this
 * runs once at startup, before/independent of the chat adapter.
 *
 * What it does:
 *  1. setMyCommands — the /start /ask /links /help menu (English descriptions).
 *  2. English ecosystem guide — pinned primer with repos, demos, manuals, and
 *     cross-links to Pollux on Discord (plus optional demo screenshots).
 *
 * Failure philosophy: every operation is individually guarded; problems are
 * logged as warnings and the function NEVER throws — a bot that cannot pin is
 * still a perfectly good bot.
 */

import { Api } from "grammy";
import type { CrossLinks, Logger } from "../types.js";
import { seedTelegramEcosystem } from "./seed-telegram-guide.js";

export async function setupTelegram(opts: {
  token: string;
  chatId: string;
  links: CrossLinks;
  log: Logger;
  dataDir?: string;
  githubOwner: string;
  demoUrls?: Readonly<Record<string, string>>;
  captureScreenshot?: (url: string) => Promise<Buffer>;
}): Promise<void> {
  const { log } = opts;
  const api = new Api(opts.token);

  try {
    await api.setMyCommands([
      { command: "start", description: "Meet Castor, the twin on the ground" },
      { command: "ask", description: "Ask anything about the AICOM ecosystem" },
      { command: "links", description: "Official links — site, GitHub, Discord" },
      { command: "help", description: "What Castor can do and how to ask" },
    ]);
    log.info("telegram command menu set");
  } catch (err) {
    log.warn("could not set telegram command menu", { error: String(err) });
  }

  await seedTelegramEcosystem({
    token: opts.token,
    chatId: opts.chatId,
    links: opts.links,
    githubOwner: opts.githubOwner,
    demoUrls: opts.demoUrls ?? {},
    dataDir: opts.dataDir ?? "",
    log: log.child("ecosystem"),
    captureScreenshot: opts.captureScreenshot,
  });
}
