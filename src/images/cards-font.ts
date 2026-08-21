/**
 * Embed Noto Sans (Latin + Cyrillic) for sharp/librsvg — system fonts often
 * lack Cyrillic glyphs, which shows up in Discord as □□□ boxes.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let cachedFontDefs: string | null = null;

const FONT_FILES = [
  "noto-sans-latin-400-normal.woff2",
  "noto-sans-cyrillic-400-normal.woff2",
] as const;

export const SVG_FONT_FAMILY = "'Noto Sans', ui-sans-serif, system-ui, sans-serif";

/** Inline @font-face rules for SVG `<defs>` (empty when fonts unavailable). */
export function svgFontDefs(): string {
  if (cachedFontDefs !== null) return cachedFontDefs;
  try {
    const req = createRequire(import.meta.url);
    const faces = FONT_FILES.map((name) => {
      const path = req.resolve(`@fontsource/noto-sans/files/${name}`);
      const b64 = readFileSync(path).toString("base64");
      return (
        `@font-face{font-family:'Noto Sans';font-weight:400;font-style:normal;` +
        `src:url(data:font/woff2;base64,${b64}) format('woff2');font-display:swap;}`
      );
    });
    cachedFontDefs = faces.join("");
  } catch {
    cachedFontDefs = "";
  }
  return cachedFontDefs;
}
