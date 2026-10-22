/**
 * KERYX blog relay — a new article on the project blog goes out once to every armed sink.
 *
 * The herald otherwise speaks only when a GitHub release ships; a blog post is the other thing worth
 * one line on the project's own accounts. Same charter as the rest of KERYX: post-only, our own
 * text, low volume. The feed is an Atom document (the blog's feed.xml); only entries under the
 * feed's own directory are relayed, so a tampered feed cannot make the herald post someone else's
 * link. Delivery state is per entry and per sink, like the Signal Hunt hero relay: a sink that fails
 * is retried on the next poll, a delivered one never posts twice.
 *
 * The first poll records a baseline: every entry older than maxAgeHours is marked delivered and
 * never posted. Later, an entry that shows up already old (a back-dated import of an article first
 * published elsewhere) is marked delivered silently too. Only fresh entries are announced, at most
 * maxPostsPerRun per poll, oldest first.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditLog, Logger, SyndicationSink } from "../types.js";

const STATE_FILE = "keryx-blog.json";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FEED_BYTES = 2_000_000;

export interface BlogPost {
  id: string;
  title: string;
  url: string;
  published: string;
}

interface RelayState {
  schema: 1;
  initialized: boolean;
  delivered: Record<string, Record<string, true>>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
      if (ref[0] === "#") {
        const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[ref.toLowerCase()] ?? whole;
    })
    .trim();
}

function tag(entry: string, name: string): string {
  const m = entry.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]!) : "";
}

/** The entries of an Atom feed whose link lies under `allowedPrefix`, in feed order. */
export function parseAtomFeed(xml: string, allowedPrefix: string): BlogPost[] {
  const posts: BlogPost[] = [];
  for (const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1]!;
    let url = "";
    for (const link of entry.matchAll(/<link\b([^>]*)\/?>/g)) {
      const attrs = link[1]!;
      const rel = attrs.match(/\brel="([^"]*)"/)?.[1] ?? "alternate";
      const href = attrs.match(/\bhref="([^"]*)"/)?.[1];
      if (rel === "alternate" && href) {
        url = decodeXml(href);
        break;
      }
    }
    const title = tag(entry, "title").replace(/\s+/g, " ");
    const published = tag(entry, "published") || tag(entry, "updated");
    if (!url.startsWith(allowedPrefix) || title === "" || Number.isNaN(Date.parse(published))) continue;
    posts.push({ id: tag(entry, "id") || url, title, url, published });
  }
  return posts;
}

export class BlogHerald {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly statePath: string;
  private readonly allowedPrefix: string;

  constructor(private readonly opts: {
    feedUrl: string;
    pollIntervalMin: number;
    maxAgeHours: number;
    maxPostsPerRun: number;
    sinks: SyndicationSink[];
    compose: (post: BlogPost) => string;
    dataDir: string;
    log: Logger;
    audit?: AuditLog;
    fetchFn?: typeof fetch;
    now?: () => number;
  }) {
    this.statePath = join(opts.dataDir, STATE_FILE);
    this.allowedPrefix = new URL("./", opts.feedUrl).href;
  }

  start(): void {
    if (this.timer || this.opts.sinks.length === 0) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), Math.max(5, this.opts.pollIntervalMin) * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const posts = await this.fetchPosts();
      const state = await this.loadState();
      const cutoff = (this.opts.now ?? Date.now)() - this.opts.maxAgeHours * 3_600_000;
      const all = (): Record<string, true> =>
        Object.fromEntries(this.opts.sinks.map((sink) => [sink.name, true as const]));
      let changed = false;
      for (const post of posts) {
        if (Date.parse(post.published) < cutoff && !state.delivered[post.id]) {
          state.delivered[post.id] = all();
          changed = true;
        }
      }
      if (!state.initialized) {
        state.initialized = true;
        changed = true;
        this.opts.log.info("blog relay baseline recorded — older articles not posted", { entries: posts.length });
      }
      if (changed) await this.saveState(state);

      const fresh = posts
        .filter((post) => this.opts.sinks.some((sink) => !state.delivered[post.id]?.[sink.name]))
        .sort((a, b) => Date.parse(a.published) - Date.parse(b.published));
      for (const post of fresh.slice(0, Math.max(1, this.opts.maxPostsPerRun))) {
        const text = this.opts.compose(post);
        for (const sink of this.opts.sinks) {
          if (state.delivered[post.id]?.[sink.name]) continue;
          try {
            await sink.post(text);
            state.delivered[post.id] ??= {};
            state.delivered[post.id]![sink.name] = true;
            await this.saveState(state);
            this.opts.log.info("blog post announced", { sink: sink.name, url: post.url });
            try {
              await this.opts.audit?.append({
                ts: new Date().toISOString(),
                kind: "keryx.blog",
                platform: "system",
                actor: "keryx",
                subject: sink.name,
                data: { url: post.url },
              });
            } catch (err) {
              this.opts.log.debug("blog relay audit failed", { error: String(err) });
            }
          } catch (err) {
            this.opts.log.warn("blog relay sink failed — will retry", {
              sink: sink.name,
              url: post.url,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      this.opts.log.warn("blog feed unavailable", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }

  private async fetchPosts(): Promise<BlogPost[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await (this.opts.fetchFn ?? fetch)(this.opts.feedUrl, {
        headers: { accept: "application/atom+xml, application/xml" },
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error(`blog feed HTTP ${response.status}`);
      const xml = await response.text();
      if (xml.length > MAX_FEED_BYTES) throw new Error("blog feed too large");
      return parseAtomFeed(xml, this.allowedPrefix);
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadState(): Promise<RelayState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as RelayState;
      return parsed?.schema === 1 && parsed.delivered
        ? parsed
        : { schema: 1, initialized: false, delivered: {} };
    } catch {
      return { schema: 1, initialized: false, delivered: {} };
    }
  }

  private async saveState(state: RelayState): Promise<void> {
    await mkdir(this.opts.dataDir, { recursive: true });
    const entries = Object.entries(state.delivered).slice(-2_000);
    const bounded: RelayState = { schema: 1, initialized: state.initialized, delivered: Object.fromEntries(entries) };
    const temporary = this.statePath + ".new";
    await writeFile(temporary, JSON.stringify(bounded), { mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}
