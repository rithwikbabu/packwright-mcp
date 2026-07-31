import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodePng, encodePng, normalizePng, type PixelImage } from '../../src/visual/png.js';

function fixture(): PixelImage {
  return {
    width: 2,
    height: 2,
    data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 255, 255, 255, 0]),
  };
}

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return output;
}

describe('dedicated PNG handling', () => {
  it('encodes deterministic RGBA PNGs and decodes their exact pixels', () => {
    const first = encodePng(fixture());
    const second = encodePng(fixture());
    const decoded = decodePng(first);

    expect(second).toEqual(first);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.data).toEqual(fixture().data);
    expect(decoded.sourceSha256).toBe(createHash('sha256').update(first).digest('hex'));
  });

  it('verifies chunk CRCs and rejects dimensions or decoded sizes over configured limits', () => {
    const encoded = encodePng(fixture());
    const corrupted = Buffer.from(encoded);
    corrupted[corrupted.length - 5] = (corrupted[corrupted.length - 5] ?? 0) ^ 1;

    expect(() => decodePng(corrupted)).toThrow(/CRC/u);
    expect(() => decodePng(encoded, { maxWidth: 1 })).toThrow(/dimensions/u);
    expect(() => decodePng(encoded, { maxDecodedBytes: 15 })).toThrow(/decoded/u);
    expect(() => decodePng(Buffer.concat([encoded, Buffer.from([0])]))).toThrow(/after its IEND/u);

    const misleadingHeader = Buffer.from(encoded);
    misleadingHeader.writeUInt32BE(1, 16);
    misleadingHeader.writeUInt32BE(1, 20);
    misleadingHeader.writeUInt32BE(crc32(misleadingHeader.subarray(12, 29)), 29);
    expect(() => decodePng(misleadingHeader)).toThrow(/decompress/u);
  });

  it('strips ancillary metadata and re-encodes canonical bytes', () => {
    const encoded = encodePng(fixture());
    const headerEnd = 8 + 12 + 13;
    const withText = Buffer.concat([
      encoded.subarray(0, headerEnd),
      chunk('tEXt', Buffer.from('Author\0Packwright', 'latin1')),
      encoded.subarray(headerEnd),
    ]);

    const normalized = normalizePng(withText);

    expect(normalized.strippedMetadata).toBe(true);
    expect(normalized.png).toEqual(encoded);
    expect(decodePng(normalized.png).hadAncillaryChunks).toBe(false);
  });

  it('rejects malformed pixels before encoding', () => {
    expect(() => encodePng({ width: 2, height: 2, data: Buffer.alloc(15) })).toThrow(
      /expected 16/u,
    );
  });
});
