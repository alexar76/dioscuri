/**
 * Demo URL extraction from GitHub README markdown and topic→repo resolution.
 *
 * Demo links live in READMEs (badges, "Live demo:", etc.) — MNEMOSYNE already
 * fetches them; this module turns raw markdown into a per-repo registry entry
 * and later matches content topics to the right demo page for screenshots.
 */

import type { DemoMatch } from "../types.js";
import { tokenize } from "./store.js";

const URL_RE = /https?:\/\/[^\s\])"'<>]+/gi;

/** URLs that are never product demo pages. */
const SKIP_URL = [
  /github\.com/i,
  /shields\.io/i,
  /img\.youtube/i,
  /glama\.ai\/mcp/i,
  /\/api\//i,
  /\/admin\//i,
  /build\/\{/i,
  /\/install\/?$/i,
  /discord\.gg/i,
  /t\.me\//i,
  /twitter\.com/i,
  /youtube\.com/i,
];

const DEMO_LINE = /demo|live\s|try\s|playground|visit\s|open\s|launch/i;

/** Extra aliases for topic matching (repo slug → phrases). */
export const REPO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "alien-monitor": ["alien monitor", "observatory", "3d ecosystem"],
  "pulse-terminal": ["pulse terminal", "pulse"],
  argus: ["argus", "personal agent", "arena"],
  aicom: ["ai factory", "ai-factory", "autonomous product pipeline", "factory"],
  platon: ["platon"],
  chronos: ["chronos"],
  lumen: ["lumen", "trust scoring"],
  oracles: ["oracle family", "verifiable oracles", "oracle"],
  "aimarket-oracle-gateway": ["aimarket", "agent economy", "mcp invokes"],
  "aicom-landing": ["landing page", "landing generator"],
};

function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)>\]]+$/, "").trim();
}

function acceptableDemoUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return !SKIP_URL.some((re) => re.test(url));
}

function scoreCandidate(url: string, line: string): number {
  if (!acceptableDemoUrl(url)) return -1;
  let score = 0;
  if (/magic-ai-factory\.com/i.test(url)) score += 12;
  if (DEMO_LINE.test(line)) score += 18;
  if (/^https?:\/\/[^/]+\/?$/i.test(url)) score -= 8;
  const slashes = (url.match(/\//g) ?? []).length;
  if (slashes <= 4) score += 4;
  if (/\/$/.test(url)) score += 2;
  return score;
}

/**
 * Pick the best demo page URL from README markdown, or null when none found.
 * Pure function — safe to unit-test with fixture READMEs.
 */
export function extractDemoUrl(readmeMarkdown: string): string | null {
  const lines = readmeMarkdown.split(/\r?\n/);
  let best: { url: string; score: number } | null = null;

  for (const line of lines) {
    const urls = line.match(URL_RE) ?? [];
    for (const raw of urls) {
      const url = cleanUrl(raw);
      const score = scoreCandidate(url, line);
      if (score < 0) continue;
      if (best === null || score > best.score) best = { url, score };
    }
  }

  // Second pass: any magic-ai-factory page URL anywhere in the doc.
  if (best === null || best.score < 10) {
    for (const raw of readmeMarkdown.match(URL_RE) ?? []) {
      const url = cleanUrl(raw);
      const score = scoreCandidate(url, "");
      if (score < 0) continue;
      if (/magic-ai-factory\.com/i.test(url)) {
        const boosted = score + 5;
        if (best === null || boosted > best.score) best = { url, score: boosted };
      }
    }
  }

  return best?.url ?? null;
}

/**
 * Match a content topic to a repo demo URL from the registry.
 * Returns null when no repo scores high enough (generic topics, no demo).
 */
export function resolveDemoForTopic(
  topic: string,
  registry: ReadonlyMap<string, string>,
): DemoMatch | null {
  if (registry.size === 0) return null;
  const t = topic.toLowerCase();
  let best: { repo: string; url: string; score: number } | null = null;

  for (const [repo, url] of registry) {
    let score = 0;
    const repoNorm = repo.replace(/[-_]/g, " ").toLowerCase();
    if (t.includes(repoNorm)) score += 22;
    if (t.includes(repo.replace(/_/g, "-").toLowerCase())) score += 22;
    for (const alias of REPO_ALIASES[repo] ?? []) {
      if (t.includes(alias.toLowerCase())) score += 16;
    }
    const topicToks = new Set(tokenize(topic));
    for (const tok of tokenize(repoNorm)) {
      if (tok.length >= 4 && topicToks.has(tok)) score += 6;
    }
    if (score <= 0) continue;
    if (best === null || score > best.score) best = { repo, url, score };
  }

  return best !== null && best.score >= 10 ? { repo: best.repo, url: best.url } : null;
}
