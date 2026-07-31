import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { PackwrightError } from '../core/errors.js';
import { sha256Buffer } from '../core/hash.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES } from '../core/limits.js';
import { readStableFile } from '../core/stable-file.js';
import type { Workspace } from '../core/workspace.js';
import { compareVisualStrings } from './compiler.js';
import { canonicalJsonBytes } from './run-store.js';

export interface PackSnapshotEntry {
  readonly path: string;
  readonly data: Buffer;
  readonly sha256: string;
  readonly size: number;
}

export interface PackSnapshot {
  readonly root: string;
  readonly entries: readonly PackSnapshotEntry[];
  readonly treeSha256: string;
  readonly totalBytes: number;
}

export interface PackSnapshotOverlayEntry {
  readonly path: string;
  readonly data: Uint8Array;
}

interface ListedFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly device: number;
  readonly inode: number;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PackwrightError('cancelled', 'Pack snapshot was cancelled.');
}

function assertSafePackPath(value: string): void {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new PackwrightError('unsafe_path', `Pack contains an unsafe path: ${value}`);
  }
}

async function listPackFiles(root: string, signal?: AbortSignal): Promise<readonly ListedFile[]> {
  const files: ListedFile[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    abortIfNeeded(signal);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareVisualStrings(left.name, right.name));
    for (const entry of entries) {
      abortIfNeeded(signal);
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      assertSafePackPath(relative);
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new PackwrightError(
          'unsafe_path',
          `Pack snapshot rejects symbolic links: ${relative}`,
        );
      }
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) {
        throw new PackwrightError(
          'unsafe_path',
          `Pack snapshot accepts only regular files and directories: ${relative}`,
        );
      }
      files.push({
        path: relative,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        device: info.dev,
        inode: info.ino,
      });
      if (files.length > MAX_SCAN_FILES) {
        throw new PackwrightError(
          'size_limit',
          `Pack snapshot exceeds the ${String(MAX_SCAN_FILES)}-file limit.`,
        );
      }
    }
  };
  await visit(root, '');
  return files;
}

function sameListing(left: readonly ListedFile[], right: readonly ListedFile[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        entry.path === candidate?.path &&
        entry.size === candidate.size &&
        entry.mtimeMs === candidate.mtimeMs &&
        entry.ctimeMs === candidate.ctimeMs &&
        entry.device === candidate.device &&
        entry.inode === candidate.inode
      );
    })
  );
}

function snapshotIdentity(entries: readonly PackSnapshotEntry[]): string {
  return sha256Buffer(
    canonicalJsonBytes({
      files: entries.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
      })),
    }),
  );
}

export async function readConfinedPackSnapshot(
  workspace: Workspace,
  packPath: string,
  signal?: AbortSignal,
): Promise<PackSnapshot> {
  const root = await workspace.resolve(packPath, { mustExist: true, rejectSymlinks: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PackwrightError('invalid_argument', 'Pack root must be a real directory.', {
      path: packPath,
    });
  }
  const before = await listPackFiles(root, signal);
  if (!before.some((entry) => entry.path === 'pack.mcmeta')) {
    throw new PackwrightError('invalid_content', 'Pack snapshot is missing pack.mcmeta.', {
      path: packPath,
    });
  }
  const entries: PackSnapshotEntry[] = [];
  let totalBytes = 0;
  for (const entry of before) {
    abortIfNeeded(signal);
    totalBytes += entry.size;
    if (totalBytes > MAX_SCAN_BYTES) {
      throw new PackwrightError(
        'size_limit',
        `Pack snapshot exceeds the ${String(MAX_SCAN_BYTES)}-byte limit.`,
      );
    }
    const stable = await readStableFile(path.join(root, ...entry.path.split('/')), {
      maxBytes: Math.max(1, entry.size),
      collect: true,
      signal,
      pathLabel: `${packPath}/${entry.path}`,
    });
    if (stable.data?.length !== entry.size) {
      throw new PackwrightError(
        'precondition_failed',
        `Pack file changed while it was being captured: ${entry.path}`,
      );
    }
    entries.push({
      path: entry.path,
      data: stable.data,
      sha256: stable.snapshot.sha256,
      size: stable.data.length,
    });
  }
  const after = await listPackFiles(root, signal);
  if (!sameListing(before, after)) {
    throw new PackwrightError(
      'precondition_failed',
      'Pack contents changed while the capture snapshot was being prepared.',
      { path: packPath },
    );
  }
  return {
    root: packPath,
    entries,
    treeSha256: snapshotIdentity(entries),
    totalBytes,
  };
}

export function applyPackSnapshotOverlay(
  snapshot: PackSnapshot,
  overlay: readonly PackSnapshotOverlayEntry[],
): PackSnapshot {
  const files = new Map(snapshot.entries.map((entry) => [entry.path, entry.data]));
  for (const entry of overlay) {
    assertSafePackPath(entry.path);
    files.set(entry.path, Buffer.from(entry.data));
  }
  const entries = [...files]
    .map(([entryPath, data]) => ({
      path: entryPath,
      data,
      sha256: sha256Buffer(data),
      size: data.length,
    }))
    .sort((left, right) => compareVisualStrings(left.path, right.path));
  if (entries.length > MAX_SCAN_FILES) {
    throw new PackwrightError(
      'size_limit',
      `Pack snapshot exceeds the ${String(MAX_SCAN_FILES)}-file limit after overlay.`,
    );
  }
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (totalBytes > MAX_SCAN_BYTES) {
    throw new PackwrightError(
      'size_limit',
      `Pack snapshot exceeds the ${String(MAX_SCAN_BYTES)}-byte limit after overlay.`,
    );
  }
  return {
    root: snapshot.root,
    entries,
    treeSha256: snapshotIdentity(entries),
    totalBytes,
  };
}
