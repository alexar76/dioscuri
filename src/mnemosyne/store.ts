/**
 * MNEMOSYNE / KnowledgeStore — in-memory chunk store with a BM25 inverted
 * index and JSON persistence.
 *
 *  - Tokenizer: lowercase unicode letter/digit runs of >=2 chars (\p{L}\p{N},
 *    so latin AND cyrillic queries both work).
 *  - Ranking: BM25 (k1=1.4, b=0.75) with a small per-source boost
 *    (readme x1.15, release x1.1, doc x1.05) so authoritative docs win ties.
 *  - replaceRepo() swaps a repo's chunks atomically; the inverted index is
 *    rebuilt lazily on the next search (corpus is small: hundreds of chunks).
 *  - persist()/load(): single JSON file written atomically (tmp + rename);
 *    a missing or corrupt file on load is tolerated (fresh empty store).
 *    The file also carries `seenReleases` ("repo@tag" ids) so release
 *    announcements never double-fire across restarts.
 *
 * Only AEGIS-sanitised text may be stored here — sanitation happens upstream
 * (github-sync.ts); this class treats chunk text as opaque data.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { KnowledgeChunk, KnowledgeSource, RetrievalHit } from "../types.js";

const K1 = 1.4;
const B = 0.75;

const SOURCE_BOOST: Record<KnowledgeSource, number> = {
  live: 1.2, // freshest wins "what's happening now" ties
  readme: 1.15,
  release: 1.1,
  doc: 1.05,
  "repo-meta": 1,
};

const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;

/** Lowercase unicode letter/digit runs of >=2 chars (latin + cyrillic). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

const SOURCES = new Set<string>(["readme", "release", "repo-meta", "doc"]);

function isChunk(v: unknown): v is KnowledgeChunk {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.repo === "string" &&
    typeof o.source === "string" &&
    SOURCES.has(o.source) &&
    typeof o.title === "string" &&
    typeof o.url === "string" &&
    typeof o.text === "string" &&
    typeof o.updatedAt === "string"
  );
}

interface PersistShapeV1 {
  version: 1;
  chunks: KnowledgeChunk[];
  seenReleases: string[];
}

interface PersistShapeV2 {
  version: 2;
  chunks: KnowledgeChunk[];
  seenReleases: string[];
  demoUrls?: Record<string, string>;
}

type PersistShape = PersistShapeV1 | PersistShapeV2;

export class KnowledgeStore {
  private byRepo = new Map<string, KnowledgeChunk[]>();
  private seenReleases = new Set<string>();
  private demoUrls = new Map<string, string>();

  // Inverted index (rebuilt lazily after mutations).
  private chunkById = new Map<string, KnowledgeChunk>();
  private postings = new Map<string, Map<string, number>>(); // term → id → tf
  private docLen = new Map<string, number>();
  private avgDocLen = 0;
  private dirty = true;

  /** Replace ALL chunks of `repo` in one shot (empty array removes the repo). */
  replaceRepo(repo: string, chunks: KnowledgeChunk[]): void {
    if (chunks.length === 0) this.byRepo.delete(repo);
    else this.byRepo.set(repo, [...chunks]);
    this.dirty = true;
  }

  /** BM25 retrieval with per-source boosts. Deterministic; never calls a model. */
  search(query: string, k: number): RetrievalHit[] {
    if (this.dirty) this.rebuild();
    if (k <= 0 || this.chunkById.size === 0) return [];
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const n = this.chunkById.size;
    const scores = new Map<string, number>();
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [docId, tf] of posting) {
        const dl = this.docLen.get(docId) ?? 0;
        const denom = tf + K1 * (1 - B + (B * dl) / (this.avgDocLen || 1));
        scores.set(docId, (scores.get(docId) ?? 0) + idf * ((tf * (K1 + 1)) / denom));
      }
    }

    const hits: RetrievalHit[] = [];
    for (const [docId, raw] of scores) {
      const chunk = this.chunkById.get(docId);
      if (!chunk) continue;
      hits.push({ chunk, score: raw * (SOURCE_BOOST[chunk.source] ?? 1) });
    }
    hits.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
    return hits.slice(0, k);
  }

  chunkCount(): number {
    let total = 0;
    for (const list of this.byRepo.values()) total += list.length;
    return total;
  }

  repoCount(): number {
    return this.byRepo.size;
  }

  /** True only when there are no chunks AND no seen releases (very first run). */
  isEmpty(): boolean {
    return this.byRepo.size === 0 && this.seenReleases.size === 0;
  }

  hasSeenRelease(id: string): boolean {
    return this.seenReleases.has(id);
  }

  markReleaseSeen(id: string): void {
    this.seenReleases.add(id);
  }

  seenReleaseCount(): number {
    return this.seenReleases.size;
  }

  /** Demo page URL extracted from a repo README (repo slug → https URL). */
  setDemoUrl(repo: string, url: string | null): void {
    if (url === null || url === "") this.demoUrls.delete(repo);
    else this.demoUrls.set(repo, url);
  }

  getDemoUrl(repo: string): string | undefined {
    return this.demoUrls.get(repo);
  }

  allDemoUrls(): ReadonlyMap<string, string> {
    return this.demoUrls;
  }

  /** Atomic JSON write: tmp file + rename, parent dir created on demand.
   *  Non-blocking — use on hot paths (every KB sync). */
  async persist(path: string): Promise<void> {
    const payload: PersistShapeV2 = {
      version: 2,
      chunks: [...this.byRepo.values()].flat(),
      seenReleases: [...this.seenReleases].sort(),
      demoUrls: Object.fromEntries([...this.demoUrls.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), "utf8");
    await rename(tmp, path);
  }

  /**
   * Load a persisted snapshot. Missing or corrupt files are tolerated: the
   * store stays usable (empty) and false is returned. Unknown/invalid chunk
   * entries are skipped individually.
   */
  load(path: string): boolean {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return false; // missing file — fresh store
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return false; // corrupt file — fresh store
    }
    if (typeof data !== "object" || data === null) return false;
    const o = data as Record<string, unknown>;

    const byRepo = new Map<string, KnowledgeChunk[]>();
    if (Array.isArray(o.chunks)) {
      for (const c of o.chunks) {
        if (!isChunk(c)) continue;
        const list = byRepo.get(c.repo) ?? [];
        list.push(c);
        byRepo.set(c.repo, list);
      }
    }
    const seen = Array.isArray(o.seenReleases)
      ? o.seenReleases.filter((s): s is string => typeof s === "string")
      : [];

    const demoUrls = new Map<string, string>();
    const rawDemos = o["demoUrls"];
    if (rawDemos && typeof rawDemos === "object" && !Array.isArray(rawDemos)) {
      for (const [repo, url] of Object.entries(rawDemos as Record<string, unknown>)) {
        if (typeof repo === "string" && typeof url === "string" && url.startsWith("http")) {
          demoUrls.set(repo, url);
        }
      }
    }

    this.byRepo = byRepo;
    this.seenReleases = new Set(seen);
    this.demoUrls = demoUrls;
    this.dirty = true;
    return true;
  }

  /** Full index rebuild — O(total tokens); corpus is small by design. */
  private rebuild(): void {
    this.chunkById.clear();
    this.postings.clear();
    this.docLen.clear();
    let totalLen = 0;
    for (const list of this.byRepo.values()) {
      for (const chunk of list) {
        this.chunkById.set(chunk.id, chunk);
        const terms = tokenize(`${chunk.title} ${chunk.repo} ${chunk.text}`);
        this.docLen.set(chunk.id, terms.length);
        totalLen += terms.length;
        for (const term of terms) {
          let posting = this.postings.get(term);
          if (!posting) {
            posting = new Map<string, number>();
            this.postings.set(term, posting);
          }
          posting.set(chunk.id, (posting.get(chunk.id) ?? 0) + 1);
        }
      }
    }
    this.avgDocLen = this.docLen.size > 0 ? totalLen / this.docLen.size : 0;
    this.dirty = false;
  }
}
