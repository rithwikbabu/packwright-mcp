import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CHUNKS = 4096;

export const DEFAULT_PNG_LIMITS = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 16 * 1024 * 1024,
  maxDecodedBytes: 64 * 1024 * 1024,
});

export interface PngLimits {
  readonly maxFileBytes?: number | undefined;
  readonly maxWidth?: number | undefined;
  readonly maxHeight?: number | undefined;
  readonly maxPixels?: number | undefined;
  readonly maxDecodedBytes?: number | undefined;
}

export interface PixelImage {
  readonly width: number;
  readonly height: number;
  /** Row-major, non-premultiplied RGBA8 pixels. */
  readonly data: Uint8Array;
}

export interface DecodedPng extends PixelImage {
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly colorType: 0 | 2 | 3 | 4 | 6;
  readonly bitDepth: 8;
  readonly hadAncillaryChunks: boolean;
}

export interface NormalizedPng {
  readonly image: PixelImage;
  readonly png: Buffer;
  readonly sourceSha256: string;
  readonly sha256: string;
  readonly strippedMetadata: boolean;
}

interface ResolvedPngLimits {
  readonly maxFileBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
  readonly maxDecodedBytes: number;
}

interface ParsedChunk {
  readonly type: string;
  readonly data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function resolveLimits(overrides: PngLimits = {}): ResolvedPngLimits {
  const limits: ResolvedPngLimits = {
    maxFileBytes: overrides.maxFileBytes ?? DEFAULT_PNG_LIMITS.maxFileBytes,
    maxWidth: overrides.maxWidth ?? DEFAULT_PNG_LIMITS.maxWidth,
    maxHeight: overrides.maxHeight ?? DEFAULT_PNG_LIMITS.maxHeight,
    maxPixels: overrides.maxPixels ?? DEFAULT_PNG_LIMITS.maxPixels,
    maxDecodedBytes: overrides.maxDecodedBytes ?? DEFAULT_PNG_LIMITS.maxDecodedBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`PNG ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function checkedProduct(left: number, right: number, message: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new Error(message);
  return result;
}

function assertChunkType(typeBytes: Buffer): string {
  for (const byte of typeBytes) {
    const isAsciiLetter = (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
    if (!isAsciiLetter) throw new Error('PNG chunk type contains a non-letter byte.');
  }
  return typeBytes.toString('ascii');
}

function parseChunks(input: Buffer): ParsedChunk[] {
  if (input.length < PNG_SIGNATURE.length || !input.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('File does not have the PNG signature.');
  }
  const chunks: ParsedChunk[] = [];
  let offset = 8;
  let sawEnd = false;
  while (offset < input.length) {
    if (chunks.length >= MAX_CHUNKS) throw new Error('PNG contains too many chunks.');
    if (offset + 12 > input.length) throw new Error('PNG chunk header is truncated.');
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > input.length) {
      throw new Error('PNG chunk data is truncated.');
    }
    const typeBytes = input.subarray(offset + 4, offset + 8);
    const type = assertChunkType(typeBytes);
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} chunk has an invalid CRC.`);
    chunks.push({ type, data });
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new Error('PNG is missing its IEND chunk.');
  if (offset !== input.length) throw new Error('PNG contains data after its IEND chunk.');
  return chunks;
}

function bytesPerPixel(colorType: DecodedPng['colorType']): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
  }
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterRows(inflated: Buffer, width: number, height: number, pixelBytes: number): Buffer {
  const rowBytes = checkedProduct(width, pixelBytes, 'PNG scanline is too large.');
  const expectedLength = checkedProduct(rowBytes + 1, height, 'PNG image data is too large.');
  if (inflated.length !== expectedLength) {
    throw new Error(
      `PNG decompressed data length is ${String(inflated.length)}; expected ${String(expectedLength)}.`,
    );
  }
  const output = Buffer.alloc(checkedProduct(rowBytes, height, 'PNG image data is too large.'));
  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (rowBytes + 1);
    const outputOffset = y * rowBytes;
    const filter = inflated[sourceOffset];
    if (filter === undefined || filter > 4) throw new Error('PNG uses an unknown row filter.');
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = inflated[sourceOffset + 1 + x] ?? 0;
      const left = x >= pixelBytes ? (output[outputOffset + x - pixelBytes] ?? 0) : 0;
      const above = y > 0 ? (output[outputOffset - rowBytes + x] ?? 0) : 0;
      const upperLeft =
        y > 0 && x >= pixelBytes ? (output[outputOffset - rowBytes + x - pixelBytes] ?? 0) : 0;
      let reconstructed: number;
      switch (filter) {
        case 0:
          reconstructed = raw;
          break;
        case 1:
          reconstructed = raw + left;
          break;
        case 2:
          reconstructed = raw + above;
          break;
        case 3:
          reconstructed = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          reconstructed = raw + paeth(left, above, upperLeft);
          break;
        default:
          reconstructed = raw;
      }
      output[outputOffset + x] = reconstructed & 0xff;
    }
  }
  return output;
}

