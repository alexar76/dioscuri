/**
 * MNEMOSYNE / GithubSync — the only component that talks to api.github.com.
 *
 *  - Endpoints: user repo listing (allowlist-filtered when opts.repos is
 *    non-empty), raw README, latest releases (per_page=5).
 *  - Every request sends User-Agent "dioscuri-kb/0.1" and, when a token is
 *    configured, "Authorization: Bearer <token>".
 *  - Per-URL ETag cache: repeated requests send If-None-Match and a 304
 *    answer is served from the cached body — cheap polling that does not
 *    burn rate limit on unchanged content.
 *  - 403/429 with `x-ratelimit-remaining: 0` throws RateLimited carrying the
 *    reset time so the caller can back off instead of hammering.
 *
 * POISONED-DOC DEFENSE: sanitizeChunkTexts() pushes every chunk destined for
 * the KnowledgeStore through aegis.inspect (maxLen 1600). A "reject" verdict
 * drops the chunk and logs ONLY the finding codes — never the hostile text,
 * so the logs cannot become a second injection surface.
 *
 * Dependencies arrive via the constructor (AegisGate, Logger, fetchFn) —
 * tests inject a mock fetch and a stub gate.
 */

import type { AegisGate, Logger } from "../types.js";

const API = "https://api.github.com";
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";
const USER_AGENT = "dioscuri-kb/0.1";

/** Thrown when GitHub says the rate limit is exhausted. */
export class RateLimited extends Error {
  constructor(
    message: string,
    /** When the limit window resets (from x-ratelimit-reset), if known. */
    readonly resetAt: Date | null,
  ) {
    super(message);
    this.name = "RateLimited";
  }
}

export interface RepoInfo {
  name: string;
  description: string | null;
  topics: string[];
  htmlUrl: string;
  updatedAt: string;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
}

export interface CommitInfo {
  /** Short sha (7 chars). */
  sha: string;
  /** First line of the commit message. */
  message: string;
  date: string;
  url: string;
}

export interface GithubSyncOptions {
  owner: string;
  /** Non-empty = repo allowlist (case-insensitive); empty = all public repos. */
  repos: string[];
  token?: string;
  aegis: AegisGate;
  log: Logger;
  fetchFn?: typeof fetch;
}

interface CacheEntry {
  etag: string;
  body: string;
}

interface FetchResult {
  body: string;
  notFound: boolean;
}

export class GithubSync {
  private readonly owner: string;
  private readonly allowlist: Set<string>;
  private readonly token: string;
  private readonly aegis: AegisGate;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly etagCache = new Map<string, CacheEntry>();

