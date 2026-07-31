import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { PackwrightError } from '../core/errors.js';
import { sha256Buffer } from '../core/hash.js';
import { withPathLocks } from '../core/locks.js';
import { snapshotStableFile } from '../core/stable-file.js';
import type { Workspace } from '../core/workspace.js';

const MAX_TRANSACTION_FILES = 512;
const MAX_TRANSACTION_BYTES = 64 * 1024 * 1024;
const MAX_PRECONDITION_FILE_BYTES = 640 * 1024 * 1024;

export interface TransactionWrite {
  readonly path: string;
  readonly content: Uint8Array | string;
  /** null means the destination must not exist. */
  readonly expectedSha256: string | null;
}

export interface TransactionFileResult {
  readonly path: string;
  readonly sha256: string;
  readonly previousSha256?: string;
  readonly size: number;
}

export interface TransactionResult {
  readonly transactionId: string;
  readonly files: readonly TransactionFileResult[];
}

interface PreparedWrite extends TransactionFileResult {
  readonly content: Buffer;
  readonly expectedSha256: string | null;
  readonly absolute: string;
  readonly staged: string;
  readonly backup: string;
  readonly parent: ParentIdentity;
  readonly previousIdentity?: FileIdentity;
  stageCreated: boolean;
  stageIdentity?: FileIdentity;
  backupCreated: boolean;
  backupIdentity?: FileIdentity;
  installed: boolean;
  installedIdentity?: FileIdentity;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ParentIdentity extends FileIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly label: string;
}

class ParentIdentityMismatchError extends Error {
  readonly pathLabel: string;
  readonly phase: string;

  constructor(pathLabel: string, phase: string, cause?: unknown) {
    super(`Transaction parent changed during ${phase}: ${pathLabel}.`, { cause });
    this.name = 'ParentIdentityMismatchError';
    this.pathLabel = pathLabel;
    this.phase = phase;
  }
}

