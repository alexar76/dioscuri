/**
 * KERYX — dev.to monthly digest, POST-ONLY by charter.
 *
 * Builds ONE deterministic longform markdown article straight from MNEMOSYNE
 * — no LLM anywhere in this path, so a hostile README can at worst read
 * strangely, never steer anything. Publishes to OUR OWN dev.to account via
 * the Forem API. No comments, follows, reactions, or reading other articles.
 *
 * Article recipe (pure function of the KB + clock):
 *  - release chunks (source "release") updated within the last 31 days of
 *    `now`, grouped by repo — tag, first 2 sentences, link;
 *  - per-repo "Fresh commits" bullets (max 8) from the repo's
 *    "... recent changes" doc chunks;
 *  - static intro (the twins + both channel links) and footer
 *    (site/github/discord/telegram + provenance line).
 *
 * A quiet month publishes NOTHING: no releases in the window → log info,
 * return false, zero HTTP calls. Low volume by design.
 *
 * Fail-soft: any HTTP/network failure logs a warning (api key scrubbed) and
 * returns false — it never propagates to the twins' main loop. Timeout 30s.
 */

import type { CrossLinks, KnowledgeChunk, Logger, Mnemosyne } from "../types.js";

const TIMEOUT_MS = 30_000;
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const SEARCH_K = 24;
const MAX_COMMIT_BULLETS = 8;
const DEVTO_ARTICLES_URL = "https://dev.to/api/articles";
const TAGS = ["ai", "opensource", "agents", "showcase"];

/** First `n` sentences of a chunk, single-line, capped for an article bullet. */
function firstSentences(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  const matches = t.match(/[^.!?]+[.!?]+(?:\s|$)/g);
  const s = matches !== null ? matches.slice(0, n).join("").trim() : t;
  return s.length > 320 ? s.slice(0, 319) + "…" : s;
}

/** Non-empty lines of a recent-changes doc chunk, bullets normalised. */
function commitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^[-•*]\s*/, ""))
    .filter((l) => l !== "");
}

function monthLabel(now: Date): string {
  const month = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} ${now.getUTCFullYear()}`;
}

export function createDevtoDigest(opts: {
  apiKey: string;
  kb: Mnemosyne;
  links: CrossLinks;
  log: Logger;
  fetchFn?: typeof fetch;
}): { publishMonthly(now: Date): Promise<boolean> } {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log.child("devto");

  const scrub = (msg: string): string =>
    opts.apiKey === "" ? msg : msg.split(opts.apiKey).join("***");

  function collectReleases(now: Date): KnowledgeChunk[] {
    const cutoff = now.getTime() - WINDOW_MS;
    const seen = new Set<string>();
    return opts.kb
      .search("release update version", SEARCH_K)
      .map((h) => h.chunk)
      .filter((c) => {
        if (c.source !== "release") return false;
        const ts = Date.parse(c.updatedAt);
        if (!Number.isFinite(ts) || ts < cutoff || ts > now.getTime()) return false;
        const key = `${c.repo}#${c.title}`; // one bullet per release tag
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  function collectRecentChanges(): KnowledgeChunk[] {
    return opts.kb
      .search("recent changes commits", SEARCH_K)
      .map((h) => h.chunk)
      .filter((c) => c.source === "doc" && c.title.toLowerCase().endsWith("recent changes"));
  }

  function buildArticle(now: Date, releases: KnowledgeChunk[], changes: KnowledgeChunk[]): {
    title: string;
    body: string;
  } {
    const { links } = opts;
    const byRepo = new Map<string, { releases: KnowledgeChunk[]; commits: string[] }>();
    const bucket = (repo: string): { releases: KnowledgeChunk[]; commits: string[] } => {
      let b = byRepo.get(repo);
      if (b === undefined) {
        b = { releases: [], commits: [] };
        byRepo.set(repo, b);
      }
      return b;
    };
    for (const c of releases) bucket(c.repo).releases.push(c);
    for (const c of changes) {
      const b = bucket(c.repo);
      for (const line of commitLines(c.text)) {
        if (b.commits.length >= MAX_COMMIT_BULLETS) break;
        b.commits.push(line);
      }
    }

    const title = `This month in the AICOM forge — ${monthLabel(now)}`;
    const intro =
      "Every month CASTOR and POLLUX — the DIOSCURI twin community agents — compile what " +
      "actually shipped across the AICOM ecosystem, straight from the release feeds. " +
      `Join the conversation on Discord (${links.discordInvite}) or catch the fast lane on Telegram (${links.telegramChannel}).`;

    const sections: string[] = [];
    for (const repo of [...byRepo.keys()].sort()) {
      const b = byRepo.get(repo);
      if (b === undefined) continue;
      const lines: string[] = [`## ${repo}`, ""];
      for (const r of b.releases) {
        lines.push(`- **${r.title}** — ${firstSentences(r.text, 2)} ([release notes](${r.url}))`);
      }
      if (b.commits.length > 0) {
        if (b.releases.length > 0) lines.push("");
        lines.push("**Fresh commits:**", "");
        for (const c of b.commits) lines.push(`- ${c}`);
      }
      sections.push(lines.join("\n"));
    }

    const footer = [
      "---",
      "",
      `Live demos: ${links.siteUrl} · Code: ${links.githubOrg} · Discord: ${links.discordInvite} · Telegram: ${links.telegramChannel}`,
      "",
      "*Written by DIOSCURI, the twin community agents — post-only automation, human-curated ecosystem.*",
    ].join("\n");

    return { title, body: [intro, "", ...sections.flatMap((s) => [s, ""]), footer].join("\n") };
  }

  return {
    async publishMonthly(now: Date): Promise<boolean> {
      const releases = collectReleases(now);
      if (releases.length === 0) {
        log.info("quiet month — no releases in the 31-day window, publishing nothing");
        return false;
      }
      const { title, body } = buildArticle(now, releases, collectRecentChanges());

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchFn(DEVTO_ARTICLES_URL, {
          method: "POST",
          headers: {
            "api-key": opts.apiKey,
            accept: "application/vnd.forem.api-v1+json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            article: { title, published: true, body_markdown: body, tags: TAGS },
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          log.warn("dev.to publish failed — skipped", { status: res.status });
          return false;
        }
        log.info("dev.to article published", { title, releases: releases.length });
        return true;
      } catch (err) {
        log.warn("dev.to publish failed — skipped", { error: scrub(String(err)) });
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
