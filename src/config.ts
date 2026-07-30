import path from 'node:path';

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

  return {
    workspaceRoot: requireAbsolute('workspace', workspace),
    javaCommand: overrides.java ?? process.env.PACKWRIGHT_JAVA ?? 'java',
    cacheDir: requireAbsolute('cache directory', configuredCache),
    readOnly: overrides.readOnly ?? environmentBoolean('PACKWRIGHT_READ_ONLY') ?? false,
    offline: overrides.offline ?? environmentBoolean('PACKWRIGHT_OFFLINE') ?? false,
    ...(spyglassCommand ? { spyglassCommand } : {}),
  };
}
