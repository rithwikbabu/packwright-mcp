import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { PackwrightError } from './errors.js';

const READ_CHUNK_BYTES = 64 * 1024;

interface BigIntFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface FileContentSnapshot {
  readonly size: number;
  readonly sha256: string;
}

export interface StableFileReadOptions {
  readonly maxBytes: number;
  readonly expected?: FileContentSnapshot | undefined;
  readonly collect?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly pathLabel?: string | undefined;
}

export interface StableFileReadResult {
  readonly snapshot: FileContentSnapshot;
  readonly data?: Buffer | undefined;
}

function changed(pathLabel: string, details?: Readonly<Record<string, unknown>>): PackwrightError {
  return new PackwrightError(
    'precondition_failed',
    `File changed while it was being read: ${pathLabel}`,
    details,
  );
}

function sameIdentity(left: BigIntFileIdentity, right: BigIntFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PackwrightError('cancelled', 'File reading was cancelled.');
  }
}

/**
 * Reads and hashes one regular file through a single O_NOFOLLOW handle.
 * The opened identity must remain stable and continue to name the same path.
 */
export async function readStableFile(
  filename: string,
  options: StableFileReadOptions,
): Promise<StableFileReadResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new PackwrightError('invalid_argument', 'Stable file read limit must be non-negative.');
  }
  abortIfNeeded(options.signal);
  const pathLabel = options.pathLabel ?? filename;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new PackwrightError('unsafe_path', `Refusing to follow a symbolic link: ${pathLabel}`);
    }
    if (code === 'ENOENT') {
      throw changed(pathLabel, { reason: 'missing' });
    }
    throw error;
  }

  try {
    const before = (await handle.stat({ bigint: true })) as BigIntFileIdentity;
    if (!before.isFile()) {
      throw new PackwrightError('invalid_argument', `Expected a regular file: ${pathLabel}`);
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PackwrightError('size_limit', `File is too large to read safely: ${pathLabel}`);
    }
    const size = Number(before.size);
    if (size > options.maxBytes) {
      throw new PackwrightError('size_limit', `File exceeds its read limit: ${pathLabel}`, {
        size,
        maxBytes: options.maxBytes,
      });
    }
    if (options.expected !== undefined && size !== options.expected.size) {
      throw changed(pathLabel, {
        expectedSize: options.expected.size,
        actualSize: size,
      });
    }

    const hash = createHash('sha256');
    const chunks: Buffer[] | undefined = options.collect ? [] : undefined;
    let bytesReadTotal = 0;
    while (bytesReadTotal < size) {
      abortIfNeeded(options.signal);
      const requested = Math.min(READ_CHUNK_BYTES, size - bytesReadTotal);
      const buffer = Buffer.allocUnsafe(requested);
      const result = await handle.read(buffer, 0, requested, null);
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      bytesReadTotal += result.bytesRead;
      hash.update(chunk);
      chunks?.push(Buffer.from(chunk));
    }

    const after = (await handle.stat({ bigint: true })) as BigIntFileIdentity;
    let pathInfo: BigIntFileIdentity;
    try {
      pathInfo = await lstat(filename, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw changed(pathLabel, { reason: 'unlinked' });
      }
      throw error;
    }
    if (pathInfo.isSymbolicLink()) {
      throw new PackwrightError(
        'unsafe_path',
        `File path became a symbolic link while it was read: ${pathLabel}`,
      );
    }
    if (
      bytesReadTotal !== size ||
      !sameIdentity(before, after) ||
      !pathInfo.isFile() ||
      !sameIdentity(after, pathInfo)
    ) {
      throw changed(pathLabel, {
        expectedSize: size,
        bytesRead: bytesReadTotal,
        actualSize: Number(after.size),
      });
    }

    const sha256 = hash.digest('hex');
    if (options.expected !== undefined && sha256 !== options.expected.sha256) {
      throw changed(pathLabel, {
        expectedSha256: options.expected.sha256,
        actualSha256: sha256,
      });
    }
    return {
      snapshot: { size, sha256 },
      ...(chunks === undefined ? {} : { data: Buffer.concat(chunks, size) }),
    };
  } finally {
    await handle.close();
  }
}

export async function snapshotStableFile(
  filename: string,
  options: Omit<StableFileReadOptions, 'collect' | 'expected'>,
): Promise<FileContentSnapshot> {
  return (await readStableFile(filename, options)).snapshot;
}
