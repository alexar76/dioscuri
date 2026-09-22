/** Fake PNG bytes that pass client-side screenshot QC in unit tests. */
export function makeFakeQcPng(idatSize = 55_000): Buffer {
  const idatData = Buffer.alloc(idatSize);
  for (let i = 0; i < idatData.length; i++) {
    idatData[i] = (i * 37 + (i >> 3)) % 256;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1280, 0);
  ihdr.writeUInt32BE(720, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];

  const chunk = (type: string, data: Buffer): void => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    parts.push(len, Buffer.from(type), data, Buffer.alloc(4));
  };

  chunk("IHDR", ihdr);
  chunk("IDAT", idatData);
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat(parts);
}
