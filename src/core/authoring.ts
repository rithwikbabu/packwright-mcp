import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTextDiff } from './diff.js';
import { PackwrightError } from './errors.js';
import { atomicWriteFile, joinRelative } from './files.js';
import { sha256Buffer } from './hash.js';
import { isValidNamespace } from './identifiers.js';
import { MAX_MCP_PAYLOAD_BYTES, MAX_SCAN_BYTES, MAX_TEXT_WRITE_BYTES } from './limits.js';
import { withPathLock } from './locks.js';
import { requireDatapack } from './project.js';
import {
  assertAuthorableTextPath,
  resolveLocator,
  resourcePath,
  type ResourceLocator,
} from './resources.js';
import type { OperationResult } from './types.js';
import { createPackMetadata, MINECRAFT_26_2 } from './version.js';
import type { Workspace } from './workspace.js';

export interface CreateDatapackInput {
  packPath: string;
  namespace: string;
  description: unknown;
  loadFunction?: string;
  tickFunction?: string;
  dryRun?: boolean;
}

export interface CreatedDatapack {
  minecraftVersion: '26.2';
  namespace: string;
  files: { path: string; sha256: string }[];
}

function prettyJson(value: unknown): string {
  try {
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new PackwrightError('invalid_content', 'Value is not JSON serializable.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeFunctionContent(content: string): string {
  if (content.includes('\0')) {
    throw new PackwrightError('invalid_content', 'Function content may not contain NUL bytes.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_WRITE_BYTES) {
    throw new PackwrightError('size_limit', 'Function content exceeds the text write limit.');
  }
  return content.endsWith('\n') ? content : `${content}\n`;
}

async function existingInfo(
  absolutePath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

interface StableFileRead {
  readonly size: number;
  readonly captured: Buffer;
  readonly sha256: string;
}

async function readStableFile(
  filename: string,
  captureLimit: number,
  maxBytes = MAX_SCAN_BYTES,
): Promise<StableFileRead> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const captured: Buffer[] = [];
  const hash = createHash('sha256');
  const utf8Validator = new TextDecoder('utf-8', { fatal: true });
  let bytesReadTotal = 0;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PackwrightError('not_found', 'Resource is not a file.');
    if (info.size > maxBytes) {
      throw new PackwrightError(
        'size_limit',
        `Resource exceeds the ${String(maxBytes)} byte safety limit.`,
      );
    }
    const boundedCapture = Math.min(info.size, captureLimit);
    while (bytesReadTotal < info.size) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, info.size - bytesReadTotal));
      const read = await handle.read(chunk, 0, chunk.length, bytesReadTotal);
      if (read.bytesRead === 0) break;
      const bytes = chunk.subarray(0, read.bytesRead);
      hash.update(bytes);
      try {
        utf8Validator.decode(bytes, { stream: true });
      } catch {
        throw new PackwrightError('invalid_content', 'Resource is not valid UTF-8 text.');
      }
      if (bytesReadTotal < boundedCapture) {
        captured.push(bytes.subarray(0, Math.min(bytes.length, boundedCapture - bytesReadTotal)));
      }
      bytesReadTotal += read.bytesRead;
    }
    const after = await handle.stat();
    try {
      utf8Validator.decode();
    } catch {
      throw new PackwrightError('invalid_content', 'Resource is not valid UTF-8 text.');
    }
    if (
      bytesReadTotal !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    ) {
      throw new PackwrightError('precondition_failed', 'Resource changed while it was read.');
    }
    return {
      size: info.size,
      captured: Buffer.concat(captured),
      sha256: hash.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

export async function createDatapack(
  workspace: Workspace,
  input: CreateDatapackInput,
): Promise<OperationResult<CreatedDatapack>> {
  workspace.assertWritable();
  const packPath = workspace.normalize(input.packPath);
  if (!isValidNamespace(input.namespace)) {
    throw new PackwrightError('invalid_resource_id', `Invalid namespace: ${input.namespace}`);
  }
  const load = input.loadFunction === undefined ? undefined : `${input.namespace}:load`;
  const tick = input.tickFunction === undefined ? undefined : `${input.namespace}:tick`;
  const files = new Map<string, string>();
  files.set('pack.mcmeta', prettyJson(createPackMetadata(input.description)));

  if (load !== undefined && input.loadFunction !== undefined) {
    files.set(resourcePath('function', load), normalizeFunctionContent(input.loadFunction));
  }
  if (tick !== undefined && input.tickFunction !== undefined) {
    files.set(resourcePath('function', tick), normalizeFunctionContent(input.tickFunction));
  }
  if (load) {
    files.set('data/minecraft/tags/function/load.json', prettyJson({ values: [load] }));
  }
  if (tick) {
    files.set('data/minecraft/tags/function/tick.json', prettyJson({ values: [tick] }));
  }

  const target = await workspace.resolve(packPath, { rejectSymlinks: true });
  return withPathLock(target, async () => {
    if (await existingInfo(target)) {
      throw new PackwrightError('already_exists', 'Datapack target already exists.', {
        path: packPath,
      });
    }
    const value: CreatedDatapack = {
      minecraftVersion: '26.2',
      namespace: input.namespace,
      files: [...files.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([file, content]) => ({ path: file, sha256: sha256Buffer(content) })),
    };
    if (input.dryRun) {
      return {
        ok: true,
        operation: 'datapack_create',
        changed: true,
        dryRun: true,
        path: packPath,
        value,
        diagnostics: [],
      };
    }

    const parent = path.posix.dirname(packPath);
    await workspace.ensureDirectory(parent === '.' ? '' : parent);
    const refreshedTarget = await workspace.resolve(packPath, { rejectSymlinks: true });
    if (await existingInfo(refreshedTarget)) {
      throw new PackwrightError('already_exists', 'Datapack target already exists.', {
        path: packPath,
      });
    }
    const stage = path.join(
      path.dirname(refreshedTarget),
      `.packwright-${path.basename(refreshedTarget)}-${randomUUID()}`,
    );
    const createdDirectories: string[] = [];
    const linkedFiles: { source: string; target: string; expectedSha256: string }[] = [];
    let targetClaimed = false;
    try {
      await mkdir(stage, { mode: 0o755 });
      for (const [file, content] of files) {
        const destination = path.join(stage, ...file.split('/'));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
        await writeFile(destination, content, { flag: 'wx', mode: 0o644 });
      }

      // mkdir is the portable atomic no-replace claim for a directory. Files
      // are then hard-linked from private staging, with pack.mcmeta installed
      // last so discovery never sees a successfully named partial pack.
      try {
        await mkdir(refreshedTarget, { mode: 0o755 });
        targetClaimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new PackwrightError('already_exists', 'Datapack target was created concurrently.', {
            path: packPath,
          });
        }
        throw error;
      }

      const directoryNames = new Set<string>();
      for (const file of files.keys()) {
        const parts = file.split('/').slice(0, -1);
        for (let length = 1; length <= parts.length; length += 1) {
          directoryNames.add(parts.slice(0, length).join('/'));
        }
      }
      for (const directory of [...directoryNames].sort(
        (left, right) => left.split('/').length - right.split('/').length,
      )) {
        const destination = path.join(refreshedTarget, ...directory.split('/'));
        await mkdir(destination, { mode: 0o755 });
        createdDirectories.push(destination);
      }

      const orderedFiles = [...files.entries()].sort(([left], [right]) => {
        if (left === 'pack.mcmeta') return 1;
        if (right === 'pack.mcmeta') return -1;
        return left.localeCompare(right, 'en');
      });
      for (const [file, content] of orderedFiles) {
        const source = path.join(stage, ...file.split('/'));
        const destination = path.join(refreshedTarget, ...file.split('/'));
        try {
          await link(source, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new PackwrightError(
              'already_exists',
              'Datapack target was populated concurrently.',
              { path: joinRelative(packPath, file) },
            );
          }
          throw error;
        }
        linkedFiles.push({
          source,
          target: destination,
          expectedSha256: sha256Buffer(content),
        });
      }

      for (const linked of linkedFiles) {
        const [sourceInfo, targetInfo] = await Promise.all([
          lstat(linked.source),
          lstat(linked.target),
        ]);
        if (
          !sourceInfo.isFile() ||
          !targetInfo.isFile() ||
          sourceInfo.dev !== targetInfo.dev ||
          sourceInfo.ino !== targetInfo.ino ||
          (await readStableFile(linked.source, MAX_TEXT_WRITE_BYTES, MAX_TEXT_WRITE_BYTES))
            .sha256 !== linked.expectedSha256
        ) {
          throw new PackwrightError(
            'precondition_failed',
            'Datapack changed while it was being created.',
            { path: workspace.relative(linked.target) },
          );
        }
      }
      await rm(stage, { recursive: true, force: true });
    } catch (error) {
      for (const linked of linkedFiles.reverse()) {
        try {
          const [sourceInfo, targetInfo] = await Promise.all([
            lstat(linked.source),
            lstat(linked.target),
          ]);
          if (sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino) {
            await unlink(linked.target);
          }
        } catch {
          // A concurrently replaced path is not ours to remove.
        }
      }
      for (const directory of createdDirectories.reverse()) {
        await rmdir(directory).catch(() => undefined);
      }
      if (targetClaimed) await rmdir(refreshedTarget).catch(() => undefined);
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }

    return {
      ok: true,
      operation: 'datapack_create',
      changed: true,
      dryRun: false,
      path: packPath,
      value,
      diagnostics: [],
    };
  });
}

export interface ResourceReadResult {
  path: string;
  content: string;
  size: number;
  bytesReturned: number;
  sha256: string;
  truncated: boolean;
}

export async function readResource(
  workspace: Workspace,
  packPath: string,
  locator: ResourceLocator,
): Promise<ResourceReadResult> {
  const pack = await requireDatapack(workspace, packPath);
  const inner = workspace.normalize(resolveLocator(locator, MINECRAFT_26_2));
  assertAuthorableTextPath(inner);
  const relative = joinRelative(pack, inner);
  const absolute = await workspace.resolve(relative, {
    mustExist: true,
    rejectSymlinks: true,
  });
  const result = await readStableFile(absolute, MAX_MCP_PAYLOAD_BYTES);
  const buffer = result.captured;
  let content: string;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    content = decoder.decode(buffer, { stream: result.size > buffer.length });
  } catch {
    throw new PackwrightError('invalid_content', 'Resource is not valid UTF-8 text.');
  }
  return {
    path: inner,
    content,
    size: result.size,
    bytesReturned: Buffer.byteLength(content, 'utf8'),
    sha256: result.sha256,
    truncated: result.size > buffer.length,
  };
}

