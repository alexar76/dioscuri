/** Markers embedded in one-time setup messages — used to detect duplicates. */

import { TELEGRAM_ECOSYSTEM_MARKER } from "./guides.js";

export const DISCORD_WELCOME_MARKER = "THE HOUSE OF THE TWINS";
export const TELEGRAM_LINKS_MARKER = "THE TWINS' OFFICIAL LINKS";
export const TELEGRAM_LINKS_SUBMARKER = "Talk to Castor";

export function isDiscordWelcomeMessage(content: string, authorId: string, botId: string): boolean {
  return authorId === botId && content.includes(DISCORD_WELCOME_MARKER);
}

export function isTelegramEcosystemGuide(
  msg: { from?: { id: number }; sender_chat?: { id: number }; text?: string } | undefined,
  botId: number,
  chatId: string,
): boolean {
  if (msg === undefined) return false;
  const text = msg.text ?? "";
  if (!text.includes(TELEGRAM_ECOSYSTEM_MARKER)) return false;
  if (msg.from?.id === botId) return true;
  return String(msg.sender_chat?.id) === chatId;
}

export function isTelegramLinksMessage(
  msg: { from?: { id: number }; sender_chat?: { id: number }; text?: string } | undefined,
  botId: number,
  chatId: string,
): boolean {
  if (msg === undefined) return false;
  const text = msg.text ?? "";
  if (!text.includes(TELEGRAM_LINKS_MARKER)) return false;
  if (!text.includes(TELEGRAM_LINKS_SUBMARKER)) return false;
  if (msg.from?.id === botId) return true;
  return String(msg.sender_chat?.id) === chatId;
}
