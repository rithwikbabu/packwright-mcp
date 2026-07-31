import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { createTextDiff } from '../core/diff.js';
import { PackwrightError } from '../core/errors.js';
import { atomicWriteFile, joinRelative } from '../core/files.js';
import { sha256Buffer } from '../core/hash.js';
import { MAX_TEXT_WRITE_BYTES } from '../core/limits.js';
import { withPathLock } from '../core/locks.js';
import { readStableFile } from '../core/stable-file.js';
import type { MinecraftVersion, OperationResult, PackFormat } from '../core/types.js';
import { formatEquals, getVersionProfile } from '../core/version.js';
import type { Workspace } from '../core/workspace.js';

export const VISUAL_PROJECT_SCHEMA_VERSION = 1 as const;
export const VISUAL_PROJECTS_DIRECTORY = '.packwright/projects' as const;

export type VisualProjectTarget = 'vanilla';

export interface VisualProjectManifest {
  readonly schemaVersion: typeof VISUAL_PROJECT_SCHEMA_VERSION;
  readonly id: string;
  readonly minecraftVersion: MinecraftVersion;
  readonly datapack: string;
  readonly resourcepack: string;
  readonly target: VisualProjectTarget;
}

export interface AttachVisualProjectInput {
  readonly id: string;
  readonly minecraftVersion?: MinecraftVersion | undefined;
  readonly datapack: string;
  readonly resourcepack: string;
  readonly target?: VisualProjectTarget | undefined;
  readonly overwrite?: boolean | undefined;
  readonly expectedSha256?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export type AssociatedPackKind = 'datapack' | 'resourcepack';

export interface AssociatedPackInspection {
  readonly kind: AssociatedPackKind;
  readonly path: string;
  readonly present: boolean;
  readonly compatible: boolean;
  readonly expectedFormat: PackFormat;
  readonly actualFormat?: PackFormat | undefined;
  readonly metadataSha256?: string | undefined;
  readonly issues: readonly string[];
}

export interface VisualProjectInspection {
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: VisualProjectManifest;
  readonly datapack: AssociatedPackInspection;
  readonly resourcepack: AssociatedPackInspection;
  readonly ready: boolean;
}

interface ManifestSnapshot {
  readonly manifest: VisualProjectManifest;
  readonly sha256: string;
  readonly content: string;
}

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function isVisualProjectId(value: string): boolean {
  return PROJECT_ID_PATTERN.test(value);
}

function requireProjectId(value: string): string {
  if (!isVisualProjectId(value)) {
    throw new PackwrightError(
      'invalid_argument',
      'Visual project id must be 1-64 lowercase ASCII letters, digits, underscores, or hyphens and start with a letter or digit.',
      { id: value },
    );
  }
  return value;
}

export function visualProjectManifestPath(projectId: string): string {
  return `${VISUAL_PROJECTS_DIRECTORY}/${requireProjectId(projectId)}.json`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function manifestError(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new PackwrightError('invalid_content', message, details);
}

function normalizeAssociatedPath(
  workspace: Workspace,
  value: unknown,
  field: 'datapack' | 'resourcepack',
): string {
  if (typeof value !== 'string') {
    return manifestError(`Visual project ${field} must be a workspace-relative path.`);
  }
  let normalized: string;
  try {
    normalized = workspace.normalize(value);
  } catch (error) {
    if (error instanceof PackwrightError) {
      return manifestError(`Visual project ${field} path is unsafe.`, {
        path: value,
        cause: error.message,
      });
    }
    throw error;
  }
  if (
    normalized !== value ||
    normalized === '.packwright' ||
    normalized.startsWith('.packwright/')
  ) {
    return manifestError(
      `Visual project ${field} path must be canonical and outside .packwright.`,
      {
        path: value,
      },
    );
  }
  return normalized;
}

function assertSiblingPacks(datapack: string, resourcepack: string): void {
  if (datapack === resourcepack) {
    manifestError('Datapack and resource-pack paths must be different.', { datapack });
  }
  if (path.posix.dirname(datapack) !== path.posix.dirname(resourcepack)) {
    manifestError('Datapack and resource pack must be sibling directories.', {
      datapack,
      resourcepack,
    });
  }
}

export function parseVisualProjectManifest(
  workspace: Workspace,
  value: unknown,
  expectedId?: string,
): VisualProjectManifest {
  const object = recordValue(value);
  if (object === undefined) manifestError('Visual project manifest must be a JSON object.');
  const allowed = new Set([
    'schemaVersion',
    'id',
    'minecraftVersion',
    'datapack',
    'resourcepack',
    'target',
  ]);
  const unexpected = Object.keys(object).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    manifestError('Visual project manifest contains unsupported fields.', { unexpected });
  }
  if (object.schemaVersion !== VISUAL_PROJECT_SCHEMA_VERSION) {
    manifestError(`Unsupported visual project schema version: ${String(object.schemaVersion)}`);
  }
  if (typeof object.id !== 'string' || !isVisualProjectId(object.id)) {
    manifestError('Visual project manifest contains an invalid id.', { id: object.id });
  }
  if (expectedId !== undefined && object.id !== expectedId) {
    manifestError('Visual project id does not match its manifest filename.', {
      expectedId,
      actualId: object.id,
    });
  }
  if (object.minecraftVersion !== '26.2') {
    manifestError(`Unsupported Minecraft version: ${String(object.minecraftVersion)}`);
  }
  if (object.target !== 'vanilla') {
    manifestError(`Unsupported visual project target: ${String(object.target)}`);
  }
  const datapack = normalizeAssociatedPath(workspace, object.datapack, 'datapack');
  const resourcepack = normalizeAssociatedPath(workspace, object.resourcepack, 'resourcepack');
  assertSiblingPacks(datapack, resourcepack);
  return Object.freeze({
    schemaVersion: VISUAL_PROJECT_SCHEMA_VERSION,
    id: object.id,
    minecraftVersion: object.minecraftVersion,
    datapack,
    resourcepack,
    target: object.target,
  });
}

function serializeManifest(manifest: VisualProjectManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function optionalLstat(
  filename: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readManifestSnapshot(
  workspace: Workspace,
  projectId: string,
  required: boolean,
): Promise<ManifestSnapshot | undefined> {
  const manifestPath = visualProjectManifestPath(projectId);
  const absolute = await workspace.resolve(manifestPath, { rejectSymlinks: true });
  const info = await optionalLstat(absolute);
  if (info === undefined) {
    if (required) {
      throw new PackwrightError('not_found', 'Visual project manifest does not exist.', {
        projectId,
        path: manifestPath,
      });
    }
    return undefined;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PackwrightError(
      'invalid_content',
      'Visual project manifest must be a regular file.',
      {
        path: manifestPath,
      },
    );
  }
  const stable = await readStableFile(absolute, {
    maxBytes: MAX_TEXT_WRITE_BYTES,
    collect: true,
    pathLabel: manifestPath,
  });
  let value: unknown;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(stable.data);
  } catch {
    throw new PackwrightError('invalid_content', 'Visual project manifest is not valid UTF-8.', {
      path: manifestPath,
    });
  }
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new PackwrightError('invalid_content', 'Visual project manifest is not valid JSON.', {
      path: manifestPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    manifest: parseVisualProjectManifest(workspace, value, projectId),
    sha256: stable.snapshot.sha256,
    content,
  };
}

function parsePackFormat(value: unknown): PackFormat | undefined {
  const object = recordValue(value);
  const pack = recordValue(object?.pack);
  const minimum = pack?.min_format;
  const maximum = pack?.max_format;
  if (
    !Array.isArray(minimum) ||
    !Array.isArray(maximum) ||
    minimum.length !== 2 ||
    maximum.length !== 2 ||
    !minimum.every((part) => Number.isInteger(part) && part >= 0) ||
    !maximum.every((part) => Number.isInteger(part) && part >= 0) ||
    minimum[0] !== maximum[0] ||
    minimum[1] !== maximum[1]
  ) {
    return undefined;
  }
  return [minimum[0] as number, minimum[1] as number];
}

async function inspectAssociatedPack(
  workspace: Workspace,
  kind: AssociatedPackKind,
  packPath: string,
  expectedFormat: PackFormat,
): Promise<AssociatedPackInspection> {
  const issues: string[] = [];
  let root: string;
  try {
    root = await workspace.resolve(packPath, { mustExist: true, rejectSymlinks: true });
  } catch (error) {
    if (error instanceof PackwrightError && error.code === 'not_found') {
      return {
        kind,
        path: packPath,
        present: false,
        compatible: false,
        expectedFormat,
        issues: Object.freeze([`${kind} directory does not exist.`]),
      };
    }
    throw error;
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return {
      kind,
      path: packPath,
      present: true,
      compatible: false,
      expectedFormat,
      issues: Object.freeze([`${kind} path is not a regular directory.`]),
    };
  }
  const metadataPath = joinRelative(packPath, 'pack.mcmeta');
  let metadataAbsolute: string;
  try {
    metadataAbsolute = await workspace.resolve(metadataPath, {
      mustExist: true,
      rejectSymlinks: true,
    });
  } catch (error) {
    if (error instanceof PackwrightError && error.code === 'not_found') {
      return {
        kind,
        path: packPath,
        present: true,
        compatible: false,
        expectedFormat,
        issues: Object.freeze([`${kind} does not contain pack.mcmeta.`]),
      };
    }
    throw error;
  }
  const metadataInfo = await lstat(metadataAbsolute);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink()) {
    issues.push(`${kind} pack.mcmeta is not a regular file.`);
    return {
      kind,
      path: packPath,
      present: true,
      compatible: false,
      expectedFormat,
      issues: Object.freeze(issues),
    };
  }
  const metadata = await readStableFile(metadataAbsolute, {
    maxBytes: MAX_TEXT_WRITE_BYTES,
    collect: true,
    pathLabel: metadataPath,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata.data));
  } catch {
    issues.push(`${kind} pack.mcmeta is not valid UTF-8 JSON.`);
  }
  const actualFormat = parsePackFormat(parsed);
  if (actualFormat === undefined) {
    issues.push(`${kind} pack.mcmeta must declare identical two-part min_format and max_format.`);
  } else if (!formatEquals(actualFormat, expectedFormat)) {
    issues.push(
      `${kind} format ${actualFormat.join('.')} does not match Minecraft 26.2 format ${expectedFormat.join('.')}.`,
    );
  }
  return {
    kind,
    path: packPath,
    present: true,
    compatible: issues.length === 0,
    expectedFormat,
    actualFormat,
    metadataSha256: metadata.snapshot.sha256,
    issues: Object.freeze(issues),
  };
}

async function inspectPair(
  workspace: Workspace,
  manifest: VisualProjectManifest,
): Promise<Pick<VisualProjectInspection, 'datapack' | 'resourcepack' | 'ready'>> {
  const profile = getVersionProfile(manifest.minecraftVersion);
  const [datapack, resourcepack] = await Promise.all([
    inspectAssociatedPack(workspace, 'datapack', manifest.datapack, profile.dataPack.packFormat),
    inspectAssociatedPack(
      workspace,
      'resourcepack',
      manifest.resourcepack,
      profile.resourcePack.packFormat,
    ),
  ]);
  return { datapack, resourcepack, ready: datapack.compatible && resourcepack.compatible };
}

export async function inspectVisualProject(
  workspace: Workspace,
  projectId: string,
): Promise<VisualProjectInspection> {
  const snapshot = await readManifestSnapshot(workspace, requireProjectId(projectId), true);
  if (snapshot === undefined) throw new Error('Required visual project manifest was not read.');
  const packs = await inspectPair(workspace, snapshot.manifest);
  return {
    manifestPath: visualProjectManifestPath(projectId),
    manifestSha256: snapshot.sha256,
    manifest: snapshot.manifest,
    ...packs,
  };
}

export async function attachVisualProject(
  workspace: Workspace,
  input: AttachVisualProjectInput,
): Promise<OperationResult<VisualProjectInspection>> {
  workspace.assertWritable();
  const id = requireProjectId(input.id);
  const manifest = parseVisualProjectManifest(workspace, {
    schemaVersion: VISUAL_PROJECT_SCHEMA_VERSION,
    id,
    minecraftVersion: input.minecraftVersion ?? '26.2',
    datapack: input.datapack,
    resourcepack: input.resourcepack,
    target: input.target ?? 'vanilla',
  });
  const manifestPath = visualProjectManifestPath(id);
  const absolute = await workspace.resolve(manifestPath, { rejectSymlinks: true });

  return withPathLock(absolute, async () => {
    const pair = await inspectPair(workspace, manifest);
    if (!pair.ready) {
      throw new PackwrightError(
        'validation_failed',
        'Both associated packs must exist and match the Minecraft 26.2 formats before attachment.',
        {
          datapackIssues: pair.datapack.issues,
          resourcepackIssues: pair.resourcepack.issues,
        },
      );
    }
    const current = await readManifestSnapshot(workspace, id, false);
    const content = serializeManifest(manifest);
    const sha256 = sha256Buffer(content);
    const changed = current?.sha256 !== sha256;
    if (current !== undefined && changed) {
      if (!input.overwrite) {
        throw new PackwrightError(
          'precondition_required',
          'overwrite: true is required to change an existing visual project association.',
        );
      }
      if (input.expectedSha256 === undefined) {
        throw new PackwrightError(
          'precondition_required',
          'expectedSha256 is required to change an existing visual project association.',
        );
      }
      if (input.expectedSha256 !== current.sha256) {
        throw new PackwrightError(
          'precondition_failed',
          'Visual project manifest changed since it was inspected.',
          { expectedSha256: input.expectedSha256, actualSha256: current.sha256 },
        );
      }
    } else if (current === undefined && input.expectedSha256 !== undefined) {
      throw new PackwrightError(
        'precondition_failed',
        'Visual project manifest does not exist for the supplied expectedSha256.',
        { expectedSha256: input.expectedSha256 },
      );
    }
    const inspection: VisualProjectInspection = {
      manifestPath,
      manifestSha256: sha256,
      manifest,
      ...pair,
    };
    const result: OperationResult<VisualProjectInspection> = {
      ok: true,
      operation: 'visual_project_attach',
      changed,
      dryRun: input.dryRun ?? false,
      path: manifestPath,
      sha256,
      previousSha256: current?.sha256,
      diff: createTextDiff(current?.content, content, manifestPath),
      value: inspection,
      diagnostics: [],
    };
    if (changed && !input.dryRun) {
      await atomicWriteFile(workspace, manifestPath, content, {
        expectedSha256: current?.sha256,
        requireAbsent: current === undefined,
      });
    }
    return result;
  });
}
