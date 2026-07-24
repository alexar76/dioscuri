/**
 * PROVISION / opening — the one-time opening feast.
 *
 * The very first time the twins come online with their homes provisioned, each
 * posts an opening manifest in his own voice: who he is, what he answers, and
 * where his brother lives. A flag file (<dataDir>/opened.flag) makes this a
 * once-in-a-lifetime event — every later boot is a silent no-op.
 *
 * Rules:
 *  - Adapters arrive via the ChannelAdapter interface (DI) — no platform SDKs.
 *  - The flag is written ONLY after at least one platform actually posted, so
 *    a boot where both announcements fail retries on the next boot.
 *  - Failures are logged and swallowed; this function NEVER throws.
 *  - Both manifests are ENGLISH (community default), in-persona, written here
 *    inline — the LLM is not consulted for this ceremonial text.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditLog, ChannelAdapter, CrossLinks, Logger } from "../types.js";

/** Castor's opening — grounded, fast, warm. Posted to Telegram. */
export function castorOpening(links: CrossLinks): string {
  return [
    "🐎 The gates are open — and naturally I got here first. I'm CASTOR, the mortal twin.",
    "",
    "This channel is my ground. Ask me anything about the AICOM ecosystem — the AI Factory pipeline, " +
      "the oracle family, the AIMarket agent economy, the ARGUS agent — and I answer fast, " +
      "from a memory that syncs itself straight from our GitHub.",
    "",
    "My immortal brother POLLUX keeps the deep sky: the Discord server, with its forge channels, " +
      `THE GALLERY (#gallery forum), a voice hall called Olympus. Long builds and long talks live there: ${links.discordInvite}`,
    "",
    "Two heavens, one memory. Saddle up.",
  ].join("\n");
}

/** Pollux's opening — immortal, dry, precise. Posted to Discord. */
export function polluxOpening(links: CrossLinks): string {
  return [
    "🥊 Three thousand years, and doors still need opening by hand. Very well. " +
      "I am POLLUX, the immortal twin, and this hall is now open.",
    "",
    "Here is the deep heaven of the AICOM ecosystem. Ask in #help, argue in #ideas, " +
      "show your work in **#gallery**, follow the machinery in the forge channels. " +
      "I answer from MNEMOSYNE — the memory my brother and I share, synced from the ecosystem's GitHub — " +
      "and I do not invent what I do not know.",
    "",
    "My mortal brother CASTOR rides Telegram; news reaches the ground there first, " +
      `because he hurries: ${links.telegramChannel}`,
    "",
    "Two heavens, one memory. Mind the Keepers, and be kind.",
  ].join("\n");
}

export async function postOpeningFeast(opts: {
  telegram?: ChannelAdapter;
  discord?: ChannelAdapter;
  links: CrossLinks;
  dataDir: string;
  log: Logger;
  audit?: AuditLog;
  /** Injectable clock (tests); defaults to the real one. */
  now?: () => Date;
}): Promise<void> {
  const { log, links } = opts;
  const flagPath = join(opts.dataDir, "opened.flag");

  if (existsSync(flagPath)) {
    log.debug("opening feast already held — skipping");
    return;
  }

  let telegramPosted = false;
  let discordPosted = false;

  if (opts.telegram) {
    try {
      await opts.telegram.announce(castorOpening(links));
      telegramPosted = true;
      log.info("Castor posted his opening on telegram");
    } catch (err) {
      log.warn("telegram opening announcement failed", { error: String(err) });
    }
  }
  if (opts.discord) {
    try {
      await opts.discord.announce(polluxOpening(links));
      discordPosted = true;
      log.info("Pollux posted his opening on discord");
    } catch (err) {
      log.warn("discord opening announcement failed", { error: String(err) });
    }
  }

  if (!telegramPosted && !discordPosted) {
    // Nothing landed — leave the flag unwritten so the next boot retries.
    log.warn("opening feast not held (no adapter posted) — will retry next boot");
    return;
  }

  const ts = (opts.now?.() ?? new Date()).toISOString();
  try {
    await mkdir(opts.dataDir, { recursive: true });
    await writeFile(flagPath, ts + "\n", "utf8");
  } catch (err) {
    log.warn("could not write opening flag — feast may repeat next boot", { error: String(err) });
  }

  try {
    await opts.audit?.append({
      ts,
      platform: "system",
      kind: "system.opening",
      actor: "dioscuri",
      subject: "opening-feast",
      data: { telegram: telegramPosted, discord: discordPosted },
    });
  } catch (err) {
    log.warn("could not audit the opening feast", { error: String(err) });
  }
}
