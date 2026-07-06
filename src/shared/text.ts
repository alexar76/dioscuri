/**
 * Shared text utilities — one source of truth for link normalisation, invite
 * filtering, length capping, and whitespace cleanup used across the codebase.
 *
 * These functions were previously duplicated in 5+ files (brain, moderation,
 * theoxenia generator, bluesky, mastodon, x). Extracted here so a single fix
 * benefits every call site.
 */

import type { CrossLinks } from "../types.js";

// ---------------------------------------------------------------------------
// Invite / link regex and helpers
// ---------------------------------------------------------------------------

/** discord.gg / discord.com/invite / t.me links, scheme optional. */
export const INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite|t\.me)\/[A-Za-z0-9_\-+]+/gi;

/** Explicit links (scheme-ful or www.) for allow/deny hostname checks. */
export const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

/** Strip protocol/www/trailing slashes and canonicalise discord invite hosts. */
export function normalizeLink(s: string): string {
  return s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/^discord\.com\/invite\//, "discord.gg/")
    .replace(/\/+$/, "");
}

/**
 * Replace discord.gg / t.me invites that are NOT the official links.
 * @param replacement — "[link removed]" (brain), "" (generator/moderation), etc.
 */
export function stripForeignInvites(
  text: string,
  links: CrossLinks,
  replacement: string,
): string {
  const allowed = [links.discordInvite, links.telegramChannel]
    .filter((l) => l !== "")
    .map(normalizeLink);
  return text.replace(INVITE_RE, (m) =>
    allowed.includes(normalizeLink(m)) ? m : replacement,
  );
}

// ---------------------------------------------------------------------------
// Length capping
// ---------------------------------------------------------------------------

/**
 * Cap at `max` chars, preferring a sentence boundary; append "…".
 * Hard-cut only when the nearest boundary would throw away over half the text.
 */
export function truncateChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1); // reserve one char for the ellipsis
  let cut = -1;
  for (let i = slice.length - 1; i >= 0; i--) {
    const ch = slice.charAt(i);
    if (ch === "." || ch === "!" || ch === "?" || ch === "…" || ch === "\n") {
      cut = i + 1;
      break;
    }
  }
  // A boundary in the first half means throwing away too much — hard cut instead.
  const kept = cut >= (max - 1) / 2 ? slice.slice(0, cut) : slice;
  return kept.trimEnd() + "…";
}

/** Split into user-perceived characters (emoji-safe). */
export function graphemes(s: string): string[] {
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  return Array.from(seg.segment(s), (g) => g.segment);
}

/**
 * Cap at `max` graphemes, preferring a sentence boundary; append "…".
 * Hard-cut only when the nearest boundary would throw away over half the text.
 */
export function truncateGraphemes(text: string, max: number): string {
  const g = graphemes(text);
  if (g.length <= max) return text;
  const slice = g.slice(0, max - 1); // reserve one grapheme for the ellipsis
  let cut = -1;
  for (let i = slice.length - 1; i >= 0; i--) {
    const ch = slice[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "…" || ch === "\n") {
      cut = i + 1;
      break;
    }
  }
  const kept = cut >= (max - 1) / 2 ? slice.slice(0, cut) : slice;
  return kept.join("").trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Whitespace
// ---------------------------------------------------------------------------

/** Collapse space/tab runs, trim line edges, cap blank runs at one empty line. */
export function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
