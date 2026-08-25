import { describe, expect, it } from "vitest";
import { createScreenshotProvider, ScreenshotProviderError } from "../src/images/screenshots.js";
import { makeFakeQcPng } from "./helpers/fake-png.js";

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
};

describe("createScreenshotProvider", () => {
  it("throws when baseUrl is empty", () => {
    expect(() => createScreenshotProvider({ baseUrl: "", log })).toThrow(ScreenshotProviderError);
  });

  it("POSTs the demo URL to the sidecar and returns PNG bytes", async () => {
    const png = makeFakeQcPng();
    const fetchFn: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:8767/v1/screenshots/capture");
      const body = JSON.parse(init?.body as string);
      expect(body.url).toBe("https://magic-ai-factory.com/monitor/");
      return new Response(png, { status: 200 });
    };
    const provider = createScreenshotProvider({
      baseUrl: "http://127.0.0.1:8767",
      log,
      fetchFn,
    });
    const out = await provider.capture("https://magic-ai-factory.com/monitor/");
    expect(out.equals(png)).toBe(true);
  });

  it("rejects responses smaller than the QC floor", async () => {
    const fetchFn: typeof fetch = async () => new Response(Buffer.alloc(1000, 1), { status: 200 });
    const provider = createScreenshotProvider({
      baseUrl: "http://127.0.0.1:8767",
      log,
      fetchFn,
    });
    await expect(provider.capture("https://example.com")).rejects.toBeInstanceOf(ScreenshotProviderError);
  });
});
