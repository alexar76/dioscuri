/**
 * Social platform statistics — cached, lazy refresh for Alien Monitor.
 * POST-only charter: read public metrics only, no engagement automation.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SocialStats {
  discord_members: number;
  telegram_members: number;
  twitter_followers: number;
  cached_at: string | null;
  stale: boolean;
}

const DEFAULT: SocialStats = {
  discord_members: 0,
  telegram_members: 0,
  twitter_followers: 0,
  cached_at: null,
  stale: true,
};

export interface SocialStatsOptions {
  cachePath: string;
  ttlSec: number;
  discordGuildId?: string;
  discordBotToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  twitterBearerToken?: string;
  twitterUserId?: string;
}

export class SocialStatsCache {
  private readonly opts: SocialStatsOptions;
  private memory: SocialStats & { _fetchedAt?: number } = { ...DEFAULT };

  constructor(opts: SocialStatsOptions) {
    this.opts = opts;
    this.loadDisk();
  }

  private loadDisk(): void {
    try {
      if (existsSync(this.opts.cachePath)) {
        const raw = JSON.parse(readFileSync(this.opts.cachePath, "utf8")) as SocialStats & { _fetchedAt?: number };
        this.memory = { ...DEFAULT, ...raw };
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  private saveDisk(data: SocialStats & { _fetchedAt?: number }): void {
    try {
      mkdirSync(dirname(this.opts.cachePath), { recursive: true });
      writeFileSync(this.opts.cachePath, JSON.stringify(data, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Immediate return from cache (lazy load for Monitor clicks). */
  get(): SocialStats {
    const { _fetchedAt: _, ...pub } = this.memory;
    return pub;
  }

  async refresh(): Promise<SocialStats> {
    const now = Date.now();
    if (this.memory._fetchedAt && now - this.memory._fetchedAt < this.opts.ttlSec * 1000) {
      return this.get();
    }

    const next: SocialStats & { _fetchedAt?: number } = { ...this.get(), stale: false, cached_at: new Date().toISOString() };

    try {
      if (this.opts.discordBotToken && this.opts.discordGuildId) {
        const r = await fetch(`https://discord.com/api/v10/guilds/${this.opts.discordGuildId}?with_counts=true`, {
          headers: { Authorization: `Bot ${this.opts.discordBotToken}` },
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const j = (await r.json()) as { approximate_member_count?: number };
          next.discord_members = j.approximate_member_count ?? 0;
        }
      }

      if (this.opts.telegramBotToken && this.opts.telegramChatId) {
        const url = `https://api.telegram.org/bot${this.opts.telegramBotToken}/getChatMemberCount?chat_id=${encodeURIComponent(this.opts.telegramChatId)}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const j = (await r.json()) as { result?: number };
          next.telegram_members = j.result ?? 0;
        }
      }

      if (this.opts.twitterBearerToken && this.opts.twitterUserId) {
        const r = await fetch(
          `https://api.twitter.com/2/users/${this.opts.twitterUserId}?user.fields=public_metrics`,
          {
            headers: { Authorization: `Bearer ${this.opts.twitterBearerToken}` },
            signal: AbortSignal.timeout(8000),
          },
        );
        if (r.ok) {
          const j = (await r.json()) as { data?: { public_metrics?: { followers_count?: number } } };
          next.twitter_followers = j.data?.public_metrics?.followers_count ?? 0;
        }
      }

      next._fetchedAt = now;
      this.memory = next;
      this.saveDisk(next);
    } catch {
      next.stale = true;
      if (this.memory.cached_at) {
        return { ...this.get(), stale: true };
      }
    }

    return this.get();
  }
}

export function createSocialStatsCache(dataDir: string): SocialStatsCache {
  return new SocialStatsCache({
    cachePath: join(dataDir, "social_stats.json"),
    ttlSec: parseInt(process.env.DIOSCURI_SOCIAL_CACHE_SEC ?? "300", 10),
    discordGuildId: process.env.DISCORD_GUILD_ID,
    discordBotToken: process.env.DISCORD_BOT_TOKEN,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHANNEL_ID,
    twitterBearerToken: process.env.TWITTER_BEARER_TOKEN ?? process.env.X_BEARER_TOKEN,
    twitterUserId: process.env.TWITTER_USER_ID ?? process.env.X_USER_ID,
  });
}