function expandRgba(
  samples: Buffer,
  width: number,
  height: number,
  colorType: DecodedPng['colorType'],
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
): Buffer {
  const pixels = checkedProduct(width, height, 'PNG has too many pixels.');
  const rgba = Buffer.alloc(checkedProduct(pixels, 4, 'PNG decoded image is too large.'));
  for (let index = 0; index < pixels; index += 1) {
    const output = index * 4;
    switch (colorType) {
      case 0: {
        const gray = samples[index] ?? 0;
        rgba[output] = gray;
        rgba[output + 1] = gray;
        rgba[output + 2] = gray;
        rgba[output + 3] = transparency?.readUInt16BE(0) === gray ? 0 : 255;
        break;
      }
      case 2: {
        const source = index * 3;
        rgba[output] = samples[source] ?? 0;
        rgba[output + 1] = samples[source + 1] ?? 0;
        rgba[output + 2] = samples[source + 2] ?? 0;
        rgba[output + 3] =
          transparency?.readUInt16BE(0) === (samples[source] ?? 0) &&
          transparency.readUInt16BE(2) === (samples[source + 1] ?? 0) &&
          transparency.readUInt16BE(4) === (samples[source + 2] ?? 0)
            ? 0
            : 255;
        break;
      }
      case 3: {
        if (palette === undefined) throw new Error('Indexed PNG is missing a PLTE chunk.');
        const paletteIndex = samples[index] ?? 0;
        const source = paletteIndex * 3;
        if (source + 2 >= palette.length)
          throw new Error('PNG pixel references a missing palette entry.');
        rgba[output] = palette[source] ?? 0;
        rgba[output + 1] = palette[source + 1] ?? 0;
        rgba[output + 2] = palette[source + 2] ?? 0;
        rgba[output + 3] = transparency?.[paletteIndex] ?? 255;
        break;
      }
      case 4: {
        const source = index * 2;
        const gray = samples[source] ?? 0;
        rgba[output] = gray;
        rgba[output + 1] = gray;
        rgba[output + 2] = gray;
        rgba[output + 3] = samples[source + 1] ?? 0;
        break;
      }
      case 6: {
        const source = index * 4;
        rgba[output] = samples[source] ?? 0;
        rgba[output + 1] = samples[source + 1] ?? 0;
        rgba[output + 2] = samples[source + 2] ?? 0;
        rgba[output + 3] = samples[source + 3] ?? 0;
        break;
      }
    }
  }
  return rgba;
}

