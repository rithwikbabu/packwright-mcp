import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';
import { PackwrightError } from './errors.js';
import { atomicInstallPreparedFile, joinRelative } from './files.js';
import { MAX_SCAN_BYTES } from './limits.js';
import { withPathLock } from './locks.js';
import { requireDatapack } from './project.js';
import { assertScanSnapshotUnchanged, scanDatapack, type ScanResult } from './scanner.js';
import { readStableFile, snapshotStableFile } from './stable-file.js';
import type { BuildResult, ValidationAdapter } from './types.js';
import { validateDatapack } from './validation.js';
import type { Workspace } from './workspace.js';

export interface ArchiveEntry {
  name: string;
  data: Buffer;
}

export interface ZipArchiveWriter {
  write(entries: readonly ArchiveEntry[], destination: string): Promise<void>;
}

const FIXED_ZIP_TIME = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));
const MAX_ZIP_BYTES = MAX_SCAN_BYTES + 128 * 1024 * 1024;

export class YazlZipArchiveWriter implements ZipArchiveWriter {
  async write(entries: readonly ArchiveEntry[], destination: string): Promise<void> {
    const archive = new yazl.ZipFile();
    const completion = pipeline(
      archive.outputStream,
      createWriteStream(destination, { flags: 'wx', mode: 0o644 }),
    );
    for (const entry of [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      archive.addBuffer(entry.data, entry.name, {
        compress: false,
        mtime: FIXED_ZIP_TIME,
        mode: 0o100644,
      });
    }
    archive.end();
    await completion;
  }
}

export interface BuildDatapackOptions {
  outputPath: string;
  overwrite?: boolean | undefined;
  expectedSha256?: string | undefined;
  adapters?: readonly ValidationAdapter[] | undefined;
  signal?: AbortSignal | undefined;
  zipWriter?: ZipArchiveWriter | undefined;
}

export async function buildDatapack(
  workspace: Workspace,
  packPath: string,
  options: BuildDatapackOptions,
): Promise<BuildResult> {
  workspace.assertWritable();
  const pack = await requireDatapack(workspace, packPath);
  const output = workspace.normalize(options.outputPath);
  if (!output.endsWith('.zip')) {
    throw new PackwrightError('invalid_argument', 'Build output path must end with .zip.');
  }
  if (output === pack || output.startsWith(`${pack}/`)) {
    throw new PackwrightError('invalid_argument', 'Build output cannot be inside the datapack.');
  }
  let validatedScan: ScanResult | undefined;
  const validation = await validateDatapack(workspace, pack, {
    adapters: options.adapters,
    signal: options.signal,
    onScan: (scan) => {
      validatedScan = scan;
    },
  });
  if (!validation.ok) {
    return {
      ok: false,
      entries: 0,
      diagnostics: validation.diagnostics,
    };
  }
  if (options.signal?.aborted) throw new PackwrightError('cancelled', 'Build was cancelled.');
  if (validatedScan === undefined) {
    throw new PackwrightError(
      'precondition_failed',
      'Build validation did not produce a snapshot.',
    );
  }

  const entries: ArchiveEntry[] = [];
  let bytesRead = 0;
  for (const entry of validatedScan.entries) {
    if (options.signal?.aborted) throw new PackwrightError('cancelled', 'Build was cancelled.');
    const absolute = await workspace.resolve(joinRelative(pack, entry.path), {
      mustExist: true,
      rejectSymlinks: true,
    });
    const stable = await readStableFile(absolute, {
      maxBytes: entry.size,
      expected: entry,
      collect: true,
      signal: options.signal,
      pathLabel: entry.path,
    });
    if (stable.data === undefined) {
      throw new PackwrightError('precondition_failed', 'Stable build read returned no data.', {
        path: entry.path,
      });
    }
    bytesRead += stable.data.length;
    if (bytesRead > MAX_SCAN_BYTES) {
      throw new PackwrightError('scan_limit', 'Datapack exceeded the build byte limit.');
    }
    entries.push({ name: entry.path, data: stable.data });
  }
  if (bytesRead !== validatedScan.totalBytes) {
    throw new PackwrightError('precondition_failed', 'Datapack size changed after validation.');
  }
  assertScanSnapshotUnchanged(
    validatedScan,
    await scanDatapack(workspace, pack, { signal: options.signal }),
  );

  const outputAbsolute = await workspace.resolve(output, { rejectSymlinks: true });
  return withPathLock(outputAbsolute, async () => {
    const parent = path.posix.dirname(output);
    await workspace.ensureDirectory(parent === '.' ? '' : parent);
    const target = await workspace.resolve(output, { rejectSymlinks: true });
    let existing;
    try {
      existing = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (!existing.isFile()) {
        throw new PackwrightError('invalid_argument', 'Build output target is not a file.');
      }
      if (!options.overwrite || !options.expectedSha256) {
        throw new PackwrightError(
          'precondition_required',
          'overwrite: true and expectedSha256 are required to replace an existing build.',
        );
      }
      const currentSha256 = (
        await snapshotStableFile(target, {
          maxBytes: existing.size,
          pathLabel: output,
        })
      ).sha256;
      if (currentSha256 !== options.expectedSha256) {
        throw new PackwrightError(
          'precondition_failed',
          'Build output changed since it was read.',
          {
            expectedSha256: options.expectedSha256,
            actualSha256: currentSha256,
          },
        );
      }
    }
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.packwright-${randomUUID()}.tmp`,
    );
    try {
      await (options.zipWriter ?? new YazlZipArchiveWriter()).write(entries, temporary);
      await atomicInstallPreparedFile(
        workspace,
        output,
        temporary,
        existing ? { expectedSha256: options.expectedSha256 } : { requireAbsent: true },
      );
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    const outputSnapshot = await snapshotStableFile(target, {
      maxBytes: MAX_ZIP_BYTES,
      pathLabel: output,
    });
    return {
      ok: true,
      path: output,
      size: outputSnapshot.size,
      sha256: outputSnapshot.sha256,
      entries: entries.length,
      diagnostics: validation.diagnostics,
    };
  });
}
