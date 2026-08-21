/**
 * COMMUNITY / github — the narrow public window the insiders gate looks through.
 *
 * FOUR ROUTES. That is the entire surface this feature ever requests:
 *
 *   GET /users/{login}/gists?per_page=…                    ← challenge proof
 *   GET /repos/{owner}/{repo}/issues/{n}/comments?since=…  ← challenge proof
 *   GET /search/issues?q=is:pr+is:merged+author:…+user:…   ← merged-PR contribution
 *   GET /search/issues?q=is:issue+author:…+user:…          ← opened-issue contribution
 *
 * All four read PUBLIC data only, and none of them reads who endorsed the
 * project. There is no method on {@link GithubPublicReader} that returns a star
 * count, a star list or a star date, which makes the absence structural rather
 * than a matter of discipline: a future edit cannot "just peek" through a door
 * that was never built. The project deliberately does not measure who endorses
 * it — an endorsement check would mean polling individuals' GitHub activity and
 * keeping an engagement history, which is surveillance and a data set we would
 * then have to protect.
 *
 * NO OAUTH, NO SCOPES. We never ask a member for a token: an access token that
 * can read somebody's activity is far more power than proving "I control this
 * account" needs. The proof is a one-time code the member publishes under their
 * own account, which we then read the same way any stranger could.
 *
 * A configured GITHUB_TOKEN (the bot's own, already in config for MNEMOSYNE) is
 * sent when present purely to raise the rate limit on these public reads. It is
 * never logged and never leaves this module.
 *
 * FAILURE PHILOSOPHY. This module throws on transport/HTTP failure and the gate
 * catches it (see access.ts): "GitHub was unreachable" must read as "we could not
 * check", never as "you are not a contributor" and never as a crash.
 */

import type { Logger } from "../types.js";

const API = "https://api.github.com";
const JSON_ACCEPT = "application/vnd.github+json";
const USER_AGENT = "dioscuri-insiders/0.1";
const API_VERSION = "2022-11-28";

/** A hanging endpoint must never stall a member's command. */
const FETCH_TIMEOUT_MS = 10_000;

/** Hard cap on any response body we will read (OOM guard). */
const MAX_BODY_BYTES = 1_000_000;

/** Newest gists are enough: the code was minted minutes ago. */
const GIST_PAGE = 20;
/** One page of comments, narrowed by `since` — see listIssueComments. */
const COMMENT_PAGE = 100;
/** Search hits we look at; the first merged PR already settles the question. */
const SEARCH_PAGE = 10;

/**
 * One public gist, as the LISTING describes it.
 *
 * File CONTENTS are deliberately not part of this shape: the description and the
 * filenames are enough to carry a one-time code, and fetching the body of a
 * stranger's gist would read more of their writing than this check needs.
 */
export interface GistSummary {
  id: string;
  description: string;
  filenames: string[];
  isPublic: boolean;
  /** Owner login as GitHub spells it — used to confirm who published the code. */
  ownerLogin: string;
}

/** One comment on a public issue. `authorAssociation` is GitHub's own field. */
export interface IssueComment {
  authorLogin: string;
  /** OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE — GitHub's vocabulary. */
  authorAssociation: string;
  body: string;
}

/** A pull request or issue, identified only by where it lives. */
export interface IssueRef {
  repo: string;
  number: number;
  url: string;
}

/**
 * The reader the gate depends on. Tests inject a fake; production injects
 * {@link HttpGithubPublicReader}.
 *
 * Deliberately four methods and no more. Nothing here reads endorsements.
 */
export interface GithubPublicReader {
  /** Public gists of one login (listing only — description + filenames). */
  listPublicGists(login: string): Promise<GistSummary[]>;
  /**
   * Comments on ONE designated public issue. `since` narrows the read to
   * comments newer than the challenge, which both bounds the request to a single
   * page and means an old comment can never be mistaken for a fresh proof.
   */
  listIssueComments(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    since?: string;
  }): Promise<IssueComment[]>;
  /** Merged pull requests this login authored in the owner's repos. */
  searchMergedPullRequests(opts: { owner: string; login: string }): Promise<IssueRef[]>;
  /** Issues this login opened in the owner's repos (spam-filtered by the caller). */
  searchAuthoredIssues(opts: { owner: string; login: string }): Promise<IssueRef[]>;
}

