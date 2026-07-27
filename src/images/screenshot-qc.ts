/**
 * Client-side PNG QC — defence in depth after the sidecar returns bytes.
 * Rejects tiny, corrupt, uniform, or overwhelmingly dark frames.
 */

export interface ScreenshotQcResult {
  ok: boolean;
  reason?: string;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_BYTES = 50_000;
const MAX_BYTES = 8_000_000;

export function validatePngScreenshot(buf: Buffer): ScreenshotQcResult {
  if (buf.length < MIN_BYTES) {
    return { ok: false, reason: `too small (${buf.length} bytes, need ≥${MIN_BYTES})` };
  }
  if (buf.length > MAX_BYTES) {
    return { ok: false, reason: `too large (${buf.length} bytes)` };
  }
  if (!buf.subarray(0, 8).equals(PNG_SIG)) {
    return { ok: false, reason: "not a PNG" };
  }

  const dims = readPngDimensions(buf);
  if (dims === null) {
    return { ok: false, reason: "corrupt PNG (no IHDR chunk)" };
  }
  if (dims.width < 640 || dims.height < 360) {
    return { ok: false, reason: `viewport too small (${dims.width}x${dims.height})` };
  }

  if (isMostlyUniform(buf)) {
    return { ok: false, reason: "mostly uniform (blank frame)" };
  }
  if (isMostlyDark(buf)) {
    return { ok: false, reason: "mostly dark (empty or loading shell)" };
  }

  return { ok: true };
}

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Sample compressed IDAT bytes — cheap uniformity proxy (matches sidecar idea). */
function isMostlyUniform(buf: Buffer): boolean {
  const idat = extractIdat(buf);
  if (idat.length < 500) return true;
  const step = Math.max(400, Math.floor(idat.length / 200));
  const samples: number[] = [];
  for (let i = 0; i < idat.length && samples.length < 200; i += step) {
    samples.push(idat[i]!);
  }
  if (samples.length === 0) return true;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const close = samples.filter((v) => Math.abs(v - mean) < 8).length;
  return close / samples.length >= 0.92;
}

/** Dark UI shells: most byte samples in IDAT stream are very low. */
function isMostlyDark(buf: Buffer): boolean {
  const idat = extractIdat(buf);
  if (idat.length < 500) return true;
  const step = Math.max(200, Math.floor(idat.length / 300));
  let dark = 0;
  let total = 0;
  for (let i = 0; i < idat.length && total < 300; i += step) {
    total++;
    if (idat[i]! < 28) dark++;
  }
  return total > 0 && dark / total >= 0.78;
}

function extractIdat(buf: Buffer): Buffer {
  let pos = 8;
  const parts: Buffer[] = [];
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IDAT") parts.push(data);
    pos += 12 + length;
  }
  return Buffer.concat(parts);
}
