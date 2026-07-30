import path from 'node:path';
import { PackwrightError } from './errors.js';
import { parseResourceId } from './identifiers.js';
import { MINECRAFT_26_2, type ResourceType, type VersionProfile } from './version.js';

export const AUTHORABLE_TEXT_EXTENSIONS = new Set(['.json', '.mcfunction', '.mcmeta', '.snbt']);

export interface ResourceLocator {
  path?: string;
  type?: ResourceType;
  id?: string;
}

export function resourcePath(
  type: ResourceType,
  id: string,
  profile: VersionProfile = MINECRAFT_26_2,
): string {
  const parsed = parseResourceId(id);
  const mapping = profile.resourceDirectories[type];
  return `data/${parsed.namespace}/${mapping.directory}/${parsed.path}${mapping.extension}`;
}

export function resolveLocator(
  locator: ResourceLocator,
  profile: VersionProfile = MINECRAFT_26_2,
): string {
  if (locator.path !== undefined) {
    if (locator.type !== undefined || locator.id !== undefined) {
      throw new PackwrightError(
        'invalid_argument',
        'Provide either path, or both type and id, but not both.',
      );
    }
    return locator.path;
  }
  if (locator.type === undefined || locator.id === undefined) {
    throw new PackwrightError(
      'invalid_argument',
      'Provide either path, or both type and id, but not both.',
    );
  }
  return resourcePath(locator.type, locator.id, profile);
}

export function assertAuthorableTextPath(relativePath: string): void {
  const extension = path.posix.extname(relativePath);
  if (!AUTHORABLE_TEXT_EXTENSIONS.has(extension)) {
    throw new PackwrightError(
      'unsupported_resource',
      `Authoring ${extension || 'extensionless'} files is not supported.`,
      { path: relativePath },
    );
  }
}

export interface ParsedResourcePath {
  type: ResourceType;
  id: string;
}

const directoryMappings = Object.entries(MINECRAFT_26_2.resourceDirectories).sort(
  (left, right) => right[1].directory.length - left[1].directory.length,
) as [ResourceType, { directory: string; extension: string }][];

export function parseResourcePath(relativePath: string): ParsedResourcePath | undefined {
  const parts = relativePath.split('/');
  if (parts[0] !== 'data' || parts.length < 4) return undefined;
  const namespace = parts[1];
  if (namespace === undefined) return undefined;
  const withinNamespace = parts.slice(2).join('/');

  for (const [type, mapping] of directoryMappings) {
    const prefix = `${mapping.directory}/`;
    if (!withinNamespace.startsWith(prefix) || !withinNamespace.endsWith(mapping.extension)) {
      continue;
    }
    const resourceName = withinNamespace.slice(prefix.length, -mapping.extension.length);
    if (resourceName) return { type, id: `${namespace}:${resourceName}` };
  }
  return undefined;
}
