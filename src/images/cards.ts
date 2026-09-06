/**
 * IMAGES/cards — deterministic branded SVG→PNG cards (always available, no AI).
 *
 * buildSvg() is a PURE function (string in → SVG string out, no network, no
 * fs, no clock) so every layout/escaping rule is unit-testable. The only
 * side-effectful piece is SvgCardRenderer, the single place in the codebase
 * where sharp is imported, which rasterises the SVG to a 1200×630 PNG.
 *
 * SECURITY: every payload field is untrusted (release notes and digest lines
 * originate from GitHub-synced text). Each field runs through AEGIS
 * prepareUntrusted (NFKC, control/zero-width strip, fence-marker
 * neutralisation, length cap) and is then XML-escaped, so no payload can ever
 * break out of its <text> element. Overflow is truncated with "…" — the
 * renderer never throws on content.
 *
 * Look: dark cosmic theme (#0b0e1a), a subtle hand-placed Gemini
 * constellation (the twins, of course), a thin Greek-key meander border, and
 * one accent colour per card kind.
 */

import sharp from "sharp";
import { prepareUntrusted } from "../aegis/sanitize.js";
import type { CardKind, CardPayload, CardRenderer } from "../types.js";
import { SVG_FONT_FAMILY, svgFontDefs } from "./cards-font.js";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const DEFAULT_FOOTER = "DIOSCURI — one mind, two heavens";

/** Per-field sanitation caps (chars, applied via prepareUntrusted). */
const LIMITS = { title: 80, subtitle: 120, line: 90, footer: 60 } as const;
const MAX_BODY_LINES = 5;

/** Accent colour per card kind. */
const ACCENTS: Record<CardKind, string> = {
  release: "#f59e0b",
  digest: "#38bdf8",
  banter: "#a78bfa",
  spotlight: "#34d399",
};

/** Glyph + small-caps label shown top-left. */
const LABELS: Record<CardKind, string> = {
  release: "⚒ RELEASE",
  digest: "📜 DIGEST",
  banter: "🌩 BANTER",
  spotlight: "🔭 SPOTLIGHT",
};

/** Escape the five XML-special characters for safe embedding in SVG text. */
function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * AEGIS-sanitise one payload field and ellipsise if it exceeded maxLen.
 * Returns UNescaped text — XML escaping happens at emit time, after
 * word-wrapping (so wrap counts real characters, not entity expansions).
 */
function cleanField(raw: string, maxLen: number): string {
  const t = prepareUntrusted(raw, maxLen + 1); // +1 so overflow is detectable
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/** Hard-split words longer than a line so wrapping can never overflow. */
function chunkWord(word: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxChars) chunks.push(word.slice(i, i + maxChars));
  return chunks;
}

/** Greedy word-wrap; the last permitted line gets "…" when text remains. */
function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text
    .split(/\s+/)
    .filter((w) => w !== "")
    .flatMap((w) => (w.length > maxChars ? chunkWord(w, maxChars) : [w]));
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) {
      const last = lines[maxLines - 1] ?? "";
      lines[maxLines - 1] =
        last.length >= maxChars - 1 ? `${last.slice(0, maxChars - 1)}…` : `${last}…`;
      return lines;
    }
  }
  if (current !== "") lines.push(current);
  return lines.slice(0, maxLines);
}

/**
 * The Gemini constellation, hand-placed: two star stick-figures (Castor left,
 * Pollux right), heads as the bright stars, a faint line where the twins
 * clasp hands. Low opacity so it never fights the text.
 */
function constellation(): string {
  return [
    `<g opacity="0.22" stroke="#8ea2ff" stroke-width="1.2" fill="none">`,
    // Castor: head—shoulders—arms—hip—legs
    `<path d="M905 158 L905 196 M905 196 L868 234 M905 196 L942 228 M905 196 L905 264 M905 264 L878 322 M905 264 L932 318"/>`,
    // Pollux
    `<path d="M1032 148 L1032 190 M1032 190 L995 226 M1032 190 L1070 220 M1032 190 L1032 258 M1032 258 L1006 318 M1032 258 L1058 312"/>`,
    // clasped hands
    `<path d="M942 228 L995 226"/>`,
    `</g>`,
    `<g opacity="0.45" fill="#cdd6ff">`,
    // Castor joints (head star brighter/bigger)
    `<circle cx="905" cy="158" r="5"/><circle cx="905" cy="196" r="2.5"/><circle cx="868" cy="234" r="2.5"/>`,
    `<circle cx="942" cy="228" r="2.5"/><circle cx="905" cy="264" r="2.5"/><circle cx="878" cy="322" r="2.5"/><circle cx="932" cy="318" r="2.5"/>`,
    // Pollux joints
    `<circle cx="1032" cy="148" r="5"/><circle cx="1032" cy="190" r="2.5"/><circle cx="995" cy="226" r="2.5"/>`,
    `<circle cx="1070" cy="220" r="2.5"/><circle cx="1032" cy="258" r="2.5"/><circle cx="1006" cy="318" r="2.5"/><circle cx="1058" cy="312" r="2.5"/>`,
    // scattered background stars
    `<circle cx="790" cy="120" r="1.5"/><circle cx="1120" cy="90" r="1.5"/><circle cx="850" cy="420" r="1.5"/>`,
    `<circle cx="1100" cy="380" r="1.5"/><circle cx="960" cy="70" r="1.5"/><circle cx="740" cy="300" r="1.5"/>`,
    `</g>`,
  ].join("\n");
}