async function optionalInfo(filename: string): Promise<Stats | undefined> {
  try {
    return await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function currentSha256(filename: string, size: number, label: string): Promise<string> {
  return (
    await snapshotStableFile(filename, {
      maxBytes: Math.min(size, MAX_PRECONDITION_FILE_BYTES),
      pathLabel: label,
    })
  ).sha256;
}

function fileIdentity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function captureParentIdentity(
  workspace: Workspace,
  filename: string,
): Promise<ParentIdentity> {
  const parentPath = path.dirname(filename);
  const label = workspace.relative(parentPath);
  const info = await lstat(parentPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PackwrightError('unsafe_path', 'Transaction parent is not a safe directory.', {
      path: label,
    });
  }
  const canonical = await realpath(parentPath);
  // Assert the resolved parent still belongs to the workspace. This closes the
  // case where an ancestor was exchanged for a symlink before capture.
  workspace.relative(canonical);
  const canonicalInfo = await lstat(canonical);
  if (!canonicalInfo.isDirectory() || canonicalInfo.isSymbolicLink()) {
    throw new PackwrightError('unsafe_path', 'Transaction parent is not a safe directory.', {
      path: label,
    });
  }
  return {
    path: parentPath,
    realPath: canonical,
    label,
    ...fileIdentity(canonicalInfo),
  };
}

async function revalidateParent(identity: ParentIdentity, phase: string): Promise<void> {
  try {
    const info = await lstat(identity.path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('parent is not a real directory');
    }
    const canonical = await realpath(identity.path);
    const canonicalInfo = await lstat(canonical);
    if (
      canonical !== identity.realPath ||
      !canonicalInfo.isDirectory() ||
      canonicalInfo.isSymbolicLink() ||
      !sameIdentity(fileIdentity(canonicalInfo), identity)
    ) {
      throw new Error('parent identity no longer matches');
    }
  } catch (error) {
    throw new ParentIdentityMismatchError(identity.label, phase, error);
  }
}

async function requireKnownFile(
  filename: string,
  identity: FileIdentity,
  parent: ParentIdentity,
  phase: string,
): Promise<Stats> {
  await revalidateParent(parent, phase);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || !sameIdentity(fileIdentity(info), identity)) {
    throw new Error(`Transaction file identity changed before ${phase}.`);
  }
  await revalidateParent(parent, phase);
  return info;
}

async function unlinkKnownFile(
  filename: string,
  identity: FileIdentity,
  parent: ParentIdentity,
  phase: string,
): Promise<void> {
  await requireKnownFile(filename, identity, parent, phase);
  await revalidateParent(parent, phase);
  const immediate = await lstat(filename);
  if (
    !immediate.isFile() ||
    immediate.isSymbolicLink() ||
    !sameIdentity(fileIdentity(immediate), identity)
  ) {
    throw new Error(`Transaction file identity changed immediately before ${phase}.`);
  }
  await unlink(filename);
}

function validateWrites(
  workspace: Workspace,
  writes: readonly TransactionWrite[],
): {
  normalized: (TransactionWrite & { path: string; content: Buffer; sha256: string })[];
  totalBytes: number;
} {
  if (writes.length === 0 || writes.length > MAX_TRANSACTION_FILES) {
    throw new PackwrightError(
      'invalid_argument',
      `A visual transaction must contain 1-${String(MAX_TRANSACTION_FILES)} files.`,
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const normalized = writes.map((write) => {
    const normalizedPath = workspace.normalize(write.path);
    if (seen.has(normalizedPath)) {
      throw new PackwrightError('invalid_argument', 'A transaction cannot target a path twice.', {
        path: normalizedPath,
      });
    }
    seen.add(normalizedPath);
    const content = Buffer.isBuffer(write.content)
      ? Buffer.from(write.content)
      : typeof write.content === 'string'
        ? Buffer.from(write.content, 'utf8')
        : Buffer.from(write.content);
    totalBytes += content.length;
    if (totalBytes > MAX_TRANSACTION_BYTES) {
      throw new PackwrightError(
        'size_limit',
        `Visual transaction exceeds ${String(MAX_TRANSACTION_BYTES)} bytes.`,
      );
    }
    return {
      ...write,
      path: normalizedPath,
      content,
      sha256: sha256Buffer(content),
    };
  });
  return { normalized, totalBytes };
}

async function ensureParentDirectories(
  workspace: Workspace,
  targets: readonly string[],
): Promise<void> {
  const desired = new Set<string>();
  for (const target of targets) {
    let current = path.dirname(target);
    while (current !== workspace.root) {
      desired.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...desired].sort(
    (left, right) => left.split(path.sep).length - right.split(path.sep).length,
  )) {
    const containingParent = await captureParentIdentity(workspace, directory);
    const info = await optionalInfo(directory);
    if (info !== undefined) {
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new PackwrightError('unsafe_path', 'Transaction parent is not a safe directory.', {
          path: workspace.relative(directory),
        });
      }
      await captureParentIdentity(workspace, path.join(directory, '.packwright-parent-check'));
      continue;
    }
    try {
      await revalidateParent(containingParent, 'parent directory creation');
      await mkdir(directory, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = await optionalInfo(directory);
      if (raced === undefined || !raced.isDirectory() || raced.isSymbolicLink()) {
        throw new PackwrightError('unsafe_path', 'Transaction parent is not a safe directory.', {
          path: workspace.relative(directory),
        });
      }
    }
    await captureParentIdentity(workspace, path.join(directory, '.packwright-parent-check'));
  }
}

async function verifyPreconditions(
  workspace: Workspace,
  writes: readonly (TransactionWrite & { path: string; content: Buffer; sha256: string })[],
  transactionId: string,
): Promise<PreparedWrite[]> {
  const prepared: PreparedWrite[] = [];
  for (const write of writes) {
    const absolute = await workspace.resolve(write.path, { rejectSymlinks: true });
    const parent = await captureParentIdentity(workspace, absolute);
    const info = await optionalInfo(absolute);
    let previousSha256: string | undefined;
    let previousIdentity: FileIdentity | undefined;
    if (write.expectedSha256 === null) {
      if (info !== undefined) {
        throw new PackwrightError('already_exists', 'Transaction destination already exists.', {
          path: write.path,
        });
      }
    } else {
      if (info === undefined || !info.isFile() || info.isSymbolicLink()) {
        throw new PackwrightError('precondition_failed', 'Transaction destination changed.', {
          path: write.path,
          expectedSha256: write.expectedSha256,
        });
      }
      previousSha256 = await currentSha256(absolute, info.size, write.path);
      if (previousSha256 !== write.expectedSha256) {
        throw new PackwrightError('precondition_failed', 'Transaction destination changed.', {
          path: write.path,
          expectedSha256: write.expectedSha256,
          actualSha256: previousSha256,
        });
      }
      const verifiedInfo = await lstat(absolute);
      if (
        !verifiedInfo.isFile() ||
        verifiedInfo.isSymbolicLink() ||
        !sameIdentity(fileIdentity(verifiedInfo), fileIdentity(info))
      ) {
        throw new PackwrightError('precondition_failed', 'Transaction destination changed.', {
          path: write.path,
          expectedSha256: write.expectedSha256,
        });
      }
      previousIdentity = fileIdentity(verifiedInfo);
    }
    prepared.push({
      path: write.path,
      content: write.content,
      expectedSha256: write.expectedSha256,
      absolute,
      staged: path.join(
        path.dirname(absolute),
        `.${path.basename(absolute)}.${transactionId}.stage`,
      ),
      backup: path.join(
        path.dirname(absolute),
        `.${path.basename(absolute)}.${transactionId}.backup`,
      ),
      parent,
      sha256: write.sha256,
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
      ...(previousIdentity === undefined ? {} : { previousIdentity }),
      size: write.content.length,
      stageCreated: false,
      backupCreated: false,
      installed: false,
    });
  }
  return prepared;
}

async function rollback(prepared: readonly PreparedWrite[]): Promise<string[]> {
  const failures: string[] = [];
  for (const item of [...prepared].reverse()) {
    let itemFailed = false;
    try {
      if (item.installed) {
        if (item.installedIdentity === undefined) {
          throw new Error('installed file identity was not recorded');
        }
        const info = await requireKnownFile(
          item.absolute,
          item.installedIdentity,
          item.parent,
          'rollback removal',
        );
        const actual = await currentSha256(item.absolute, info.size, item.path);
        if (actual !== item.sha256) {
          throw new Error('installed file changed before rollback');
        }
        await unlinkKnownFile(
          item.absolute,
          item.installedIdentity,
          item.parent,
          'rollback removal',
        );
        item.installed = false;
      }
      if (item.backupCreated) {
        if (item.backupIdentity === undefined) {
          throw new Error('backup file identity was not recorded');
        }
        await requireKnownFile(item.backup, item.backupIdentity, item.parent, 'rollback restore');
        await revalidateParent(item.parent, 'rollback restore');
        // A hard link is the portable atomic no-replace restore. If another
        // writer owns the destination, EEXIST is a recovery condition and the
        // backup remains intact for an operator.
        await link(item.backup, item.absolute);
        const restored = await lstat(item.absolute);
        if (
          !restored.isFile() ||
          restored.isSymbolicLink() ||
          !sameIdentity(fileIdentity(restored), item.backupIdentity)
        ) {
          throw new Error('restored file identity does not match the backup');
        }
        await requireKnownFile(
          item.absolute,
          item.backupIdentity,
          item.parent,
          'restored destination verification',
        );
        await unlinkKnownFile(
          item.backup,
          item.backupIdentity,
          item.parent,
          'backup cleanup after restore',
        );
        item.backupCreated = false;
      }
    } catch (error) {
      failures.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
      itemFailed = true;
    }
    if (!itemFailed && item.stageCreated) {
      if (item.stageIdentity === undefined) {
        failures.push(`${item.path}: stage file identity was not recorded`);
      } else {
        try {
          await unlinkKnownFile(
            item.staged,
            item.stageIdentity,
            item.parent,
            'stage cleanup after rollback',
          );
          item.stageCreated = false;
        } catch (error) {
          failures.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return failures;
}

function recoveryRequired(
  transactionId: string,
  journalRelative: string,
  failures: readonly string[],
  journalWritten: boolean,
): PackwrightError {
  return new PackwrightError(
    'transaction_recovery_required',
    'Visual transaction could not be completed safely; inspect the retained recovery artifacts.',
    {
      transactionId,
      ...(journalWritten ? { journal: journalRelative } : {}),
      rollbackFailures: failures,
      limitation:
        'Node.js does not expose portable openat/renameat2 primitives; Packwright revalidates parent identity immediately before path mutations but cannot eliminate the final syscall race window.',
    },
  );
}

/**
 * Install a bounded set of generated files under one workspace transaction.
 * Every destination is hash-guarded before any rename occurs. The journal and
 * same-directory backups make partial failures recoverable and are removed only
 * after every destination has been installed successfully.
 */
export async function commitFileTransaction(
  workspace: Workspace,
  writes: readonly TransactionWrite[],
  signal?: AbortSignal,
): Promise<TransactionResult> {
  workspace.assertWritable();
  const checked = validateWrites(workspace, writes);
  const transactionId = randomUUID();
  const absolutes = await Promise.all(
    checked.normalized.map((write) => workspace.resolve(write.path, { rejectSymlinks: true })),
  );
  const journalRelative = `.packwright/transactions/${transactionId}.json`;
  const journalAbsolute = await workspace.resolve(journalRelative, { rejectSymlinks: true });
  const journalDirectory = path.dirname(journalAbsolute);

  // The shared journal-directory lock also protects the journal namespace and
  // in-process parent creation.
  // Destination locks still document and enforce the exact affected paths.
  return withPathLocks([...absolutes, journalDirectory], async () => {
    if (signal?.aborted) throw new PackwrightError('cancelled', 'Transaction was cancelled.');
    await ensureParentDirectories(workspace, [...absolutes, journalAbsolute]);
    let prepared: PreparedWrite[] = [];
    let journalWritten = false;
    let journalParent: ParentIdentity | undefined;
    let journalIdentity: FileIdentity | undefined;
    let commitComplete = false;
    try {
      journalParent = await captureParentIdentity(workspace, journalAbsolute);
      prepared = await verifyPreconditions(workspace, checked.normalized, transactionId);
      for (const item of prepared) {
        if (signal?.aborted) throw new PackwrightError('cancelled', 'Transaction was cancelled.');
        await revalidateParent(item.parent, 'stage creation');
        await writeFile(item.staged, item.content, { flag: 'wx', mode: 0o644 });
        item.stageCreated = true;
        await revalidateParent(item.parent, 'stage verification');
        const stageInfo = await lstat(item.staged);
        if (!stageInfo.isFile() || stageInfo.isSymbolicLink()) {
          throw new Error(`Transaction stage is not a regular file: ${item.path}.`);
        }
        item.stageIdentity = fileIdentity(stageInfo);
      }
      const journal = {
        schemaVersion: 1,
        transactionId,
        phase: 'prepared',
        files: prepared.map((item) => ({
          path: item.path,
          expectedSha256: item.expectedSha256,
          sha256: item.sha256,
          staged: path.basename(item.staged),
          backup: path.basename(item.backup),
        })),
      };
      await revalidateParent(journalParent, 'journal creation');
      await writeFile(journalAbsolute, `${JSON.stringify(journal, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      journalWritten = true;
      await revalidateParent(journalParent, 'journal verification');
      const journalInfo = await lstat(journalAbsolute);
      if (!journalInfo.isFile() || journalInfo.isSymbolicLink()) {
        throw new Error('Transaction journal is not a regular file.');
      }
      journalIdentity = fileIdentity(journalInfo);

      for (const item of prepared) {
        if (signal?.aborted) throw new PackwrightError('cancelled', 'Transaction was cancelled.');
        if (item.expectedSha256 !== null) {
          if (item.previousIdentity === undefined) {
            throw new Error(`Transaction destination identity was not recorded: ${item.path}.`);
          }
          await requireKnownFile(
            item.absolute,
            item.previousIdentity,
            item.parent,
            'backup creation',
          );
          if ((await optionalInfo(item.backup)) !== undefined) {
            throw new PackwrightError('already_exists', 'Transaction backup path already exists.', {
              path: item.path,
            });
          }
          await revalidateParent(item.parent, 'backup creation');
          await rename(item.absolute, item.backup);
          item.backupCreated = true;
          await revalidateParent(item.parent, 'backup verification');
          const backupInfo = await lstat(item.backup);
          if (
            !backupInfo.isFile() ||
            backupInfo.isSymbolicLink() ||
            !sameIdentity(fileIdentity(backupInfo), item.previousIdentity) ||
            (await currentSha256(item.backup, backupInfo.size, item.path)) !== item.expectedSha256
          ) {
            throw new PackwrightError(
              'precondition_failed',
              'Transaction destination changed immediately before replacement.',
              { path: item.path, expectedSha256: item.expectedSha256 },
            );
          }
          item.backupIdentity = fileIdentity(backupInfo);
        }
        if (item.stageIdentity === undefined) {
          throw new Error(`Transaction stage identity was not recorded: ${item.path}.`);
        }
        await requireKnownFile(item.staged, item.stageIdentity, item.parent, 'install');
        await revalidateParent(item.parent, 'install');
        // Hard-link installation is atomic and refuses to replace a destination
        // created by a concurrent writer, for both new files and replacements.
        await link(item.staged, item.absolute);
        item.installed = true;
        await revalidateParent(item.parent, 'install verification');
        const installedInfo = await lstat(item.absolute);
        if (
          !installedInfo.isFile() ||
          installedInfo.isSymbolicLink() ||
          !sameIdentity(fileIdentity(installedInfo), item.stageIdentity)
        ) {
          throw new Error(`Installed transaction file failed identity verification: ${item.path}.`);
        }
        item.installedIdentity = fileIdentity(installedInfo);
      }

      commitComplete = true;
      for (const item of prepared) {
        if (item.installedIdentity === undefined) {
          throw new Error(`Installed transaction file identity was not recorded: ${item.path}.`);
        }
        const installedInfo = await requireKnownFile(
          item.absolute,
          item.installedIdentity,
          item.parent,
          'committed output verification',
        );
        if ((await currentSha256(item.absolute, installedInfo.size, item.path)) !== item.sha256) {
          throw new Error(`Committed transaction file changed before finalization: ${item.path}.`);
        }
      }
      // Stages are removed before backups so any fail-closed finalization still
      // retains the old content and journal for manual recovery.
      for (const item of prepared) {
        if (item.stageCreated && item.stageIdentity !== undefined) {
          await unlinkKnownFile(
            item.staged,
            item.stageIdentity,
            item.parent,
            'committed stage cleanup',
          );
          item.stageCreated = false;
        }
      }
      for (const item of prepared) {
        if (item.backupCreated) {
          if (item.backupIdentity === undefined) {
            throw new Error(`Transaction backup identity was not recorded: ${item.path}.`);
          }
          if (item.installedIdentity === undefined) {
            throw new Error(`Installed transaction file identity was not recorded: ${item.path}.`);
          }
          await requireKnownFile(
            item.absolute,
            item.installedIdentity,
            item.parent,
            'output verification before backup cleanup',
          );
          await unlinkKnownFile(
            item.backup,
            item.backupIdentity,
            item.parent,
            'committed backup cleanup',
          );
          item.backupCreated = false;
        }
      }
      await unlinkKnownFile(
        journalAbsolute,
        journalIdentity,
        journalParent,
        'committed journal cleanup',
      );
      journalWritten = false;
      return {
        transactionId,
        files: prepared.map(({ path: file, sha256, previousSha256, size }) => ({
          path: file,
          sha256,
          ...(previousSha256 === undefined ? {} : { previousSha256 }),
          size,
        })),
      };
    } catch (error) {
      if (error instanceof ParentIdentityMismatchError || commitComplete) {
        throw recoveryRequired(
          transactionId,
          journalRelative,
          [error instanceof Error ? error.message : String(error)],
          journalWritten,
        );
      }
      const rollbackFailures = await rollback(prepared);
      if (rollbackFailures.length > 0) {
        throw recoveryRequired(transactionId, journalRelative, rollbackFailures, journalWritten);
      }
      if (journalWritten) {
        if (journalIdentity === undefined || journalParent === undefined) {
          throw recoveryRequired(
            transactionId,
            journalRelative,
            ['Transaction journal identity could not be verified for cleanup.'],
            journalWritten,
          );
        }
        try {
          await unlinkKnownFile(
            journalAbsolute,
            journalIdentity,
            journalParent,
            'rolled-back journal cleanup',
          );
          journalWritten = false;
        } catch (journalError) {
          throw recoveryRequired(
            transactionId,
            journalRelative,
            [journalError instanceof Error ? journalError.message : String(journalError)],
            journalWritten,
          );
        }
      }
      throw error;
    }
  });
}

export async function readTransactionJournal(
  workspace: Workspace,
  transactionId: string,
): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/u.test(transactionId)) {
    throw new PackwrightError('invalid_argument', 'Invalid transaction ID.');
  }
  const relative = `.packwright/transactions/${transactionId}.json`;
  const absolute = await workspace.resolve(relative, { mustExist: true, rejectSymlinks: true });
  return JSON.parse(await readFile(absolute, 'utf8')) as unknown;
}

export const VISUAL_TRANSACTION_LIMITS = Object.freeze({
  maxFiles: MAX_TRANSACTION_FILES,
  maxBytes: MAX_TRANSACTION_BYTES,
});