  constructor(opts: GithubSyncOptions) {
    this.owner = opts.owner;
    this.allowlist = new Set(opts.repos.map((r) => r.toLowerCase()));
    this.token = opts.token ?? "";
    this.aegis = opts.aegis;
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Public repos of the owner, newest activity first, allowlist-filtered. */
  async listRepos(): Promise<RepoInfo[]> {
    const url = `${API}/users/${encodeURIComponent(this.owner)}/repos?per_page=100&sort=updated`;
    const res = await this.request(url, JSON_ACCEPT);
    if (res.notFound) return [];
    const parsed = parseJson(res.body, url);
    if (!Array.isArray(parsed)) throw new Error(`GitHub repos payload is not an array (${url})`);

    const repos: RepoInfo[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      if (name === "") continue;
      if (this.allowlist.size > 0 && !this.allowlist.has(name.toLowerCase())) continue;
      repos.push({
        name,
        description: typeof o.description === "string" ? o.description : null,
        topics: Array.isArray(o.topics) ? o.topics.filter((t): t is string => typeof t === "string") : [],
        htmlUrl: typeof o.html_url === "string" ? o.html_url : `https://github.com/${this.owner}/${name}`,
        updatedAt: typeof o.updated_at === "string" ? o.updated_at : "",
      });
    }
    return repos;
  }

  /** Raw README markdown, or null when the repo has none (404). */
  async fetchReadme(repo: string): Promise<string | null> {
    const url = `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(repo)}/readme`;
    const res = await this.request(url, RAW_ACCEPT);
    return res.notFound ? null : res.body;
  }

  /** Latest releases (max 5), drafts filtered out. 404 → empty list. */
  async fetchReleases(repo: string): Promise<ReleaseInfo[]> {
    const url = `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(repo)}/releases?per_page=5`;
    const res = await this.request(url, JSON_ACCEPT);
    if (res.notFound) return [];
    const parsed = parseJson(res.body, url);
    if (!Array.isArray(parsed)) throw new Error(`GitHub releases payload is not an array (${url})`);

    const releases: ReleaseInfo[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (o.draft === true) continue;
      const tag = typeof o.tag_name === "string" ? o.tag_name : "";
      if (tag === "") continue;
      releases.push({
        tag,
        name: typeof o.name === "string" && o.name !== "" ? o.name : tag,
        body: typeof o.body === "string" ? o.body : "",
        url: typeof o.html_url === "string" ? o.html_url : `https://github.com/${this.owner}/${repo}/releases`,
        publishedAt: typeof o.published_at === "string" ? o.published_at : "",
        prerelease: o.prerelease === true,
      });
    }
    return releases;
  }

  /**
   * Recent commits (merge commits skipped) — the twins' awareness of what
   * shipped between releases. 404/empty repo → empty list.
   */
  async fetchCommits(repo: string, sinceIso: string, perPage = 20): Promise<CommitInfo[]> {
    const url =
      `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(repo)}` +
      `/commits?since=${encodeURIComponent(sinceIso)}&per_page=${perPage}`;
    const res = await this.request(url, JSON_ACCEPT);
    if (res.notFound) return [];
    const parsed = parseJson(res.body, url);
    if (!Array.isArray(parsed)) return [];

    const commits: CommitInfo[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      const commit = (o.commit ?? {}) as Record<string, unknown>;
      const rawMsg = typeof commit.message === "string" ? commit.message : "";
      const firstLine = rawMsg.split("\n", 1)[0]?.trim() ?? "";
      if (firstLine === "" || firstLine.startsWith("Merge ")) continue;
      const author = (commit.author ?? {}) as Record<string, unknown>;
      commits.push({
        sha: typeof o.sha === "string" ? o.sha.slice(0, 7) : "",
        message: firstLine,
        date: typeof author.date === "string" ? author.date : "",
        url: typeof o.html_url === "string" ? o.html_url : "",
      });
    }
    return commits;
  }

  /**
   * POISONED-DOC DEFENSE — run raw chunk texts through the AEGIS gate.
   * Rejected chunks are dropped with a warning that carries only finding
   * codes; allowed chunks come back sanitised (maxLen 1600 per contract).
   */
  sanitizeChunkTexts(texts: string[], meta: { repo: string; source: string }): string[] {
    const out: string[] = [];
    for (const text of texts) {
      const verdict = this.aegis.inspect(text, { maxLen: 1600 });
      if (verdict.action === "reject") {
        this.log.warn("poisoned KB chunk dropped", {
          repo: meta.repo,
          source: meta.source,
          codes: verdict.findings.map((f) => f.code),
        });
        continue;
      }
      if (verdict.sanitizedText.trim().length > 0) out.push(verdict.sanitizedText);
    }
    return out;
  }

  /** One conditional GET with ETag caching and rate-limit detection. */
  private async request(url: string, accept: string): Promise<FetchResult> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token !== "") headers.Authorization = `Bearer ${this.token}`;
    const cached = this.etagCache.get(url);
    if (cached) headers["If-None-Match"] = cached.etag;

    const res = await this.fetchFn(url, { headers });

    if (res.status === 304 && cached) {
      this.log.debug("github 304 — served from ETag cache", { url });
      return { body: cached.body, notFound: false };
    }
    if (res.status === 404) return { body: "", notFound: true };
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const resetRaw = res.headers.get("x-ratelimit-reset");
      const resetSec = resetRaw === null ? NaN : Number(resetRaw);
      const resetAt = Number.isFinite(resetSec) ? new Date(resetSec * 1000) : null;
      throw new RateLimited(`GitHub rate limit exhausted (HTTP ${res.status}) for ${url}`, resetAt);
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status} for ${url}`);

    const body = await res.text();
    const etag = res.headers.get("etag");
    if (etag) this.etagCache.set(url, { etag, body });
    return { body, notFound: false };
  }
}

function parseJson(body: string, url: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GitHub returned invalid JSON for ${url}`);
  }
}