export interface ResourceUpsertInput extends ResourceLocator {
  content: string;
  overwrite?: boolean;
  expectedSha256?: string;
  dryRun?: boolean;
}

function validateTextContent(relativePath: string, content: string): void {
  if (content.includes('\0')) {
    throw new PackwrightError('invalid_content', 'Text resources may not contain NUL bytes.');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_TEXT_WRITE_BYTES) {
    throw new PackwrightError(
      'size_limit',
      `Text resource exceeds the ${String(MAX_TEXT_WRITE_BYTES)} byte write limit.`,
    );
  }
  if (relativePath.endsWith('.json') || relativePath.endsWith('.mcmeta')) {
    try {
      JSON.parse(content);
    } catch (error) {
      throw new PackwrightError('invalid_content', 'Resource is not valid JSON.', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function upsertResource(
  workspace: Workspace,
  packPath: string,
  input: ResourceUpsertInput,
): Promise<OperationResult> {
  workspace.assertWritable();
  const pack = await requireDatapack(workspace, packPath);
  const inner = workspace.normalize(resolveLocator(input, MINECRAFT_26_2));
  assertAuthorableTextPath(inner);
  validateTextContent(inner, input.content);
  const relative = joinRelative(pack, inner);
  const absolute = await workspace.resolve(relative, { rejectSymlinks: true });

  return withPathLock(absolute, async () => {
    const refreshed = await workspace.resolve(relative, { rejectSymlinks: true });
    const info = await existingInfo(refreshed);
    let before: string | undefined;
    let previousSha256: string | undefined;
    if (info) {
      if (!info.isFile()) {
        throw new PackwrightError('invalid_argument', 'Resource target is not a file.');
      }
      if (!input.overwrite) {
        throw new PackwrightError(
          'precondition_required',
          'overwrite: true is required to replace an existing resource.',
        );
      }
      if (!input.expectedSha256) {
        throw new PackwrightError(
          'precondition_required',
          'expectedSha256 is required to replace an existing resource.',
        );
      }
      if (info.size > MAX_TEXT_WRITE_BYTES) {
        throw new PackwrightError('size_limit', 'Existing resource is too large to author safely.');
      }
      const current = await readStableFile(refreshed, MAX_TEXT_WRITE_BYTES, MAX_TEXT_WRITE_BYTES);
      previousSha256 = current.sha256;
      if (previousSha256 !== input.expectedSha256) {
        throw new PackwrightError('precondition_failed', 'Resource changed since it was read.', {
          expectedSha256: input.expectedSha256,
          actualSha256: previousSha256,
        });
      }
      try {
        before = new TextDecoder('utf-8', { fatal: true }).decode(current.captured);
      } catch {
        throw new PackwrightError('invalid_content', 'Existing resource is not valid UTF-8 text.');
      }
    }

    const sha256 = sha256Buffer(input.content);
    const changed = previousSha256 !== sha256;
    const result: OperationResult = {
      ok: true,
      operation: 'resource_upsert',
      changed,
      dryRun: input.dryRun ?? false,
      path: inner,
      sha256,
      previousSha256,
      diff: createTextDiff(before, input.content, inner),
      diagnostics: [],
    };
    if (!input.dryRun && changed) {
      await atomicWriteFile(workspace, relative, input.content, {
        expectedSha256: previousSha256,
        requireAbsent: previousSha256 === undefined,
      });
    }
    return result;
  });
}

export interface ResourceDeleteInput extends ResourceLocator {
  confirm: boolean;
  expectedSha256: string;
  dryRun?: boolean;
}

export async function deleteResource(
  workspace: Workspace,
  packPath: string,
  input: ResourceDeleteInput,
): Promise<OperationResult> {
  workspace.assertWritable();
  if (!input.confirm) {
    throw new PackwrightError(
      'confirmation_required',
      'confirm: true is required to delete a resource.',
    );
  }
  if (!input.expectedSha256) {
    throw new PackwrightError(
      'precondition_required',
      'expectedSha256 is required to delete a resource.',
    );
  }
  const pack = await requireDatapack(workspace, packPath);
  const inner = workspace.normalize(resolveLocator(input, MINECRAFT_26_2));
  assertAuthorableTextPath(inner);
  if (inner === 'pack.mcmeta') {
    throw new PackwrightError('invalid_argument', 'pack.mcmeta cannot be deleted.');
  }
  const relative = joinRelative(pack, inner);
  const absolute = await workspace.resolve(relative, {
    mustExist: true,
    rejectSymlinks: true,
  });

  return withPathLock(absolute, async () => {
    const refreshed = await workspace.resolve(relative, {
      mustExist: true,
      rejectSymlinks: true,
    });
    const info = await lstat(refreshed);
    if (!info.isFile()) {
      throw new PackwrightError('invalid_argument', 'Delete target must be an exact file.');
    }
    if (input.dryRun) {
      const current = await readStableFile(refreshed, MAX_TEXT_WRITE_BYTES);
      if (current.sha256 !== input.expectedSha256) {
        throw new PackwrightError('precondition_failed', 'Resource changed since it was read.', {
          expectedSha256: input.expectedSha256,
          actualSha256: current.sha256,
        });
      }
      let before: string | undefined;
      try {
        before = new TextDecoder('utf-8', { fatal: true }).decode(current.captured);
      } catch {
        before = undefined;
      }
      return {
        ok: true,
        operation: 'resource_delete',
        changed: true,
        dryRun: true,
        path: inner,
        previousSha256: current.sha256,
        diff: createTextDiff(before, undefined, inner),
        diagnostics: [],
      };
    }

    const quarantine = path.join(
      path.dirname(refreshed),
      `.${path.basename(refreshed)}.packwright-delete-${randomUUID()}.tmp`,
    );
    await rename(refreshed, quarantine);
    let quarantineExists = true;
    try {
      const current = await readStableFile(quarantine, MAX_TEXT_WRITE_BYTES);
      if (current.sha256 !== input.expectedSha256) {
        throw new PackwrightError('precondition_failed', 'Resource changed since it was read.', {
          expectedSha256: input.expectedSha256,
          actualSha256: current.sha256,
        });
      }
      let before: string | undefined;
      try {
        before = new TextDecoder('utf-8', { fatal: true }).decode(current.captured);
      } catch {
        before = undefined;
      }
      await unlink(quarantine);
      quarantineExists = false;
      return {
        ok: true,
        operation: 'resource_delete',
        changed: true,
        dryRun: false,
        path: inner,
        previousSha256: current.sha256,
        diff: createTextDiff(before, undefined, inner),
        diagnostics: [],
      };
    } catch (error) {
      if (quarantineExists) {
        try {
          // Hard-linking is an atomic no-replace restore: a concurrently created
          // target is never overwritten. The quarantine remains recoverable if
          // restoration loses that race.
          await link(quarantine, refreshed);
          await unlink(quarantine);
          quarantineExists = false;
        } catch (restoreError) {
          if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') throw restoreError;
        }
      }
      throw error;
    }
  });
}