/** Strictly decodes an 8-bit, non-interlaced PNG into RGBA8 pixels. */
export function decodePng(input: Uint8Array, limitsOverride: PngLimits = {}): DecodedPng {
  const limits = resolveLimits(limitsOverride);
  if (input.byteLength > limits.maxFileBytes) {
    throw new Error(`PNG exceeds the ${String(limits.maxFileBytes)}-byte file limit.`);
  }
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const chunks = parseChunks(source);
  const firstChunk = chunks[0];
  if (firstChunk?.type !== 'IHDR') {
    throw new Error('PNG IHDR must be the first chunk.');
  }
  if (chunks.at(-1)?.type !== 'IEND') throw new Error('PNG IEND must be the final chunk.');
  if (chunks.filter((chunk) => chunk.type === 'IHDR').length !== 1) {
    throw new Error('PNG must contain exactly one IHDR chunk.');
  }
  if (chunks.filter((chunk) => chunk.type === 'IEND').length !== 1) {
    throw new Error('PNG must contain exactly one IEND chunk.');
  }
  if (chunks.at(-1)?.data.length !== 0) throw new Error('PNG IEND chunk must be empty.');
  const header = firstChunk.data;
  if (header.length !== 13) throw new Error('PNG IHDR must contain 13 bytes.');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (width === 0 || height === 0) throw new Error('PNG dimensions must be non-zero.');
  if (width > limits.maxWidth || height > limits.maxHeight) {
    throw new Error(
      `PNG dimensions exceed ${String(limits.maxWidth)}x${String(limits.maxHeight)}.`,
    );
  }
  const pixels = checkedProduct(width, height, 'PNG has too many pixels.');
  if (pixels > limits.maxPixels)
    throw new Error(`PNG exceeds the ${String(limits.maxPixels)}-pixel limit.`);
  const decodedBytes = checkedProduct(pixels, 4, 'PNG decoded image is too large.');
  if (decodedBytes > limits.maxDecodedBytes) {
    throw new Error(`PNG exceeds the ${String(limits.maxDecodedBytes)}-byte decoded limit.`);
  }
  const bitDepth = header[8];
  const colorType = header[9];
  if (bitDepth !== 8) throw new Error('Only 8-bit PNG images are supported.');
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
    throw new Error(`PNG color type ${String(colorType)} is not supported.`);
  }
  if (header[10] !== 0 || header[11] !== 0) {
    throw new Error('PNG uses an unsupported compression or filtering method.');
  }
  if (header[12] !== 0) throw new Error('Interlaced PNG images are not supported.');

  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const compressed: Buffer[] = [];
  let sawIdat = false;
  let endedIdat = false;
  let hadAncillaryChunks = false;
  for (const chunk of chunks.slice(1, -1)) {
    const isCritical = chunk.type.charCodeAt(0) >= 65 && chunk.type.charCodeAt(0) <= 90;
    switch (chunk.type) {
      case 'PLTE':
        if (sawIdat || palette !== undefined)
          throw new Error('PNG PLTE chunk is out of order or duplicated.');
        if (chunk.data.length === 0 || chunk.data.length > 768 || chunk.data.length % 3 !== 0) {
          throw new Error('PNG PLTE chunk has an invalid length.');
        }
        palette = chunk.data;
        break;
      case 'tRNS':
        hadAncillaryChunks = true;
        if (sawIdat || transparency !== undefined) {
          throw new Error('PNG tRNS chunk is out of order or duplicated.');
        }
        transparency = chunk.data;
        break;
      case 'IDAT':
        if (endedIdat) throw new Error('PNG IDAT chunks must be consecutive.');
        sawIdat = true;
        compressed.push(chunk.data);
        break;
      default:
        if (sawIdat) endedIdat = true;
        if (isCritical) throw new Error(`PNG contains unsupported critical chunk ${chunk.type}.`);
        hadAncillaryChunks = true;
    }
  }
  if (!sawIdat || compressed.length === 0) throw new Error('PNG contains no IDAT data.');
  if (colorType === 3 && palette === undefined)
    throw new Error('Indexed PNG is missing a PLTE chunk.');
  if ((colorType === 0 || colorType === 4) && palette !== undefined) {
    throw new Error('Grayscale PNG images cannot contain a PLTE chunk.');
  }
  if (transparency !== undefined) {
    const expectedLength = colorType === 0 ? 2 : colorType === 2 ? 6 : undefined;
    if (colorType === 4 || colorType === 6) {
      throw new Error('PNG color types with alpha cannot contain a tRNS chunk.');
    }
    if (expectedLength !== undefined && transparency.length !== expectedLength) {
      throw new Error('PNG tRNS chunk has an invalid length for its color type.');
    }
  }
  if (
    transparency !== undefined &&
    palette !== undefined &&
    transparency.length > palette.length / 3
  ) {
    throw new Error('PNG tRNS chunk exceeds its palette size.');
  }

  const pixelBytes = bytesPerPixel(colorType);
  const rowBytes = checkedProduct(width, pixelBytes, 'PNG scanline is too large.');
  const expectedInflated = checkedProduct(rowBytes + 1, height, 'PNG image data is too large.');
  if (expectedInflated > limits.maxDecodedBytes + height) {
    throw new Error(`PNG exceeds the ${String(limits.maxDecodedBytes)}-byte decoded limit.`);
  }
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedInflated });
  } catch (error) {
    throw new Error(`PNG image data could not be decompressed: ${(error as Error).message}`);
  }
  const samples = unfilterRows(inflated, width, height, pixelBytes);
  const data = expandRgba(samples, width, height, colorType, palette, transparency);
  return {
    width,
    height,
    data,
    sourceSha256: sha256(source),
    sourceBytes: source.length,
    colorType,
    bitDepth,
    hadAncillaryChunks,
  };
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const output = Buffer.allocUnsafe(12 + body.length);
  output.writeUInt32BE(body.length, 0);
  typeBytes.copy(output, 4);
  body.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + body.length)), 8 + body.length);
  return output;
}

