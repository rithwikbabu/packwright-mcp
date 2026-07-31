import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import envPaths from 'env-paths';

import { PackwrightError } from './core/errors.js';

export interface RuntimeConfig {
  readonly workspaceRoot: string;
  readonly javaCommand: string;
  readonly cacheDir: string;
  readonly readOnly: boolean;
  readonly offline: boolean;
  readonly spyglassCommand?: string;
}

export interface RuntimeConfigOverrides {
  readonly workspace?: string;
  readonly java?: string;
  readonly cacheDir?: string;
  readonly readOnly?: boolean;
  readonly offline?: boolean;
}

function environmentBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new PackwrightError(
    'invalid_argument',
    `${name} must be one of true, false, 1, 0, yes, no, on, or off.`,
  );
}

function requireAbsolute(name: string, value: string): string {
  if (!path.isAbsolute(value)) {
    throw new PackwrightError('invalid_argument', `${name} must be an absolute path.`, {
      value,
    });
  }
  return path.resolve(value);
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function assertSeparatedPaths(workspaceRoot: string, cacheDir: string): void {
  if (containsPath(workspaceRoot, cacheDir) || containsPath(cacheDir, workspaceRoot)) {
    throw new PackwrightError(
      'invalid_argument',
      'The cache directory and workspace root must not overlap in either direction.',
      { workspaceRoot, cacheDir },
    );
  }
}

async function canonicalPotentialPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      await lstat(current);
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve existing path components before comparing the workspace and cache.
 * This catches aliases through symlinks even when the cache leaf does not yet exist.
 */
export async function assertRuntimePathSeparation(config: RuntimeConfig): Promise<void> {
  const [workspaceRoot, cacheDir] = await Promise.all([
    canonicalPotentialPath(config.workspaceRoot),
    canonicalPotentialPath(config.cacheDir),
  ]);
  assertSeparatedPaths(workspaceRoot, cacheDir);
}

export function resolveRuntimeConfig(overrides: RuntimeConfigOverrides = {}): RuntimeConfig {
  const workspace = overrides.workspace ?? process.env.PACKWRIGHT_WORKSPACE;
  if (workspace === undefined || workspace.trim() === '') {
    throw new PackwrightError(
      'invalid_workspace',
      'An absolute workspace is required through --workspace or PACKWRIGHT_WORKSPACE.',
    );
  }

  const configuredCache =
    overrides.cacheDir ??
    process.env.PACKWRIGHT_CACHE_DIR ??
    envPaths('packwright-mcp', { suffix: '' }).cache;
  const spyglassCommand = process.env.PACKWRIGHT_SPYGLASS_COMMAND?.trim();

  const workspaceRoot = requireAbsolute('workspace', workspace);
  const cacheDir = requireAbsolute('cache directory', configuredCache);
  // Fail immediately for direct lexical overlap. Startup performs the stronger
  // canonical check so symlink aliases cannot bypass this boundary.
  assertSeparatedPaths(workspaceRoot, cacheDir);

  return {
    workspaceRoot,
    javaCommand: overrides.java ?? process.env.PACKWRIGHT_JAVA ?? 'java',
    cacheDir,
    readOnly: overrides.readOnly ?? environmentBoolean('PACKWRIGHT_READ_ONLY') ?? false,
    offline: overrides.offline ?? environmentBoolean('PACKWRIGHT_OFFLINE') ?? false,
    ...(spyglassCommand ? { spyglassCommand } : {}),
  };
}
