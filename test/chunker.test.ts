/**
 * Tests for src/mnemosyne/chunker.ts — markdown flattening (code fences,
 * HTML, badges, links) and boundary-aware chunking (target/max/overlap,
 * heading splits, oversized-paragraph hard-wrap). Pure functions, no stubs.
 */

import { describe, expect, it } from "vitest";
import { chunkText, markdownToPlain } from "../src/mnemosyne/chunker.js";

describe("markdownToPlain", () => {
  it("replaces fenced code blocks with a one-line placeholder", () => {
    const md = "Intro text.\n\n```js\nconst x = 1;\nsecretPayload();\n```\n\nAfter the code.";
    const out = markdownToPlain(md);
    expect(out).toContain("[code omitted]");
    expect(out).not.toContain("const x = 1");
    expect(out).not.toContain("secretPayload");
    expect(out).toContain("Intro text.");
    expect(out).toContain("After the code.");
  });

  it("handles tilde fences and does not close on the other fence marker", () => {
    const md = "Before.\n\n~~~\ncode line\n``` not a closer\nmore code\n~~~\n\nAfter.";
    const out = markdownToPlain(md);
    expect(out).toContain("[code omitted]");
    expect(out).not.toContain("code line");
    expect(out).not.toContain("more code");
    expect(out).toContain("After.");
  });

  it("an unterminated fence swallows the rest of the document", () => {
    const md = "Visible.\n\n```\nhidden instructions forever";
    const out = markdownToPlain(md);
    expect(out).toContain("Visible.");
    expect(out).toContain("[code omitted]");
    expect(out).not.toContain("hidden instructions");
  });

  it("strips HTML tags and comments but keeps their inner text", () => {
    const md = '<div align="center"><b>Bold claim</b></div>\n<!-- secret comment -->\nPlain <em>emphasis</em> stays.';
    const out = markdownToPlain(md);
    expect(out).toContain("Bold claim");
    expect(out).toContain("Plain emphasis stays.");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<div");
    expect(out).not.toContain("secret comment");
  });

  it("drops badge/image-only lines entirely", () => {
    const md = [
      "# Project",
      "[![Build](https://img.shields.io/badge/build-passing-green)](https://ci.example.com)",
      "![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/badge/v-1.0-red)",
      "",
      "Real description here.",
    ].join("\n");
    const out = markdownToPlain(md);
    expect(out).toContain("# Project");
    expect(out).toContain("Real description here.");
    expect(out).not.toContain("shields.io");
    expect(out).not.toContain("Build");
    expect(out).not.toContain("License");
  });

  it("keeps anchor text for links and alt text for inline images", () => {
    const md = "See [the docs](https://example.com/docs) and ![diagram](img.png) plus [ref link][1].\n\n[1]: https://example.com";
    const out = markdownToPlain(md);
    expect(out).toContain("See the docs and diagram plus ref link.");
    expect(out).not.toContain("https://example.com/docs");
    expect(out).not.toContain("img.png");
    expect(out).not.toContain("[1]:");
  });

  it("unwraps autolinks, inline code and emphasis markers", () => {
    const md = "Visit <https://example.com> then run `npm install` for **great** ~~old~~ results.";
    const out = markdownToPlain(md);
    expect(out).toBe("Visit https://example.com then run npm install for great old results.");
  });
});

describe("chunkText", () => {
  const para = (word: string, repeats: number): string => `${word} `.repeat(repeats).trim();

  it("returns short text as a single chunk", () => {
    const chunks = chunkText("Just one short paragraph.");
    expect(chunks).toEqual(["Just one short paragraph."]);
  });

  it("returns nothing for empty/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n  ")).toEqual([]);
  });

  it("splits on paragraph boundaries near the target and caps at max", () => {
    // Four ~500-char paragraphs → two chunks with default target=1400.
    const text = [para("alpha1", 83), para("bravo2", 83), para("charl3", 83), para("delta4", 83)].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
    expect(chunks[0]).toContain("alpha1");
    expect(chunks[0]).toContain("bravo2");
    expect(chunks[1]).toContain("charl3");
    expect(chunks[1]).toContain("delta4");
  });

  it("carries an overlap tail from one chunk into the next", () => {
    const text = [para("alpha1", 83), para("bravo2", 83), para("charl3", 83), para("delta4", 83)].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const carry = chunks[1]!.split("\n\n")[0]!;
    expect(carry.length).toBeGreaterThan(0);
    expect(carry.length).toBeLessThanOrEqual(120);
    expect(chunks[0]!.endsWith(carry)).toBe(true);
  });

  it("hard-wraps an oversized paragraph on word boundaries", () => {
    const text = para("lorem", 1000); // ~6000 chars, no paragraph breaks
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1600);
      // Word-snapped: no chunk starts or ends mid-word ("orem…" / "…lor").
      expect(c.startsWith("lorem")).toBe(true);
      expect(c.endsWith("lorem")).toBe(true);
    }
  });

  it("starts a new block at a heading even without a blank line", () => {
    const text = `${para("intro", 130)}\n# Section Two\nsecond part words here`;
    const chunks = chunkText(text, { target: 800, max: 900, overlap: 0 });
    expect(chunks.length).toBe(2);
    expect(chunks[1]!.startsWith("# Section Two")).toBe(true);
    expect(chunks[1]).toContain("second part words here");
  });
});
