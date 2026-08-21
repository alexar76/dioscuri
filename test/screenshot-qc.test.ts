import { describe, expect, it } from "vitest";
import { validatePngScreenshot } from "../src/images/screenshot-qc.js";
import { makeFakeQcPng } from "./helpers/fake-png.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakePng(width: number, height: number, bodyFill: number, size = 60_000): Buffer {
  const buf = makeFakeQcPng(size);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  if (bodyFill !== 0) {
    for (let i = 32; i < buf.length; i++) buf[i] = bodyFill;
  }
  return buf;
}

describe("validatePngScreenshot", () => {
  it("rejects tiny buffers", () => {
    expect(validatePngScreenshot(Buffer.from("tiny")).ok).toBe(false);
  });

  it("accepts a well-sized PNG with varied bytes", () => {
    expect(validatePngScreenshot(makeFakeQcPng()).ok).toBe(true);
  });

  it("rejects uniform blank frames", () => {
    const buf = fakePng(1280, 720, 200);
    buf.fill(200, 32);
    expect(validatePngScreenshot(buf).ok).toBe(false);
  });

  it("rejects mostly dark frames", () => {
    const buf = fakePng(1280, 720, 5);
    buf.fill(5, 32);
    expect(validatePngScreenshot(buf).ok).toBe(false);
  });
});
