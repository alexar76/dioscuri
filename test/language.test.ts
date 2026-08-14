/** Tests for src/core/language.ts — detection heuristics and canned lines. */

import { describe, expect, it } from "vitest";
import {
  deflectionLine,
  detectLanguage,
  rateLimitLine,
  refusalLine,
  unavailableLine,
} from "../src/core/language.js";

describe("detectLanguage", () => {
  it("detects Russian via cyrillic-letter ratio", () => {
    expect(detectLanguage("Как установить фабрику?")).toBe("ru");
    expect(detectLanguage("а что такое AIMarket?")).toBe("ru");
  });

  it("does not flag mostly-latin text with a stray cyrillic letter as ru", () => {
    // 1 cyrillic letter out of many latin ones — ratio well under 0.25.
    expect(detectLanguage("please install the factory now д thanks a lot")).toBe("en");
  });

  it("detects Spanish via special characters", () => {
    expect(detectLanguage("¿Se puede instalar en Windows?")).toBe("es");
    expect(detectLanguage("mañana lo pruebo")).toBe("es");
  });

  it("detects Spanish via two common words", () => {
    expect(detectLanguage("hola, gracias por el bot")).toBe("es");
    expect(detectLanguage("explica esto por favor, gracias")).toBe("es");
  });

  it("one common Spanish word alone is not enough", () => {
    // "para" appears in many contexts; a single hit stays English.
    expect(detectLanguage("what does para mean in the config")).toBe("en");
  });

  it("defaults to English", () => {
    expect(detectLanguage("How do I run the oracle locally?")).toBe("en");
    expect(detectLanguage("")).toBe("en");
    expect(detectLanguage("1234 !!! ???")).toBe("en");
  });
});

describe("canned lines", () => {
  it("returns language-specific lines for ru/es and English otherwise", () => {
    for (const fn of [refusalLine, rateLimitLine, unavailableLine, deflectionLine]) {
      const en = fn("en");
      expect(fn("ru")).not.toBe(en);
      expect(fn("es")).not.toBe(en);
      expect(fn("other")).toBe(en); // fallback
      // Russian line actually contains cyrillic; Spanish contains none.
      expect(/\p{Script=Cyrillic}/u.test(fn("ru"))).toBe(true);
      expect(/\p{Script=Cyrillic}/u.test(fn("es"))).toBe(false);
    }
  });

  it("refusal line asks for plain language, not model-control commands", () => {
    expect(refusalLine("en")).toMatch(/safety filter/i);
    expect(refusalLine("en")).toMatch(/plain language/i);
  });
});
