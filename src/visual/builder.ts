import path from 'node:path';
import * as yazl from 'yazl';
import { sha256Buffer } from '../core/hash.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES } from '../core/limits.js';
import {
  compareVisualStrings,
  RESOURCE_PACK_FORMAT_26_2,
  serializeVisualJson,
} from './compiler.js';

export interface ResourcePackSourceEntry {
  readonly path: string;
  readonly data: string | Uint8Array;
}

export interface ResourcePackArchiveOptions {
  readonly description: unknown;
  readonly entries: readonly ResourcePackSourceEntry[];
}

export interface DeterministicResourcePackArchive {
  readonly data: Buffer;
  readonly size: number;
  readonly sha256: string;
  readonly entries: number;
  readonly resourcePackFormat: typeof RESOURCE_PACK_FORMAT_26_2;
}

export interface DeterministicZipArchive {
  readonly data: Buffer;
  readonly size: number;
  readonly sha256: string;
  readonly entries: number;
}

const FIXED_ZIP_TIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

export function createResourcePackMetadata(description: unknown): Record<string, unknown> {
  if (
    typeof description !== 'string' &&
    (description === null || typeof description !== 'object')
  ) {
    throw new Error('Resource-pack description must be a string or JSON text component.');
  }
  try {
    JSON.stringify(description);
  } catch (error) {
    throw new Error('Resource-pack description must be JSON-serializable.', { cause: error });
  }
  return {
    pack: {
      description,
      min_format: [...RESOURCE_PACK_FORMAT_26_2],
      max_format: [...RESOURCE_PACK_FORMAT_26_2],
    },
  };
}

function assertSafeArchivePath(entryPath: string): void {
  if (
    entryPath.length === 0 ||
    Buffer.byteLength(entryPath, 'utf8') > 1024 ||
    containsControlCharacter(entryPath) ||
    entryPath.includes('\\') ||
    entryPath.includes(':') ||
    path.posix.isAbsolute(entryPath) ||
    entryPath.endsWith('/') ||
    entryPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe resource-pack archive path: '${entryPath}'.`);
  }
}

function normalizeEntries(
  description: unknown,
  entries: readonly ResourcePackSourceEntry[],
): readonly { path: string; data: Buffer }[] {
  if (entries.length + 1 > MAX_SCAN_FILES) {
    throw new Error(`Resource pack exceeds the ${MAX_SCAN_FILES.toLocaleString('en')} file limit.`);
  }
  const seen = new Set<string>(['pack.mcmeta']);
  const normalized = [
    {
      path: 'pack.mcmeta',
      data: Buffer.from(serializeVisualJson(createResourcePackMetadata(description)), 'utf8'),
    },
  ];
  let totalBytes = normalized[0]?.data.length ?? 0;
  for (const entry of entries) {
    assertSafeArchivePath(entry.path);
    if (seen.has(entry.path)) {
      throw new Error(`Duplicate resource-pack archive path: '${entry.path}'.`);
    }
    seen.add(entry.path);
    const data =
      typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    totalBytes += data.length;
    if (totalBytes > MAX_SCAN_BYTES) {
      throw new Error('Resource pack exceeds the 512 MiB uncompressed build limit.');
    }
    normalized.push({ path: entry.path, data });
  }
  return normalized.sort((left, right) => compareVisualStrings(left.path, right.path));
}

/**
 * Create byte-identical resource-pack ZIP bytes without touching the filesystem. Callers remain
 * responsible for confined, hash-guarded installation of the returned archive.
 */
export async function createDeterministicResourcePackArchive(
  options: ResourcePackArchiveOptions,
): Promise<DeterministicResourcePackArchive> {
  const entries = normalizeEntries(options.description, options.entries);
  const archive = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const collect = (async (): Promise<void> => {
    for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk as Uint8Array));
  })();

  for (const entry of entries) {
    archive.addBuffer(entry.data, entry.path, {
      compress: false,
      mtime: FIXED_ZIP_TIME,
      mode: 0o100644,
    });
  }
  archive.end();
  await collect;
  const data = Buffer.concat(chunks);
  return {
    data,
    size: data.length,
    sha256: sha256Buffer(data),
    entries: entries.length,
    resourcePackFormat: RESOURCE_PACK_FORMAT_26_2,
  };
}

/** Create a deterministic ZIP from an already validated pack snapshot. */
export async function createDeterministicZipArchive(
  sourceEntries: readonly ResourcePackSourceEntry[],
): Promise<DeterministicZipArchive> {
  if (sourceEntries.length === 0 || sourceEntries.length > MAX_SCAN_FILES) {
    throw new Error(`Archive must contain 1-${MAX_SCAN_FILES.toLocaleString('en')} files.`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const entries = sourceEntries
    .map((entry) => {
      assertSafeArchivePath(entry.path);
      if (seen.has(entry.path)) throw new Error(`Duplicate archive path: '${entry.path}'.`);
      seen.add(entry.path);
      const data =
        typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
      totalBytes += data.length;
      if (totalBytes > MAX_SCAN_BYTES) {
        throw new Error('Archive exceeds the 512 MiB uncompressed build limit.');
      }
      return { path: entry.path, data };
    })
    .sort((left, right) => compareVisualStrings(left.path, right.path));
  const archive = new yazl.ZipFile();
  const chunks: Buffer[] = [];
  const collect = (async (): Promise<void> => {
    for await (const chunk of archive.outputStream) chunks.push(Buffer.from(chunk as Uint8Array));
  })();
  for (const entry of entries) {
    archive.addBuffer(entry.data, entry.path, {
      compress: false,
      mtime: FIXED_ZIP_TIME,
      mode: 0o100644,
    });
  }
  archive.end();
  await collect;
  const data = Buffer.concat(chunks);
  return {
    data,
    size: data.length,
    sha256: sha256Buffer(data),
    entries: entries.length,
  };
}
