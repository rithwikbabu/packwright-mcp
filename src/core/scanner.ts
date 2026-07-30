import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PackwrightError } from './errors.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES } from './limits.js';
import { parseResourcePath } from './resources.js';
import { snapshotStableFile } from './stable-file.js';
import type { ResourceInventoryEntry } from './types.js';
import type { Workspace } from './workspace.js';

export interface ScanResult {
  entries: ResourceInventoryEntry[];
  totalBytes: number;
}

export interface ScanOptions {
  maxFiles?: number;
  maxBytes?: number;
  signal?: AbortSignal | undefined;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PackwrightError('cancelled', 'Datapack scan was cancelled.');
}

function assertSafeInventoryPath(workspace: Workspace, relative: string): void {
  for (const character of relative) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      throw new PackwrightError(
        'unsafe_path',
        'Datapack paths may not contain control characters.',
        {
          path: relative,
        },
      );
    }
  }
  const normalized = workspace.normalize(relative);
  if (normalized !== relative) {
    throw new PackwrightError(
      'unsafe_path',
      'Datapack paths may not use encoded or ambiguous path segments.',
      { path: relative },
    );
  }
}

export function assertScanSnapshotUnchanged(expected: ScanResult, actual: ScanResult): void {
  const length = Math.max(expected.entries.length, actual.entries.length);
  for (let index = 0; index < length; index += 1) {
    const before = expected.entries[index];
    const after = actual.entries[index];
    if (
      before?.path !== after?.path ||
      before?.size !== after?.size ||
      before?.sha256 !== after?.sha256
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Datapack changed after validation; retry the operation against a stable pack.',
        {
          path: before?.path ?? after?.path,
          expectedSize: before?.size,
          actualSize: after?.size,
          expectedSha256: before?.sha256,
          actualSha256: after?.sha256,
        },
      );
    }
  }
  if (expected.totalBytes !== actual.totalBytes) {
    throw new PackwrightError(
      'precondition_failed',
      'Datapack byte count changed after validation; retry the operation against a stable pack.',
      { expectedBytes: expected.totalBytes, actualBytes: actual.totalBytes },
    );
  }
}

export async function scanDatapack(
  workspace: Workspace,
  packPath: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  abortIfNeeded(options.signal);
  const normalizedPack = workspace.normalize(packPath);
  const root = await workspace.resolve(normalizedPack, {
    mustExist: true,
    rejectSymlinks: true,
  });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) {
    throw new PackwrightError('not_a_datapack', 'Datapack path is not a directory.');
  }
  const entries: ResourceInventoryEntry[] = [];
  let totalBytes = 0;
  const maxFiles = options.maxFiles ?? MAX_SCAN_FILES;
  const maxBytes = options.maxBytes ?? MAX_SCAN_BYTES;

  async function visit(directory: string, prefix: string): Promise<void> {
    abortIfNeeded(options.signal);
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    );
    for (const child of children) {
      abortIfNeeded(options.signal);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      assertSafeInventoryPath(workspace, relative);
      const absolute = path.join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new PackwrightError('unsafe_path', 'Datapacks may not contain symbolic links.', {
          path: `${normalizedPack}/${relative}`,
        });
      }
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) continue;
      if (entries.length + 1 > maxFiles) {
        throw new PackwrightError(
          'scan_limit',
          `Datapack exceeds the ${String(maxFiles)} file limit.`,
        );
      }
      let snapshot;
      try {
        snapshot = await snapshotStableFile(absolute, {
          maxBytes: maxBytes - totalBytes,
          signal: options.signal,
          pathLabel: `${normalizedPack}/${relative}`,
        });
      } catch (error) {
        if (error instanceof PackwrightError && error.code === 'size_limit') {
          throw new PackwrightError(
            'scan_limit',
            `Datapack exceeds the ${String(maxBytes)} byte limit.`,
          );
        }
        throw error;
      }
      totalBytes += snapshot.size;
      const parsed = parseResourcePath(relative);
      entries.push({
        path: relative,
        size: snapshot.size,
        sha256: snapshot.sha256,
        resourceType: parsed?.type,
        resourceId: parsed?.id,
      });
    }
  }

  await visit(root, '');
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { entries, totalBytes };
}
