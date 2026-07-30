import { access, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { PackwrightError } from './errors.js';
import { joinRelative } from './files.js';
import { MAX_TEXT_WRITE_BYTES } from './limits.js';
import { scanDatapack } from './scanner.js';
import { readStableFile } from './stable-file.js';
import type { ResourceInventoryEntry } from './types.js';
import type { Workspace } from './workspace.js';

export async function detectDatapackRoot(workspace: Workspace, startPath: string): Promise<string> {
  const normalized = workspace.normalize(startPath);
  let candidate = normalized;
  const absolute = await workspace.resolve(normalized, {
    mustExist: true,
    rejectSymlinks: true,
  });
  if ((await stat(absolute)).isFile()) candidate = path.posix.dirname(candidate);

  for (;;) {
    const manifest = joinRelative(candidate === '.' ? '' : candidate, 'pack.mcmeta');
    const manifestAbsolute = await workspace.resolve(manifest, { rejectSymlinks: true });
    try {
      const info = await lstat(manifestAbsolute);
      if (info.isFile()) return candidate === '.' ? '' : candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (candidate === '' || candidate === '.') break;
    const parent = path.posix.dirname(candidate);
    candidate = parent === '.' ? '' : parent;
  }
  throw new PackwrightError('not_a_datapack', 'No pack.mcmeta was found at or above the path.', {
    path: normalized,
  });
}

export async function requireDatapack(workspace: Workspace, packPath: string): Promise<string> {
  const normalized = workspace.normalize(packPath);
  const root = await workspace.resolve(normalized, {
    mustExist: true,
    rejectSymlinks: true,
  });
  if (!(await stat(root)).isDirectory()) {
    throw new PackwrightError('not_a_datapack', 'Datapack path must be a directory.');
  }
  const manifest = await workspace
    .resolve(joinRelative(normalized, 'pack.mcmeta'), {
      mustExist: true,
      rejectSymlinks: true,
    })
    .catch((error: unknown) => {
      if (error instanceof PackwrightError && error.code === 'not_found') {
        throw new PackwrightError('not_a_datapack', 'Datapack does not contain pack.mcmeta.', {
          path: normalized,
        });
      }
      throw error;
    });
  if (!(await stat(manifest)).isFile()) {
    throw new PackwrightError('not_a_datapack', 'pack.mcmeta is not a file.');
  }
  return normalized;
}

export interface DatapackInspection {
  packPath: string;
  metadata: unknown;
  namespaces: string[];
  resources: ResourceInventoryEntry[];
  files: number;
  totalBytes: number;
  compatible: boolean;
  validationReady: boolean;
}

export interface InspectDatapackOptions {
  readonly signal?: AbortSignal | undefined;
}

export async function inspectDatapack(
  workspace: Workspace,
  packPath: string,
  options: InspectDatapackOptions = {},
): Promise<DatapackInspection> {
  const normalized = await requireDatapack(workspace, packPath);
  const manifestPath = await workspace.resolve(joinRelative(normalized, 'pack.mcmeta'), {
    mustExist: true,
    rejectSymlinks: true,
  });
  const scan = await scanDatapack(workspace, normalized, { signal: options.signal });
  const manifestEntry = scan.entries.find((entry) => entry.path === 'pack.mcmeta');
  let metadata: unknown;
  if (manifestEntry === undefined || manifestEntry.size > MAX_TEXT_WRITE_BYTES) {
    metadata = undefined;
  } else {
    const stable = await readStableFile(manifestPath, {
      maxBytes: manifestEntry.size,
      expected: manifestEntry,
      collect: true,
      signal: options.signal,
      pathLabel: 'pack.mcmeta',
    });
    try {
      metadata = JSON.parse(stable.data?.toString('utf8') ?? '');
    } catch {
      metadata = undefined;
    }
  }
  const namespaces = [
    ...new Set(
      scan.entries
        .map((entry) => /^data\/([^/]+)\//u.exec(entry.path)?.[1])
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
  const pack =
    metadata && typeof metadata === 'object'
      ? (metadata as { pack?: Record<string, unknown> }).pack
      : undefined;
  const compatible =
    JSON.stringify(pack?.min_format) === '[107,1]' &&
    JSON.stringify(pack?.max_format) === '[107,1]';

  return {
    packPath: normalized,
    metadata,
    namespaces,
    resources: scan.entries,
    files: scan.entries.length,
    totalBytes: scan.totalBytes,
    compatible,
    validationReady: true,
  };
}

export async function pathExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}