export interface HttpGithubPublicReaderOpts {
  /** Bot's own token, optional. Raises the rate limit on PUBLIC reads only. */
  token?: string;
  log: Logger;
  fetchFn?: typeof fetch;
}

export class HttpGithubPublicReader implements GithubPublicReader {
  private readonly token: string;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;

  constructor(opts: HttpGithubPublicReaderOpts) {
    this.token = opts.token ?? "";
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async listPublicGists(login: string): Promise<GistSummary[]> {
    const url = `${API}/users/${encodeURIComponent(login)}/gists?per_page=${GIST_PAGE}`;
    const parsed = await this.getJson(url);
    if (!Array.isArray(parsed)) return [];
    const out: GistSummary[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const files = o.files;
      const filenames =
        files !== null && typeof files === "object" && !Array.isArray(files)
          ? Object.keys(files as Record<string, unknown>)
          : [];
      const owner = (o.owner ?? {}) as Record<string, unknown>;
      out.push({
        id: typeof o.id === "string" ? o.id : "",
        description: typeof o.description === "string" ? o.description : "",
        filenames,
        // Only public gists are listed for other users; checked anyway, because a
        // private gist is not a public proof and must not be treated as one.
        isPublic: o.public === true,
        ownerLogin: typeof owner.login === "string" ? owner.login : "",
      });
    }
    return out;
  }

  async listIssueComments(opts: {
    owner: string;
    repo: string;
    issueNumber: number;
    since?: string;
  }): Promise<IssueComment[]> {
    const base =
      `${API}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}` +
      `/issues/${encodeURIComponent(String(opts.issueNumber))}/comments?per_page=${COMMENT_PAGE}`;
    const url = opts.since !== undefined && opts.since !== "" ? `${base}&since=${encodeURIComponent(opts.since)}` : base;
    const parsed = await this.getJson(url);
    if (!Array.isArray(parsed)) return [];
    const out: IssueComment[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const user = (o.user ?? {}) as Record<string, unknown>;
      out.push({
        authorLogin: typeof user.login === "string" ? user.login : "",
        authorAssociation: typeof o.author_association === "string" ? o.author_association : "",
        body: typeof o.body === "string" ? o.body : "",
      });
    }
    return out;
  }

  async searchMergedPullRequests(opts: { owner: string; login: string }): Promise<IssueRef[]> {
    return this.search(`is:pr is:merged author:${opts.login} user:${opts.owner}`);
  }

  async searchAuthoredIssues(opts: { owner: string; login: string }): Promise<IssueRef[]> {
    return this.search(`is:issue author:${opts.login} user:${opts.owner}`);
  }

  /**
   * One search call. The `user:` qualifier scopes the answer to repositories the
   * configured owner owns, so a merged pull request somewhere else in the world
   * never counts — the gate is about contributing to THIS ecosystem.
   */
  private async search(query: string): Promise<IssueRef[]> {
    const url = `${API}/search/issues?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE}`;
    const parsed = await this.getJson(url);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const items = (parsed as Record<string, unknown>).items;
    if (!Array.isArray(items)) return [];
    const out: IssueRef[] = [];
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const number = typeof o.number === "number" ? o.number : 0;
      if (number <= 0) continue;
      out.push({
        repo: repoNameFromApiUrl(typeof o.repository_url === "string" ? o.repository_url : ""),
        number,
        url: typeof o.html_url === "string" ? o.html_url : "",
      });
    }
    return out;
  }

  /** One bounded GET. Throws on any non-OK answer; the gate turns that into a refusal. */
  private async getJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: JSON_ACCEPT,
      "X-GitHub-Api-Version": API_VERSION,
    };
    // The token is a value, never a log line: nothing in this module prints headers.
    if (this.token !== "") headers.Authorization = `Bearer ${this.token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await this.fetchFn(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));

    if (res.status === 404) return null; // a missing gist list / issue is "no proof", not an error
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error(`GitHub rate limit exhausted (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);

    const body = await res.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      throw new Error(`GitHub response exceeds the ${MAX_BODY_BYTES} byte limit`);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // The URL is ours, so it is safe to name; the body is not echoed anywhere.
      this.log.warn("GitHub returned unparseable JSON", { url });
      throw new Error("GitHub returned unparseable JSON");
    }
  }
}

/** "https://api.github.com/repos/owner/repo" → "repo" ("" when it does not parse). */
function repoNameFromApiUrl(url: string): string {
  const parts = url.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? "";
}