/**
 * Compose the full 1200×630 card SVG. Pure and deterministic: same
 * kind+payload → same string. All payload text is sanitised + escaped here.
 */
export function buildSvg(kind: CardKind, payload: CardPayload): string {
  const accent = ACCENTS[kind];
  const label = LABELS[kind];

  const title = cleanField(payload.title ?? "", LIMITS.title);
  const subtitle = cleanField(payload.subtitle ?? "", LIMITS.subtitle);
  const body = (payload.lines ?? [])
    .slice(0, MAX_BODY_LINES)
    .map((l) => cleanField(l, LIMITS.line))
    .filter((l) => l !== "");
  const footerClean = cleanField(payload.footer ?? "", LIMITS.footer);
  const footer = footerClean === "" ? DEFAULT_FOOTER : footerClean;

  const titleLines = wrapText(title === "" ? "Untitled" : title, 34, 2);
  const subtitleLines = subtitle === "" ? [] : wrapText(subtitle, 62, 2);

  const parts: string[] = [];
  let y = 210;
  for (const line of titleLines) {
    parts.push(
      `<text x="70" y="${y}" font-size="52" font-weight="700" fill="#f3f6ff">${escapeXml(line)}</text>`,
    );
    y += 64;
  }
  y += 6;
  for (const line of subtitleLines) {
    parts.push(`<text x="70" y="${y}" font-size="28" fill="#9fb0d8">${escapeXml(line)}</text>`);
    y += 38;
  }
  y += 16;
  for (const line of body) {
    parts.push(
      `<text x="70" y="${y}" font-size="22" fill="#c9d4ee"><tspan fill="${accent}">▸</tspan> ${escapeXml(line)}</text>`,
    );
    y += 32;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="${SVG_FONT_FAMILY}">`,
    `<defs>`,
    svgFontDefs() ? `<style>${svgFontDefs()}</style>` : "",
    `<radialGradient id="glow" cx="28%" cy="18%" r="95%">`,
    `<stop offset="0%" stop-color="#1a2140"/>`,
    `<stop offset="55%" stop-color="#0f1428"/>`,
    `<stop offset="100%" stop-color="#0b0e1a"/>`,
    `</radialGradient>`,
    // One Greek-key meander tile; strips below repeat it into a border.
    `<pattern id="meander" width="20" height="20" patternUnits="userSpaceOnUse">`,
    `<path d="M1 17 H17 V3 H7 V11 H12" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="1.6"/>`,
    `</pattern>`,
    `</defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#0b0e1a"/>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="url(#glow)"/>`,
    `<rect x="14" y="14" width="1172" height="20" fill="url(#meander)"/>`,
    `<rect x="14" y="596" width="1172" height="20" fill="url(#meander)"/>`,
    `<rect x="14" y="34" width="20" height="562" fill="url(#meander)"/>`,
    `<rect x="1166" y="34" width="20" height="562" fill="url(#meander)"/>`,
    `<rect x="44" y="44" width="1112" height="542" fill="none" stroke="#26304f" stroke-width="1"/>`,
    constellation(),
    `<text x="70" y="102" font-size="26" font-weight="600" letter-spacing="6" fill="${accent}">${escapeXml(label)}</text>`,
    `<rect x="70" y="118" width="130" height="3" rx="1.5" fill="${accent}"/>`,
    ...parts,
    `<text x="1150" y="584" text-anchor="end" font-size="19" letter-spacing="1" fill="#6f7fa8">${escapeXml(footer)}</text>`,
    `</svg>`,
  ].join("\n");
}

/**
 * The one and only sharp touchpoint: SVG → PNG buffer. Content can never
 * make this throw — buildSvg truncates and escapes everything first.
 */
export class SvgCardRenderer implements CardRenderer {
  async renderCard(kind: CardKind, payload: CardPayload): Promise<Buffer> {
    const svg = buildSvg(kind, payload);
    return sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  }
}
