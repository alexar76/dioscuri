/**
 * MNEMOSYNE — the twins' shared memory: a self-updating knowledge base
 * synced from GitHub (implements the `Mnemosyne` contract in ../types.ts).
 *
 * Sync pass (syncOnce):
 *   list repos → per repo:
 *     README   → markdownToPlain → chunkText → AEGIS-sanitised "readme" chunks
 *     releases → one sanitised "release" chunk each (+ release-event diffing)
 *     metadata → one "repo-meta" chunk (description/topics)
 *   then persist everything (chunks + seenReleases) to {dataDir}/mnemosyne.json.
 *
 * Release announcements: a ReleaseEvent fires once per NEW "repo@tag" — never
 * for tags already in seenReleases, and never on the very first sync of an
 * empty store (otherwise a fresh install would spam every historic release).
 * Events are emitted only AFTER the pass has been persisted, so a crash
 * between "seen" and "announced" can silence one event but never duplicate it.
 *
 * Failure containment: a broken repo is skipped (previous chunks kept),
 * RateLimited aborts the pass; start() logs sync errors and never throws.
 * Clock and timers are injectable for tests; the interval is unref'd so it
 * cannot keep the process alive.
 */

import { join } from "node:path";
import type {
  AegisGate,
  KnowledgeChunk,
  Logger,
  Mnemosyne,
  MnemosyneStats,
  ReleaseEvent,
  RetrievalHit,
} from "../types.js";
import { prepareUntrusted } from "../aegis/sanitize.js";
import { chunkText, markdownToPlain } from "./chunker.js";
import { extractDemoUrl, resolveDemoForTopic } from "./demo-urls.js";
import { GithubSync, RateLimited, type ReleaseInfo, type RepoInfo } from "./github-sync.js";
import type { DemoMatch } from "../types.js";
import { KnowledgeStore } from "./store.js";

export { RateLimited } from "./github-sync.js";

/** Minimal timer handle so tests can inject fakes. */
export interface IntervalHandle {
  unref?: () => unknown;
}

export interface MnemosyneOptions {
  dataDir: string;
  owner: string;
  /** Non-empty = repo allowlist; empty = all public repos of the owner. */
  repos: string[];
  token?: string;
  intervalMin: number;
  aegis: AegisGate;
  log: Logger;
  fetchFn?: typeof fetch;
  /** Injectable clock/timers for tests. */
  now?: () => Date;
  setIntervalFn?: (fn: () => void, ms: number) => IntervalHandle;
  clearIntervalFn?: (handle: IntervalHandle) => void;
}

const STORE_FILE = "mnemosyne.json";

/** How far back the per-repo commit digest looks. */
const COMMITS_LOOKBACK_DAYS = 14;

export class MnemosyneKB implements Mnemosyne {
  private readonly store = new KnowledgeStore();
  private readonly gh: GithubSync;
  private readonly aegis: AegisGate;
  private readonly log: Logger;
  private readonly owner: string;
  private readonly intervalMin: number;
  private readonly storePath: string;
  private readonly now: () => Date;
  private readonly setIntervalFn: (fn: () => void, ms: number) => IntervalHandle;
  private readonly clearIntervalFn: (handle: IntervalHandle) => void;

  private readonly releaseCbs: Array<(ev: ReleaseEvent) => void> = [];
  private timer: IntervalHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private lastSyncAt: string | null = null;
  private lastSyncOk = false;

  constructor(opts: MnemosyneOptions) {
    this.aegis = opts.aegis;
    this.log = opts.log;
    this.owner = opts.owner;
    this.intervalMin = Math.max(1, opts.intervalMin);
    this.storePath = join(opts.dataDir, STORE_FILE);
    this.now = opts.now ?? (() => new Date());
    this.setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.gh = new GithubSync({
      owner: opts.owner,
      repos: opts.repos,
      token: opts.token,
      aegis: opts.aegis,
      log: opts.log,
      fetchFn: opts.fetchFn,
    });

    if (this.store.load(this.storePath)) {
      this.log.info("knowledge base loaded from disk", {
        path: this.storePath,
        chunks: this.store.chunkCount(),
        seenReleases: this.store.seenReleaseCount(),
      });
    }
  }

  search(query: string, k: number): RetrievalHit[] {
    return this.store.search(query, k);
  }

