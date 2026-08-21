#!/usr/bin/env node
/**
 * DIOSCURI — composition root.
 *
 * One process, two heavens. Boot order matters:
 *   config → audit/aegis/kb/llm (core graph) → discord provisioning (own
 *   short-lived client, BEFORE the adapter so discovered channel ids feed its
 *   constructor) → adapters → telegram setup → opening feast (first run only)
 *   → engines (cross-promo, content calendar, KB sync) → health server.
 *
 * Everything is wired here and only here: modules never import each other's
 * concrete classes — they meet through the interfaces in types.ts.
 * DRY-RUN (DIOSCURI_DRY_RUN=1) boots the core graph + KB + health with zero
 * platform tokens, which is what CI and first-time users get for free.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type DioscuriConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { ChannelAdapter, ContentKind, CrossLinks, LlmClient, ReleaseEvent } from "./types.js";

import { FileAuditLog } from "./audit.js";
import { createHealthServer } from "./health.js";
import { computeTheorosStatus } from "./theoros-status.js";
import { createSocialStatsCache } from "./social/stats.js";
import {
  enqueueReleaseVideo,
  isHeliosReleaseShortsEnabled,
  isHeliosSyndicationEnabled,
} from "./helios/enqueue.js";
import { Aegis } from "./aegis/index.js";
import { TokenBucket } from "./aegis/rate-limit.js";
import { Moderation } from "./aegis/moderation.js";
import { MnemosyneKB } from "./mnemosyne/index.js";
import { createLlmClient } from "./core/llm.js";
import { FailoverLlmClient } from "./core/failover.js";
import { DioscuriBrain } from "./core/brain.js";
import { BulletinPublisher, type BulletinSink } from "./bulletin/index.js";
import { personaFor } from "./personas/index.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { CrossPromo } from "./crosspromo/scheduler.js";
import { Theoxenia } from "./theoxenia/engine.js";
import { createImageProvider } from "./images/providers.js";
import { createScreenshotProvider } from "./images/screenshots.js";
import { armSinks, Keryx } from "./keryx/index.js";
import { createDevtoDigest } from "./keryx/devto.js";
import { LiveStateSync } from "./showcase/livestate.js";
import { SignalHeroPublisher, type HeroSink } from "./signal-hunt/heroes.js";
import { provisionDiscord } from "./provision/discord.js";
import { seedDiscordGuides } from "./provision/seed-guides.js";
import { setupTelegram } from "./provision/telegram.js";
import { postOpeningFeast } from "./provision/opening.js";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function buildLlm(cfg: DioscuriConfig, log: ReturnType<typeof createLogger>): LlmClient {
  const budget = { maxCallsPerDay: cfg.tuning.maxLlmCallsPerDay };
  const primary = createLlmClient(cfg.llm, log.child("llm"), budget);
  const fallback = cfg.llmFallback
    ? createLlmClient(cfg.llmFallback, log.child("llm.fallback"), budget)
    : undefined;
  // Always wrap: even single-provider mode benefits from the breaker's
  // fail-fast behaviour while an upstream outage lasts.
  return new FailoverLlmClient({ primary, fallback, log: log.child("failover") });
}

/** Release fan-out — text-only persona announcements on both platforms. */
function wireReleaseAnnouncements(
  kb: MnemosyneKB,
  adapters: { telegram?: ChannelAdapter; discord?: ChannelAdapter },
  links: CrossLinks,
  log: ReturnType<typeof createLogger>,
): void {
  kb.onRelease((ev: ReleaseEvent) => {
    void (async () => {
      for (const adapter of [adapters.telegram, adapters.discord]) {
        if (!adapter) continue;
        const persona = personaFor(adapter.platform === "telegram" ? "castor" : "pollux");
        const text = persona.releaseAnnouncement(links, ev);
        try {
          await adapter.announce(text);
        } catch (err) {
          log.warn("release announcement failed", {
            platform: adapter.platform,
            repo: ev.repo,
            err: String(err),
          });
        }
      }
    })();
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger("dioscuri");
  const version = readVersion();
  const links = cfg.tuning.links;
  log.info("waking the twins", { version, dryRun: cfg.dryRun });

  // --- Core graph (always on, even in dry-run) -------------------------------
  const audit = new FileAuditLog(cfg.dataDir, log.child("audit"));
  const aegis = new Aegis();
  const llm = buildLlm(cfg, log);
  const kb = new MnemosyneKB({
    dataDir: cfg.dataDir,
    owner: cfg.tuning.githubOwner,
    repos: cfg.tuning.githubRepos,
    token: cfg.githubToken || undefined,
    intervalMin: cfg.tuning.kbSyncIntervalMin,
    aegis,
    log: log.child("mnemosyne"),
  });
  const brain = new DioscuriBrain({
    aegis,
    kb,
    llm,
    links,
    userLimiter: new TokenBucket(cfg.tuning.userRatePerMin, cfg.tuning.userRatePerMin),
    channelLimiter: new TokenBucket(cfg.tuning.channelRatePerMin, cfg.tuning.channelRatePerMin),
    log: log.child("brain"),
    audit,
  });
  const moderation = new Moderation({
    aegis,
    llm,
    cfg: cfg.tuning.moderation,
    officialLinks: links,
    // Burst of 6 messages, refilling 12/min — past that is flooding.
    floodLimiter: new TokenBucket(6, 12),
    log: log.child("moderation"),
  });
  // Optional AI meme generator for banter slots (off unless images.aiProvider
  // is set in the tuning file). A misconfigured provider must not kill boot —
  // memes are decoration, the twins speak either way.
  let memeProvider: ReturnType<typeof createImageProvider> | undefined;
  const imgTuning = cfg.tuning.content.images;
  if (imgTuning.aiProvider !== "") {
    try {
      memeProvider = createImageProvider(imgTuning.aiProvider, {
        apiKey: cfg.images.apiKey || undefined,
        baseUrl: cfg.images.baseUrl || undefined,
        model: imgTuning.aiModel || undefined,
        log: log.child("images"),
      });
      log.info("AI meme provider armed", {
        provider: imgTuning.aiProvider,
        perWeek: imgTuning.aiMemesPerWeek,
      });
    } catch (err) {
      log.warn("AI meme provider disabled (bad config)", { err: String(err) });
    }
  }

  let screenshotProvider: ReturnType<typeof createScreenshotProvider> | undefined;
  if (imgTuning.screenshots.enabled && cfg.screenshots.baseUrl !== "") {
    try {
      screenshotProvider = createScreenshotProvider({
        baseUrl: cfg.screenshots.baseUrl,
        log: log.child("screenshots"),
      });
      log.info("demo screenshot provider armed", { baseUrl: cfg.screenshots.baseUrl });
    } catch (err) {
      log.warn("screenshot provider disabled (bad config)", { err: String(err) });
    }
  }

  // --- Platform adapters ------------------------------------------------------
  const adapters: { telegram?: TelegramAdapter; discord?: DiscordAdapter } = {};
  let discordCanonChannelId = "";
  let bulletinPublisher: BulletinPublisher | undefined;

  if (cfg.discord.enabled) {
    let { announceChannelId, modLogChannelId, gallerySpotlightChannelId, canonChannelId, generalChannelId,
      bulletinChannelId } = cfg.discord;
    if (cfg.discord.autoStructure) {
      // Own short-lived client: build/heal the server layout, discover ids.
      const res = await provisionDiscord({
        token: cfg.discord.token,
        guildId: cfg.discord.guildId,
        links,
        dataDir: cfg.dataDir,
        log: log.child("provision.discord"),
      });
      announceChannelId = announceChannelId || res.announceChannelId;
      modLogChannelId = modLogChannelId || res.modLogChannelId;
      gallerySpotlightChannelId = gallerySpotlightChannelId || res.gallerySpotlightChannelId;
      canonChannelId = canonChannelId || res.canonChannelId;
      generalChannelId = generalChannelId || res.generalChannelId;
      bulletinChannelId = bulletinChannelId || res.bulletinChannelId;

      const { seeded } = await seedDiscordGuides({
        token: cfg.discord.token,
        guildId: cfg.discord.guildId,
        links,
        githubOwner: cfg.tuning.githubOwner,
        demoUrls: kb.demoUrls(),
        dataDir: cfg.dataDir,
        log: log.child("provision.guides"),
        dryRun: cfg.dryRun,
        captureScreenshot: screenshotProvider?.capture.bind(screenshotProvider),
      });
      if (seeded.length > 0) {
        log.info("discord channel guides seeded", { channels: seeded });
      }
    }
    discordCanonChannelId = canonChannelId;
    adapters.discord = new DiscordAdapter({
      token: cfg.discord.token,
      guildId: cfg.discord.guildId,
      modLogChannelId,
      announceChannelId,
      gallerySpotlightChannelId,
      canonChannelId: discordCanonChannelId,
      generalChannelId,
      bulletinChannelId,
      brain,
      moderation,
      links,
      log: log.child("pollux"),
      audit,
      bumpReminder: cfg.tuning.syndication.bumpReminder,
    });
    await adapters.discord.start();
    log.info("POLLUX holds the sky", { guildId: cfg.discord.guildId });

    // --- MOMUS security bulletin --------------------------------------------
    // The publisher was fully implemented but never constructed, so the channel
    // existed and nothing ever posted to it. It refuses to start without a
    // pinned key or a channel, and every cycle is caught internally, so wiring
    // it here cannot take the bot down.
    const bt = cfg.tuning.bulletin;
    if (bt.enabled) {
      const discord = adapters.discord;
      const pinnedKey = (process.env.MOMUS_BULLETIN_PUBKEY ?? bt.publicKeyHex).trim();
      const sinks: BulletinSink[] = [
        {
          name: "discord",
          post: (rendered) => discord.announceBulletin(rendered),
        },
      ];
      if (bulletinChannelId.trim() === "") {
        log.warn("bulletin publisher not started — no #momus-bulletin channel resolved");
      } else if (cfg.dryRun) {
        log.info("bulletin publisher held (dry run)", { indexUrl: bt.indexUrl });
      } else {
        bulletinPublisher = new BulletinPublisher({
          indexUrl: bt.indexUrl,
          publicKeyHex: pinnedKey,
          maxAgeMs: bt.maxAgeHours * 60 * 60 * 1000,
          pollIntervalMin: bt.pollIntervalMin,
          maxPostsPerRun: bt.maxPostsPerRun,
          writeupBaseUrl: bt.writeupBaseUrl,
          sinks,
          dataDir: cfg.dataDir,
          log: log.child("bulletin"),
          audit,
        });
        bulletinPublisher.start();
        log.info("MOMUS bulletin publisher armed", {
          indexUrl: bt.indexUrl,
          channelId: bulletinChannelId,
          pollIntervalMin: bt.pollIntervalMin,
        });
      }
    }
  }

  if (cfg.telegram.enabled) {
    if (cfg.telegram.autoSetup) {
      await setupTelegram({
        token: cfg.telegram.token,
        chatId: cfg.telegram.chatId,
        links,
        dataDir: cfg.dataDir,
        githubOwner: cfg.tuning.githubOwner,
        demoUrls: kb.demoUrls(),
        captureScreenshot: screenshotProvider?.capture.bind(screenshotProvider),
        log: log.child("provision.telegram"),
      });
    }
    adapters.telegram = new TelegramAdapter({
      token: cfg.telegram.token,
      chatId: cfg.telegram.chatId,
      brain,
      moderation,
      links,
      log: log.child("castor"),
      audit,
    });
    await adapters.telegram.start();
    log.info("CASTOR rides the ground", { chatId: cfg.telegram.chatId });
  }

  // --- First run only: the twins introduce themselves ------------------------
  await postOpeningFeast({
    telegram: adapters.telegram,
    discord: adapters.discord,
    links,
    dataDir: cfg.dataDir,
    log: log.child("opening"),
    audit,
  });

  // --- Engines ----------------------------------------------------------------
  wireReleaseAnnouncements(kb, adapters, links, log.child("releases"));

  const crosspromo = new CrossPromo({
    telegram: adapters.telegram,
    discord: adapters.discord,
    links,
    intervalHours: cfg.tuning.promoIntervalHours,
    log: log.child("crosspromo"),
    audit,
  });
  if (!cfg.dryRun) crosspromo.start();
  else log.info("cross-promo suppressed — dry-run mode");

  const theoxenia = new Theoxenia({
    telegram: adapters.telegram,
    discord: adapters.discord,
    kb,
    llm,
    links,
    cfg: cfg.tuning.content,
    dataDir: cfg.dataDir,
    log: log.child("theoxenia"),
    audit,
    memeProvider,
    screenshotProvider,
  });
  if (!cfg.dryRun) theoxenia.start();
  else log.info("theoxenia suppressed — dry-run mode");

  const runSlot = process.env.DIOSCURI_RUN_SLOT as ContentKind | undefined;
  const SLOT_KINDS: ContentKind[] = ["spotlight", "banter", "poll", "digest", "show-and-tell", "canon"];
  if (runSlot !== undefined && SLOT_KINDS.includes(runSlot)) {
    log.info("theoxenia one-shot slot", { kind: runSlot });
    await theoxenia.runSlotNow(runSlot);
    if (process.env.DIOSCURI_RUN_SLOT_EXIT === "1") {
      log.info("theoxenia one-shot complete — closing adapters then exiting");
      theoxenia.stop();
      // No adapters started yet at this point — safe to exit directly.
      setImmediate(() => process.exit(0));
    }
  }

  // KERYX (the herald):
  // accounts, armed purely by which secrets are present (X needs the explicit
  // pay-per-use opt-in). A quiet herald costs nothing; a broken sink is
  // skipped and never touches the twins. Suppressed in dry-run mode.
  let devtoTimer: ReturnType<typeof setTimeout> | null = null;
  let keryx: Keryx | undefined;
  if (cfg.tuning.syndication.enabled && !cfg.dryRun) {
    const sinks = armSinks(cfg.syndication, log.child("keryx"));
    if (sinks.length > 0) {
      const activeKeryx = new Keryx({ sinks, links, log: log.child("keryx"), audit });
      keryx = activeKeryx;
      kb.onRelease((ev) => void activeKeryx.announceRelease(ev));
      log.info("KERYX armed", { sinks: sinks.map((s) => s.name) });
    }

    if (cfg.syndication.devto.apiKey !== "") {
      const digest = createDevtoDigest({
        apiKey: cfg.syndication.devto.apiKey,
        kb,
        links,
        log: log.child("keryx.devto"),
      });
      const { devtoDigestDay, devtoDigestHourUtc } = cfg.tuning.syndication;
      const scheduleDigest = (): void => {
        const now = new Date();
        const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), devtoDigestDay, devtoDigestHourUtc));
        if (next.getTime() <= now.getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
        devtoTimer = setTimeout(
          () => {
            void digest
              .publishMonthly(new Date())
              .catch((err) => log.warn("devto digest failed", { err: String(err) }))
              .finally(() => scheduleDigest());
          },
          next.getTime() - now.getTime(),
        );
        devtoTimer.unref?.();
        log.info("devto digest scheduled", { at: next.toISOString() });
      };
      scheduleDigest();
    }
  }

  // Signal Hunt publishes no social credentials and never calls a platform.
  // DIOSCURI pulls its signed, opt-in hero feed, verifies the pinned provider key,
  // then relays each event once per sink with persistent per-sink delivery state.
  let heroPublisher: SignalHeroPublisher | undefined;
  const heroFeedUrl = (process.env.SIGNAL_HUNT_HERO_FEED_URL ?? "").trim();
  const heroPublicKey = (process.env.SIGNAL_HUNT_HERO_PUBKEY_B64 ?? "").trim();
  if (!cfg.dryRun && heroFeedUrl !== "" && heroPublicKey !== "") {
    const heroSinks: HeroSink[] = [];
    if (adapters.discord) {
      heroSinks.push({
        name: "discord",
        post: async (_event, text) => adapters.discord!.announce(text),
      });
    }
    if (keryx?.hasSink("x")) {
      heroSinks.push({
        name: "x",
        post: async (event) => keryx!.announceSignalHero(event),
      });
    }
    if (heroSinks.length === 0) {
      log.warn(
        "Signal Hunt hero feed URL + pubkey are set, but no Discord/X sink is armed — relay idle",
      );
    } else {
      heroPublisher = new SignalHeroPublisher({
        feedUrl: heroFeedUrl,
        publicKeyB64: heroPublicKey,
        pageUrl: (process.env.SIGNAL_HUNT_PUBLIC_URL ?? "https://hunt.modelmarket.dev").trim(),
        pollIntervalMin: parseInt(process.env.SIGNAL_HUNT_HERO_POLL_MINUTES ?? "5", 10),
        maxPostsPerRun: parseInt(process.env.SIGNAL_HUNT_HERO_MAX_POSTS ?? "3", 10),
        sinks: heroSinks,
        dataDir: cfg.dataDir,
        log: log.child("signal-hunt.heroes"),
        audit,
      });
      heroPublisher.start();
      log.info("Signal Hunt hero relay armed", { sinks: heroSinks.map((sink) => sink.name) });
    }
  } else if ((heroFeedUrl === "") !== (heroPublicKey === "")) {
    log.warn("Signal Hunt hero relay disabled — feed URL and pinned key must be set together");
  }

  // HELIOS broadcast queue — independent of KERYX social syndication toggles.
  // Master gate arms Theoros; release-shorts need HELIOS_RELEASE_SHORTS=1.
  if (!cfg.dryRun && isHeliosSyndicationEnabled()) {
    const queuePath = process.env.HELIOS_QUEUE_PATH!;
    if (isHeliosReleaseShortsEnabled()) {
      kb.onRelease((ev) =>
        enqueueReleaseVideo(ev, { log: log.child("helios"), queuePath }),
      );
      log.info("HELIOS syndication armed", { queuePath, releaseShorts: true, theoros: true });
    } else {
      log.info("HELIOS syndication armed", {
        queuePath,
        releaseShorts: false,
        theoros: true,
        hint: "set HELIOS_RELEASE_SHORTS=1 for release shipped shorts",
      });
    }
  }

  // Seed + periodic GitHub sync. Registered release handlers only fire for
  // NEW releases discovered after the first pass, so boot never spams.
  kb.start();

  // Project showcase: poll public demo endpoints → "live" chunks in the KB,
  // so the twins answer "what's running right now" with minutes-old facts.
  const showcase = new LiveStateSync({
    sources: cfg.tuning.showcase.sources,
    kb,
    aegis,
    log: log.child("showcase"),
    intervalMin: cfg.tuning.showcase.intervalMin,
  });
  if (cfg.tuning.showcase.enabled) showcase.start();

  const socialCache = createSocialStatsCache(cfg.dataDir);
  void socialCache.refresh();
  const socialRefreshMs = parseInt(process.env.DIOSCURI_SOCIAL_CACHE_SEC ?? "300", 10) * 1000;
  const socialTimer = setInterval(() => void socialCache.refresh(), socialRefreshMs);

  const health = createHealthServer({
    port: cfg.httpPort,
    version,
    log: log.child("health"),
    getStatus: () => {
      const social = socialCache.get();
      const theoros = computeTheorosStatus({
        discordReady: adapters.discord?.isReady() ?? false,
        canonChannelId: discordCanonChannelId,
        githubRepos: cfg.tuning.githubRepos,
        slots: cfg.tuning.content.slots,
      });
      return {
        adapters: {
          telegram: adapters.telegram?.isReady() ?? false,
          discord: adapters.discord?.isReady() ?? false,
        },
        kb: kb.stats(),
        dryRun: cfg.dryRun,
        social: {
          discord_members: social.discord_members,
          telegram_members: social.telegram_members,
          twitter_followers: social.twitter_followers,
          cached_at: social.cached_at,
          stale: social.stale,
        },
        theoros,
        signalHuntHeroes: heroPublisher?.status(),
      };
    },
  });
  log.info("health endpoint up", { port: cfg.httpPort });

  // --- Graceful shutdown -------------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("the twins retire", { signal });
    void (async () => {
      try {
        theoxenia.stop();
        crosspromo.stop();
        showcase.stop();
        clearInterval(socialTimer);
        if (devtoTimer) clearTimeout(devtoTimer);
        kb.stop();
        bulletinPublisher?.stop();
        heroPublisher?.stop();
        await adapters.telegram?.stop();
        await adapters.discord?.stop();
        await health.close();
      } catch (err) {
        log.warn("shutdown hiccup", { err: String(err) });
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { reason: String(reason) });
  });
}

main().catch((err) => {
  // Boot failures must be loud and fatal — docker restart policy takes over.
  process.stderr.write(`dioscuri boot failed: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
