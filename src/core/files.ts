import { randomUUID } from 'node:crypto';
import { link, lstat, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PackwrightError } from './errors.js';
import { snapshotStableFile } from './stable-file.js';
import type { Workspace } from './workspace.js';

export interface AtomicInstallOptions {
  readonly expectedSha256?: string | undefined;
  readonly requireAbsent?: boolean | undefined;
}

export function joinRelative(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/');
}

export async function atomicWriteFile(
  workspace: Workspace,
  relativePath: string,
  content: Uint8Array | string,
  options: AtomicInstallOptions = {},
): Promise<void> {
  workspace.assertWritable();
  const normalized = workspace.normalize(relativePath);
  const parent = path.posix.dirname(normalized);
  await workspace.ensureDirectory(parent === '.' ? '' : parent);
  const target = await workspace.resolve(normalized, { rejectSymlinks: true });
  const parentAbsolute = path.dirname(target);
  const temporary = path.join(
    parentAbsolute,
    `.${path.basename(target)}.packwright-${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
    await atomicInstallPreparedFile(workspace, normalized, temporary, options);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Atomically install a same-directory prepared regular file with no-replace/CAS semantics. */
export async function atomicInstallPreparedFile(
  workspace: Workspace,
  relativePath: string,
  preparedPath: string,
  options: AtomicInstallOptions = {},
): Promise<void> {
  workspace.assertWritable();
  const normalized = workspace.normalize(relativePath);
  const target = await workspace.resolve(normalized, { rejectSymlinks: true });
  if (path.dirname(preparedPath) !== path.dirname(target)) {
    throw new PackwrightError(
      'invalid_argument',
      'Prepared files must be installed from the target directory.',
    );
  }
  const prepared = await lstat(preparedPath);
  if (!prepared.isFile() || prepared.isSymbolicLink()) {
    throw new PackwrightError(
      'invalid_argument',
      'Prepared install source must be a regular file.',
    );
  }

  const refreshed = await workspace.resolve(normalized, { rejectSymlinks: true });
  let current;
  try {
    current = await lstat(refreshed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (options.requireAbsent && current) {
    throw new PackwrightError('already_exists', 'Target was created concurrently.', {
      path: normalized,
    });
  }
  if (options.expectedSha256 !== undefined) {
    if (!current?.isFile() || current.isSymbolicLink()) {
      throw new PackwrightError('precondition_failed', 'Target changed during the write.', {
        path: normalized,
      });
    }
    const currentSha256 = (
      await snapshotStableFile(refreshed, {
        maxBytes: current.size,
        pathLabel: normalized,
      })
    ).sha256;
    if (currentSha256 !== options.expectedSha256) {
      throw new PackwrightError('precondition_failed', 'Target changed during the write.', {
        expectedSha256: options.expectedSha256,
        actualSha256: currentSha256,
      });
    }
  }
  if (options.requireAbsent) {
    try {
      await link(preparedPath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new PackwrightError('already_exists', 'Target was created concurrently.', {
          path: normalized,
        });
      }
      throw error;
    }
    await unlink(preparedPath);
    return;
  }

  if (options.expectedSha256 !== undefined) {
    const backup = path.join(
      path.dirname(target),
      `.${path.basename(target)}.packwright-backup-${randomUUID()}.tmp`,
    );
    let backupExists = false;
    try {
      await rename(target, backup);
      backupExists = true;
      const movedInfo = await lstat(backup);
      if (!movedInfo.isFile() || movedInfo.isSymbolicLink()) {
        throw new PackwrightError('precondition_failed', 'Target changed during the write.', {
          path: normalized,
        });
      }
      const movedSha256 = (
        await snapshotStableFile(backup, {
          maxBytes: movedInfo.size,
          pathLabel: normalized,
        })
      ).sha256;
      if (movedSha256 !== options.expectedSha256) {
        throw new PackwrightError('precondition_failed', 'Target changed during the write.', {
          expectedSha256: options.expectedSha256,
          actualSha256: movedSha256,
        });
      }
      await link(preparedPath, target);
      await unlink(preparedPath);
      await unlink(backup);
      backupExists = false;
      return;
    } catch (error) {
      if (backupExists) {
        try {
          await link(backup, target);
          await unlink(backup);
          backupExists = false;
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') throw restoreError;
        }
      }
      throw error;
    }
  }

  await rename(preparedPath, target);
}
