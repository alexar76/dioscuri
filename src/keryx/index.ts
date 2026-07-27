/**
 * KERYX — the herald. Outbound syndication beyond the twins' own channels.
 *
 * SAFETY CHARTER (non-negotiable, mirrors src/types.ts):
 *  - POST-ONLY: every sink publishes our own guarded text to OUR OWN account.
 *    No replies, likes, follows, DMs, mentions of other users, or reading
 *    other users' content — that is the platform-manipulation ban vector on
 *    every network.
 *  - Low volume by design: release announcements + a monthly digest article.
 *  - Fail-soft: a broken sink logs a warning and is skipped; it NEVER
 *    propagates into the twins' main loop.
 *
 * This file holds the fan-out (Keryx.announceRelease) and the arming logic
 * (armSinks: a sink exists only when its secrets are present; X additionally
 * demands the explicit X_SYNDICATION=1 opt-in because posting there is
 * pay-per-use). The herald speaks in ONE neutral voice — announcements are
 * not persona-voiced, they are the town crier's bell.
 */

import { prepareUntrusted } from "../aegis/sanitize.js";
import { releaseBlurb } from "../shared/index.js";
import type { DioscuriConfig } from "../config.js";
import type { AuditLog, CrossLinks, Logger, ReleaseEvent, SyndicationSink } from "../types.js";
import { createBlueskySink } from "./bluesky.js";
import { createMastodonSink } from "./mastodon.js";
import { createXSink } from "./x.js";

/** The whole herald message is sanitised to this many chars before fan-out. */
const ANNOUNCE_MAX_CHARS = 480;
/** Keep the summary sentence short so URL + community links always fit. */
const SUMMARY_MAX_CHARS = 120;

type SyndicationSecrets = DioscuriConfig["syndication"];

export class Keryx {
  private readonly sinks: SyndicationSink[];
  private readonly links: CrossLinks;
  private readonly log: Logger;
  private readonly audit: AuditLog | undefined;

  constructor(opts: { sinks: SyndicationSink[]; links: CrossLinks; log: Logger; audit?: AuditLog }) {
    this.sinks = opts.sinks;
    this.links = opts.links;
    this.log = opts.log;
    this.audit = opts.audit;
  }

  /** One short neutral-herald text, composed once, delivered to every sink. */
  composeRelease(ev: ReleaseEvent): string {
    const summary = releaseBlurb(ev.summary, SUMMARY_MAX_CHARS);
    const head =
      summary !== ""
        ? `⚒ ${ev.repo} ${ev.tag} shipped — ${summary}`
        : `⚒ ${ev.repo} ${ev.tag} shipped`;
    const raw = [
      head,
      ev.url,
      `Community: ${this.links.discordInvite} | ${this.links.telegramChannel}`,
    ].join("\n");
    // Same sanitation gate as everything else that leaves the process, plus
    // mass-mention neutralisation (a Discord-side courtesy that costs nothing
    // on other networks).
    return prepareUntrusted(raw, ANNOUNCE_MAX_CHARS)
      .replaceAll("@everyone", "everyone")
      .replaceAll("@here", "here");
  }

  /**
   * Fan one release announcement out to every armed sink. Sequential and
   * fail-soft: a sink that throws is logged (by name) and skipped — the next
   * sink still runs and the caller NEVER sees an error.
   */
  async announceRelease(ev: ReleaseEvent): Promise<void> {
    if (this.sinks.length === 0) return;
    const text = this.composeRelease(ev);
    for (const sink of this.sinks) {
      try {
        await sink.post(text);
        this.log.info("keryx post delivered", { sink: sink.name, repo: ev.repo, tag: ev.tag });
        try {
          await this.audit?.append({
            ts: new Date().toISOString(),
            kind: "keryx.post",
            platform: "system",
            actor: "keryx",
            subject: sink.name,
            data: { repo: ev.repo, tag: ev.tag },
          });
        } catch (err) {
          this.log.debug("keryx audit append failed", { error: String(err) });
        }
      } catch (err) {
        this.log.warn("keryx sink failed — skipped", {
          sink: sink.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * Build the sink list from present secrets:
 *  - bluesky: identifier + appPassword;
 *  - mastodon: baseUrl + accessToken;
 *  - x: enabled === true (the X_SYNDICATION=1 opt-in) AND all four secrets.
 * One info line per armed sink; absent secrets arm nothing, silently.
 */
export function armSinks(cfg: SyndicationSecrets, log: Logger): SyndicationSink[] {
  const sinks: SyndicationSink[] = [];
  if (cfg.bluesky.identifier !== "" && cfg.bluesky.appPassword !== "") {
    sinks.push(
      createBlueskySink({
        identifier: cfg.bluesky.identifier,
        appPassword: cfg.bluesky.appPassword,
        log,
      }),
    );
    log.info("keryx sink armed", { sink: "bluesky" });
  }
  if (cfg.mastodon.baseUrl !== "" && cfg.mastodon.accessToken !== "") {
    sinks.push(
      createMastodonSink({
        baseUrl: cfg.mastodon.baseUrl,
        accessToken: cfg.mastodon.accessToken,
        log,
      }),
    );
    log.info("keryx sink armed", { sink: "mastodon" });
  }
  if (
    cfg.x.enabled === true &&
    cfg.x.apiKey !== "" &&
    cfg.x.apiSecret !== "" &&
    cfg.x.accessToken !== "" &&
    cfg.x.accessSecret !== ""
  ) {
    sinks.push(
      createXSink({
        apiKey: cfg.x.apiKey,
        apiSecret: cfg.x.apiSecret,
        accessToken: cfg.x.accessToken,
        accessSecret: cfg.x.accessSecret,
        log,
      }),
    );
    log.info("keryx sink armed", { sink: "x" });
  }
  return sinks;
}