/** Encodes RGBA8 pixels with fixed filtering and compression settings. */
export function encodePng(image: PixelImage, limitsOverride: PngLimits = {}): Buffer {
  const limits = resolveLimits(limitsOverride);
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) {
    throw new Error('PNG dimensions must be safe integers.');
  }
  if (image.width <= 0 || image.height <= 0) throw new Error('PNG dimensions must be non-zero.');
  if (image.width > limits.maxWidth || image.height > limits.maxHeight) {
    throw new Error(
      `PNG dimensions exceed ${String(limits.maxWidth)}x${String(limits.maxHeight)}.`,
    );
  }
  const pixels = checkedProduct(image.width, image.height, 'PNG has too many pixels.');
  if (pixels > limits.maxPixels)
    throw new Error(`PNG exceeds the ${String(limits.maxPixels)}-pixel limit.`);
  const byteLength = checkedProduct(pixels, 4, 'PNG decoded image is too large.');
  if (byteLength > limits.maxDecodedBytes) {
    throw new Error(`PNG exceeds the ${String(limits.maxDecodedBytes)}-byte decoded limit.`);
  }
  if (image.data.byteLength !== byteLength) {
    throw new Error(
      `RGBA image contains ${String(image.data.byteLength)} bytes; expected ${String(byteLength)}.`,
    );
  }
  const rowBytes = image.width * 4;
  const scanlines = Buffer.alloc((rowBytes + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const destination = y * (rowBytes + 1);
    scanlines[destination] = 0;
    const source = Buffer.from(image.data.buffer, image.data.byteOffset + y * rowBytes, rowBytes);
    source.copy(scanlines, destination + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const compressed = deflateSync(scanlines, { level: 9 });
  const output = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  if (output.length > limits.maxFileBytes) {
    throw new Error(`Encoded PNG exceeds the ${String(limits.maxFileBytes)}-byte file limit.`);
  }
  return output;
}

/** Validates and strips all metadata by decoding and deterministically re-encoding RGBA pixels. */
export function normalizePng(input: Uint8Array, limitsOverride: PngLimits = {}): NormalizedPng {
  const decoded = decodePng(input, limitsOverride);
  const image: PixelImage = { width: decoded.width, height: decoded.height, data: decoded.data };
  const png = encodePng(image, limitsOverride);
  return {
    image,
    png,
    sourceSha256: decoded.sourceSha256,
    sha256: sha256(png),
    strippedMetadata: decoded.hadAncillaryChunks || !Buffer.from(input).equals(png),
  };
}