  stats(): MnemosyneStats {
    return {
      chunks: this.store.chunkCount(),
      repos: this.store.repoCount(),
      lastSyncAt: this.lastSyncAt,
      lastSyncOk: this.lastSyncOk,
    };
  }

  onRelease(cb: (ev: ReleaseEvent) => void): void {
    this.releaseCbs.push(cb);
  }

  /**
   * External chunk injection (live showcase snapshots, etc). Atomic per
   * sourceKey; deliberately NOT persisted — live data repopulates within one
   * refresh interval and must never survive as stale "current state".
   */
  ingest(sourceKey: string, chunks: KnowledgeChunk[]): void {
    this.store.replaceRepo(sourceKey, chunks);
  }

  /** Per-repo demo URLs extracted from READMEs on the last sync pass. */
  demoUrls(): Record<string, string> {
    return Object.fromEntries(this.store.allDemoUrls());
  }

  /** Match a content topic to a README-sourced demo page, if any. */
  resolveDemoUrl(topic: string): DemoMatch | null {
    return resolveDemoForTopic(topic, this.store.allDemoUrls());
  }

  /** One sync pass; concurrent callers join the in-flight pass. */
  syncOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  start(): void {
    if (this.timer) return;
    void this.syncOnce().catch((err) => {
      this.log.error("initial KB sync failed", { error: String(err) });
    });
    this.timer = this.setIntervalFn(() => {
      void this.syncOnce().catch((err) => {
        this.log.error("periodic KB sync failed", { error: String(err) });
      });
    }, this.intervalMin * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  private async runSync(): Promise<void> {
    // First-ever sync = nothing on disk and nothing seen → seed silently.
    const firstSeed = this.store.isEmpty();
    const events: ReleaseEvent[] = [];
    try {
      const repos = await this.gh.listRepos();
      let okAll = true;
      for (const repo of repos) {
        try {
          this.store.replaceRepo(repo.name, await this.buildRepoChunks(repo, events, firstSeed));
        } catch (err) {
          if (err instanceof RateLimited) throw err;
          okAll = false;
          this.log.warn("repo sync failed; keeping previous chunks", {
            repo: repo.name,
            error: String(err),
          });
        }
      }
      this.lastSyncOk = okAll;
      this.log.info("KB sync pass complete", {
        repos: repos.length,
        chunks: this.store.chunkCount(),
        newReleases: events.length,
        firstSeed,
      });
    } catch (err) {
      this.lastSyncOk = false;
      if (err instanceof RateLimited) {
        this.log.warn("GitHub rate limited — sync pass aborted", {
          resetAt: err.resetAt?.toISOString() ?? null,
        });
      }
      throw err;
    } finally {
      this.lastSyncAt = this.now().toISOString();
      try {
        await this.store.persist(this.storePath);
      } catch (err) {
        this.log.error("KB persist failed", { path: this.storePath, error: String(err) });
      }
      // Emit only after persisting: a crash may drop an announcement but can
      // never replay one (seenReleases is already on disk).
      this.emitReleaseEvents(events);
    }
  }

  /** README + release + repo-meta chunks for one repo, all AEGIS-gated. */
  private async buildRepoChunks(repo: RepoInfo, events: ReleaseEvent[], firstSeed: boolean): Promise<KnowledgeChunk[]> {
    const chunks: KnowledgeChunk[] = [];
    const fallbackTs = repo.updatedAt !== "" ? repo.updatedAt : this.now().toISOString();

    // README → plain text → chunks → sanitised.
    const readme = await this.gh.fetchReadme(repo.name);
    if (readme !== null) {
      const demoUrl = extractDemoUrl(readme);
      this.store.setDemoUrl(repo.name, demoUrl);
      const parts = chunkText(markdownToPlain(readme));
      const clean = this.gh.sanitizeChunkTexts(parts, { repo: repo.name, source: "readme" });
      clean.forEach((text, n) => {
        chunks.push({
          id: `${repo.name}#readme#${n}`,
          repo: repo.name,
          source: "readme",
          title: `${repo.name} README`,
          url: `${repo.htmlUrl}#readme`,
          text,
          updatedAt: fallbackTs,
        });
      });
    }

    // Releases → one chunk each + new-tag diffing against seenReleases.
    const releases = await this.gh.fetchReleases(repo.name);
    releases.forEach((rel, n) => {
      this.processRelease(repo, rel, n, fallbackTs, chunks, events, firstSeed);
    });

    // Recent commits (14 days) → one "what changed lately" digest chunk, so
    // the twins can discuss fresh functionality that never made a release yet.
    const since = new Date(this.now().getTime() - COMMITS_LOOKBACK_DAYS * 86_400_000).toISOString();
    const commits = await this.gh.fetchCommits(repo.name, since);
    if (commits.length > 0) {
      const lines = commits.map(
        (c) => `• ${c.date.slice(0, 10)} ${c.sha} — ${c.message}`,
      );
      const digest =
        `${repo.name} — recent changes (last ${COMMITS_LOOKBACK_DAYS} days, ` +
        `${commits.length} commits):\n${lines.join("\n")}`;
      const clean = this.gh.sanitizeChunkTexts([digest], { repo: repo.name, source: "doc" });
      const text = clean[0];
      if (text !== undefined) {
        chunks.push({
          id: `${repo.name}#changes#0`,
          repo: repo.name,
          source: "doc",
          title: `${repo.name} — recent changes`,
          url: `${repo.htmlUrl}/commits`,
          text,
          updatedAt: commits[0]?.date !== "" ? (commits[0]?.date ?? fallbackTs) : fallbackTs,
        });
      }
    }

    // Repo metadata (description/topics) → one small chunk.
    const metaBits = [`${repo.name} — a repository by ${this.owner}.`];
    if (repo.description !== null && repo.description !== "") {
      metaBits.push(`Description: ${repo.description}`);
    }
    if (repo.topics.length > 0) metaBits.push(`Topics: ${repo.topics.join(", ")}`);
    const metaClean = this.gh.sanitizeChunkTexts([metaBits.join("\n")], {
      repo: repo.name,
      source: "repo-meta",
    });
    const metaText = metaClean[0];
    if (metaText !== undefined) {
      chunks.push({
        id: `${repo.name}#repo-meta#0`,
        repo: repo.name,
        source: "repo-meta",
        title: `${repo.name} (repository)`,
        url: repo.htmlUrl,
        text: metaText,
        updatedAt: fallbackTs,
      });
    }

    return chunks;
  }

  private processRelease(
    repo: RepoInfo,
    rel: ReleaseInfo,
    n: number,
    fallbackTs: string,
    chunks: KnowledgeChunk[],
    events: ReleaseEvent[],
    firstSeed: boolean,
  ): void {
    const tag = prepareUntrusted(rel.tag, 100);
    const name = prepareUntrusted(rel.name, 200);
    const publishedAt = rel.publishedAt !== "" ? rel.publishedAt : fallbackTs;

    // Knowledge chunk: name + notes, gated at the standard 1600-char cap.
    const verdict = this.aegis.inspect(`${name}\n${rel.body}`, { maxLen: 1600 });
    if (verdict.action === "reject") {
      this.log.warn("poisoned release notes dropped", {
        repo: repo.name,
        tag,
        codes: verdict.findings.map((f) => f.code),
      });
    } else if (verdict.sanitizedText.trim().length > 0) {
      chunks.push({
        id: `${repo.name}#release#${n}`,
        repo: repo.name,
        source: "release",
        title: `${repo.name} ${tag}`,
        url: rel.url,
        text: verdict.sanitizedText,
        updatedAt: publishedAt,
      });
    }

    // New-release diffing (ids "repo@tag"): fire only for genuinely new tags,
    // and never during the very first seed of an empty store.
    if (tag === "") return;
    const seenId = `${repo.name}@${tag}`;
    if (this.store.hasSeenRelease(seenId)) return;
    this.store.markReleaseSeen(seenId);
    if (firstSeed) return;

    const summaryVerdict = this.aegis.inspect(rel.body, { maxLen: 600 });
    events.push({
      repo: repo.name,
      tag,
      name,
      url: rel.url,
      summary: summaryVerdict.action === "reject" ? "" : summaryVerdict.sanitizedText,
      publishedAt,
    });
  }

  private emitReleaseEvents(events: ReleaseEvent[]): void {
    for (const ev of events) {
      for (const cb of this.releaseCbs) {
        try {
          cb(ev);
        } catch (err) {
          this.log.error("release callback failed", {
            repo: ev.repo,
            tag: ev.tag,
            error: String(err),
          });
        }
      }
    }
  }
}
