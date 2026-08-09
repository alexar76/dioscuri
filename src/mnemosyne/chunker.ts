/**
 * MNEMOSYNE / chunker — markdown → retrieval-sized plain-text chunks.
 *
 * Pure functions, no I/O, no dependencies. Two jobs:
 *
 *  1. markdownToPlain(md): flatten GitHub markdown into plain text a lexical
 *     index can digest. Fenced code blocks are REMOVED (a one-line
 *     "[code omitted]" placeholder remains) — code is both noisy for BM25 and
 *     a classic injection-payload hiding spot. HTML tags, comments and
 *     badge/image-only lines are stripped; link syntax keeps its anchor text.
 *
 *  2. chunkText(text, {target, max, overlap}): split on heading/paragraph
 *     boundaries into chunks of ~target chars (hard cap max, which matches
 *     the KnowledgeChunk contract of <=1600 chars). Oversized paragraphs are
 *     hard-wrapped on word boundaries. Consecutive chunks share an `overlap`
 *     tail so a sentence cut at a boundary is still retrievable.
 *
 * Output here is STILL UNTRUSTED — every chunk must pass AEGIS inspection
 * before it may enter the KnowledgeStore (see github-sync.ts).
 */

/** Flatten markdown to plain text; code blocks become "[code omitted]". */
export function markdownToPlain(md: string): string {
  const text = (md ?? "").replace(/\r\n?/g, "\n");

  // Pass 1 — fence state machine (``` / ~~~), keeps a single placeholder line.
  const kept: string[] = [];
  let fenceChar: "`" | "~" | null = null;
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const ch = fence[1]!.startsWith("`") ? "`" : "~";
      if (fenceChar === null) {
        fenceChar = ch;
        kept.push("[code omitted]");
      } else if (ch === fenceChar) {
        fenceChar = null;
      }
      // A different fence marker inside an open fence is just code content.
      continue;
    }
    if (fenceChar !== null) continue; // unterminated fences swallow the rest
    kept.push(line);
  }

  // Pass 2 — whole-text cleanups that may span lines.
  const noComments = kept.join("\n").replace(/<!--[\s\S]*?-->/g, "");

  // Pass 3 — per-line: drop badge/image-only + reference-definition lines,
  // then unwrap the markdown syntax on what is left.
  const lines = noComments
    .split("\n")
    .filter((l) => !isBadgeOrImageLine(l) && !isLinkDefinitionLine(l))
    .map(transformLine);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** True for lines that are nothing but badges/images (shields.io rows etc.). */
function isBadgeOrImageLine(line: string): boolean {
  if (!/!\[|<img\b/i.test(line)) return false;
  const rest = line
    .replace(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\([^)]*\)/g, "") // [![alt](img)](link)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // ![alt](img)
    .replace(/<img\b[^>]*\/?>/gi, "")
    .trim();
  return rest === "" || /^[\s|:.•·\-–—]*$/.test(rest);
}

/** True for reference-style link definitions: `[label]: https://…`. */
function isLinkDefinitionLine(line: string): boolean {
  return /^\s*\[[^\]]+\]:\s+\S+/.test(line);
}

/** Unwrap inline markdown/HTML on a single line, keeping human text. */
function transformLine(line: string): string {
  return line
    .replace(/\[\s*!\[([^\]]*)\]\([^)]*\)\s*\]\([^)]*\)/g, "$1") // linked image → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // image → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [text](url) → text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // [text][ref] → text
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1") // autolink → bare URL
    .replace(/<\/?[a-zA-Z][^>]*>/g, "") // HTML tags
    .replace(/`([^`]*)`/g, "$1") // inline code → content
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/~~([^~]+)~~/g, "$1") // ~~strike~~
    .trimEnd();
}

export interface ChunkOptions {
  /** Soft chunk size in chars — flush once the next block would exceed it. */
  target?: number;
  /** Hard ceiling per chunk (KnowledgeChunk contract: ~<=1600). */
  max?: number;
  /** Tail of the previous chunk carried into the next one. */
  overlap?: number;
}

/**
 * Split plain text into retrieval chunks on heading/paragraph boundaries.
 * Paragraphs longer than `max` are hard-wrapped at word boundaries.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const target = Math.max(200, opts.target ?? 1400);
  const max = Math.max(target, opts.max ?? 1600);
  const overlap = Math.max(0, Math.min(opts.overlap ?? 120, Math.floor(target / 2)));

  const chunks: string[] = [];
  let cur = "";
  const flush = (): void => {
    const t = cur.trim();
    if (t.length > 0) chunks.push(t);
  };

  for (const block of splitBlocks(text)) {
    const pieces = block.length > max ? hardWrap(block, target, overlap) : [block];
    for (const piece of pieces) {
      if (cur.length > 0 && cur.length + piece.length + 2 > target) {
        flush();
        const carry = tail(cur, overlap);
        cur = carry.length > 0 && carry.length + piece.length + 2 <= max ? `${carry}\n\n${piece}` : piece;
      } else {
        cur = cur.length > 0 ? `${cur}\n\n${piece}` : piece;
      }
    }
  }
  flush();
  return chunks;
}

/** Paragraphs (blank-line separated); heading lines always start a new block. */
function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const trimmed = para.trim();
    if (trimmed.length === 0) continue;
    let buf: string[] = [];
    for (const line of trimmed.split("\n")) {
      if (/^#{1,6}\s/.test(line) && buf.length > 0) {
        blocks.push(buf.join("\n"));
        buf = [line];
      } else {
        buf.push(line);
      }
    }
    if (buf.length > 0) blocks.push(buf.join("\n"));
  }
  return blocks;
}

/** Hard-wrap one oversized block into <=target pieces, word-snapped, overlapped. */
function hardWrap(s: string, target: number, overlap: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(start + target, s.length);
    if (end < s.length) {
      // Snap back to the last whitespace in the second half of the window.
      for (let i = end - start - 1; i > target / 2; i--) {
        const ch = s.charAt(start + i);
        if (ch === " " || ch === "\n" || ch === "\t") {
          end = start + i;
          break;
        }
      }
    }
    const piece = s.slice(start, end).trim();
    if (piece.length > 0) pieces.push(piece);
    if (end >= s.length) break;
    start = Math.max(end - overlap, start + 1); // always advances
  }
  return pieces;
}

/** Last <=n chars of s, snapped forward to a word boundary and trimmed. */
function tail(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s.trim();
  const slice = s.slice(s.length - n);
  const ws = slice.search(/\s/);
  return (ws === -1 ? slice : slice.slice(ws)).trim();
}
