import { stat } from 'node:fs/promises';
import { PackwrightError } from './errors.js';
import { joinRelative } from './files.js';
import { isValidNamespace, isValidResourceId } from './identifiers.js';
import { MAX_TEXT_WRITE_BYTES } from './limits.js';
import { parseResourcePath } from './resources.js';
import { scanDatapack, type ScanResult } from './scanner.js';
import { readStableFile } from './stable-file.js';
import type { Diagnostic, ValidationAdapter, ValidationResult } from './types.js';
import { formatEquals, MINECRAFT_26_2 } from './version.js';
import type { Workspace } from './workspace.js';

const LEGACY_PLURAL_DIRECTORIES = new Set([
  'advancements',
  'functions',
  'item_modifiers',
  'loot_tables',
  'predicates',
  'recipes',
  'structures',
]);

const WORLDGEN_DIRECTORIES = new Set([
  'biome',
  'configured_carver',
  'configured_feature',
  'density_function',
  'flat_level_generator_preset',
  'multi_noise_biome_source_parameter_list',
  'noise',
  'noise_settings',
  'placed_feature',
  'processor_list',
  'structure',
  'structure_set',
  'template_pool',
  'world_preset',
]);

const resourceDirectoryMappings = Object.values(MINECRAFT_26_2.resourceDirectories).sort(
  (left, right) => right.directory.length - left.directory.length,
);

const CUSTOM_REGISTRY_DIRECTORY_PATTERN = /^[a-z0-9._-]+$/u;

function diagnostic(
  code: string,
  message: string,
  path?: string,
  severity: Diagnostic['severity'] = 'error',
  suggestedFix?: string,
): Diagnostic {
  return {
    engine: 'packwright',
    authority: 'structural',
    severity,
    code,
    message,
    path,
    suggestedFix,
  };
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PackwrightError('cancelled', 'Validation was cancelled.');
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractTagId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const entry = objectValue(value);
  return typeof entry?.id === 'string' ? entry.id : undefined;
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    (left.path ?? '').localeCompare(right.path ?? '', 'en') ||
    left.code.localeCompare(right.code, 'en') ||
    left.message.localeCompare(right.message, 'en')
  );
}

function expectedDataExtension(pathWithinNamespace: string): readonly string[] | undefined {
  const mapping = resourceDirectoryMappings.find((candidate) =>
    pathWithinNamespace.startsWith(`${candidate.directory}/`),
  );
  if (mapping) {
    return mapping.directory === 'structure' ? ['.nbt', '.snbt'] : [mapping.extension];
  }
  const parts = pathWithinNamespace.split('/');
  if (parts[0] === 'tags' && parts.length >= 3) return ['.json'];
  if (parts[0] === 'worldgen' && parts[1] !== undefined && WORLDGEN_DIRECTORIES.has(parts[1])) {
    return ['.json'];
  }
  return undefined;
}

function basicSnbtError(content: string): string | undefined {
  const stack: string[] = [];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of content) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{' || character === '[') {
      stack.push(character);
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.pop() !== expected) return `Unexpected closing delimiter ${character}.`;
    }
  }
  if (quote) return 'SNBT contains an unterminated quoted string.';
  if (stack.length > 0) return `SNBT contains an unclosed ${stack.at(-1) ?? 'delimiter'}.`;
  return undefined;
}

export interface ValidateOptions {
  adapters?: readonly ValidationAdapter[] | undefined;
  signal?: AbortSignal | undefined;
  onScan?: ((scan: ScanResult) => void) | undefined;
}

export async function validateDatapack(
  workspace: Workspace,
  packPath: string,
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const diagnostics: Diagnostic[] = [];
  abortIfNeeded(options.signal);
  let pack: string;
  try {
    pack = workspace.normalize(packPath);
    const absolute = await workspace.resolve(pack, {
      mustExist: true,
      rejectSymlinks: true,
    });
    if (!(await stat(absolute)).isDirectory()) {
      diagnostics.push(diagnostic('pack.not_directory', 'Datapack path is not a directory.', pack));
      return { ok: false, diagnostics, filesScanned: 0, bytesScanned: 0 };
    }
  } catch (error) {
    if (error instanceof PackwrightError && error.code !== 'cancelled') {
      diagnostics.push(diagnostic(`path.${error.code}`, error.message, packPath));
      return { ok: false, diagnostics, filesScanned: 0, bytesScanned: 0 };
    }
    throw error;
  }

  let scan;
  try {
    scan = await scanDatapack(workspace, pack, { signal: options.signal });
    options.onScan?.(scan);
  } catch (error) {
    if (error instanceof PackwrightError) {
      diagnostics.push(diagnostic(`scan.${error.code}`, error.message, pack));
      return { ok: false, diagnostics, filesScanned: 0, bytesScanned: 0 };
    }
    throw error;
  }
  const files = new Set(scan.entries.map((entry) => entry.path));
  const parsedJson = new Map<string, unknown>();
  const identities = new Map<string, string>();

  if (!files.has('pack.mcmeta')) {
    diagnostics.push(
      diagnostic(
        'pack.missing_metadata',
        'pack.mcmeta is required at the root of the datapack.',
        'pack.mcmeta',
      ),
    );
  }

  for (const entry of scan.entries) {
    abortIfNeeded(options.signal);
    const parts = entry.path.split('/');
    if (parts[0] === 'data') {
      const namespace = parts[1];
      const resourceDirectory = parts[2];
      if (namespace !== undefined && !isValidNamespace(namespace)) {
        diagnostics.push(
          diagnostic(
            'resource.invalid_namespace',
            `Invalid namespace directory: ${namespace}`,
            entry.path,
          ),
        );
      }
      if (
        namespace !== undefined &&
        resourceDirectory !== undefined &&
        LEGACY_PLURAL_DIRECTORIES.has(resourceDirectory)
      ) {
        const singular = resourceDirectory.replace(/ies$/u, 'y').replace(/s$/u, '');
        diagnostics.push(
          diagnostic(
            'layout.legacy_plural_directory',
            `Minecraft 26.2 uses singular resource directories; found ${resourceDirectory}.`,
            entry.path,
            'error',
            `Move this resource under data/${namespace}/${singular}/.`,
          ),
        );
      }

      if (namespace === undefined || resourceDirectory === undefined) {
        diagnostics.push(
          diagnostic(
            'layout.invalid_data_path',
            'Files beneath data must be inside a namespace and resource directory.',
            entry.path,
          ),
        );
      } else {
        const withinNamespace = parts.slice(2).join('/');
        const expectedExtensions = expectedDataExtension(withinNamespace);
        const actualExtension = `.${entry.path.split('.').at(-1) ?? ''}`;
        if (
          !expectedExtensions &&
          (!CUSTOM_REGISTRY_DIRECTORY_PATTERN.test(resourceDirectory) ||
            actualExtension !== '.json')
        ) {
          diagnostics.push(
            diagnostic(
              'layout.unsupported_resource_directory',
              `Unsupported Minecraft 26.2 resource directory: ${resourceDirectory}.`,
              entry.path,
            ),
          );
        } else if (expectedExtensions && !expectedExtensions.includes(actualExtension)) {
          diagnostics.push(
            diagnostic(
              'layout.invalid_extension',
              `Expected ${expectedExtensions.join(' or ')} beneath this resource directory.`,
              entry.path,
            ),
          );
        }
      }
    }

    const resource = parseResourcePath(entry.path);
    if (resource) {
      if (!isValidResourceId(resource.id)) {
        diagnostics.push(
          diagnostic(
            'resource.invalid_id',
            `Invalid resource identifier: ${resource.id}`,
            entry.path,
          ),
        );
      }
      const identity = `${resource.type}:${resource.id}`;
      const previous = identities.get(identity);
      if (previous) {
        diagnostics.push(
          diagnostic(
            'resource.duplicate',
            `Duplicate ${resource.type} resource ${resource.id}; first found at ${previous}.`,
            entry.path,
          ),
        );
      } else {
        identities.set(identity, entry.path);
      }
    }

    if (
      entry.path.endsWith('.json') ||
      entry.path.endsWith('.mcmeta') ||
      entry.path.endsWith('.mcfunction') ||
      entry.path.endsWith('.snbt')
    ) {
      if (entry.size > MAX_TEXT_WRITE_BYTES) {
        diagnostics.push(
          diagnostic(
            'text.size_limit',
            `Text resource exceeds the ${String(MAX_TEXT_WRITE_BYTES)} byte validation limit.`,
            entry.path,
          ),
        );
        continue;
      }
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
      const bytes = stable.data;
      if (bytes === undefined) {
        throw new PackwrightError(
          'precondition_failed',
          'Stable validation read returned no data.',
          {
            path: entry.path,
          },
        );
      }
      let content: string | undefined;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        diagnostics.push(
          diagnostic('text.invalid_utf8', 'Text resource is not valid UTF-8.', entry.path),
        );
      }
      if (content?.includes('\0')) {
        diagnostics.push(
          diagnostic('text.nul_byte', 'Text resources may not contain NUL bytes.', entry.path),
        );
      }
      if (
        content !== undefined &&
        (entry.path.endsWith('.json') || entry.path.endsWith('.mcmeta'))
      ) {
        try {
          parsedJson.set(entry.path, JSON.parse(content));
        } catch (error) {
          diagnostics.push(
            diagnostic(
              'json.invalid',
              `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
              entry.path,
            ),
          );
        }
      }
      if (content !== undefined && entry.path.endsWith('.snbt')) {
        const error = basicSnbtError(content);
        if (error) {
          diagnostics.push(
            diagnostic(
              'snbt.basic_structure',
              error,
              entry.path,
              'error',
              "Fix the delimiter or quoted string; Packwright's built-in check is not a full SNBT parser.",
            ),
          );
        }
      }
    }
  }

  const metadata = objectValue(parsedJson.get('pack.mcmeta'));
  if (files.has('pack.mcmeta') && metadata) {
    const packObject = objectValue(metadata.pack);
    if (!packObject) {
      diagnostics.push(
        diagnostic(
          'pack.invalid_metadata',
          'pack.mcmeta must contain a pack object.',
          'pack.mcmeta',
        ),
      );
    } else {
      if (
        !Array.isArray(packObject.min_format) ||
        !formatEquals(packObject.min_format as number[], MINECRAFT_26_2.packFormat)
      ) {
        diagnostics.push(
          diagnostic(
            'pack.unsupported_min_format',
            'pack.min_format must be [107, 1] for Minecraft 26.2.',
            'pack.mcmeta',
          ),
        );
      }
      if (
        !Array.isArray(packObject.max_format) ||
        !formatEquals(packObject.max_format as number[], MINECRAFT_26_2.packFormat)
      ) {
        diagnostics.push(
          diagnostic(
            'pack.unsupported_max_format',
            'pack.max_format must be [107, 1] for Minecraft 26.2.',
            'pack.mcmeta',
          ),
        );
      }
      if (!('description' in packObject)) {
        diagnostics.push(
          diagnostic('pack.missing_description', 'pack.description is required.', 'pack.mcmeta'),
        );
      }
    }
  } else if (files.has('pack.mcmeta') && !parsedJson.has('pack.mcmeta')) {
    // The JSON parser already emitted the actionable diagnostic.
  } else if (files.has('pack.mcmeta')) {
    diagnostics.push(
      diagnostic('pack.invalid_metadata', 'pack.mcmeta must contain a JSON object.', 'pack.mcmeta'),
    );
  }

  for (const tagName of ['load', 'tick'] as const) {
    const tagPath = `data/minecraft/tags/function/${tagName}.json`;
    if (!files.has(tagPath) || !parsedJson.has(tagPath)) continue;
    const tag = objectValue(parsedJson.get(tagPath));
    if (!tag || !Array.isArray(tag.values)) {
      diagnostics.push(
        diagnostic(
          'tag.invalid_values',
          `${tagName} function tag must contain a values array.`,
          tagPath,
        ),
      );
      continue;
    }
    for (const value of tag.values) {
      const rawId = extractTagId(value);
      if (!rawId) {
        diagnostics.push(
          diagnostic(
            'tag.invalid_entry',
            'Function tag entries must contain a resource ID.',
            tagPath,
          ),
        );
        continue;
      }
      const isTag = rawId.startsWith('#');
      const id = isTag ? rawId.slice(1) : rawId;
      if (!isValidResourceId(id)) {
        diagnostics.push(
          diagnostic('tag.invalid_reference', `Invalid function reference: ${rawId}`, tagPath),
        );
        continue;
      }
      const [namespace, resourceName] = id.split(':', 2) as [string, string];
      const target = isTag
        ? `data/${namespace}/tags/function/${resourceName}.json`
        : `data/${namespace}/function/${resourceName}.mcfunction`;
      if (!files.has(target)) {
        diagnostics.push(
          diagnostic(
            'tag.missing_reference',
            `${rawId} does not resolve to a resource in this datapack.`,
            tagPath,
            'error',
            `Create ${target} or remove the reference.`,
          ),
        );
      }
    }
  }

  const packRoot = await workspace.resolve(pack, { mustExist: true, rejectSymlinks: true });
  for (const adapter of options.adapters ?? []) {
    abortIfNeeded(options.signal);
    try {
      diagnostics.push(...(await adapter.validate(packRoot, options.signal)));
    } catch (error) {
      if (options.signal?.aborted)
        throw new PackwrightError('cancelled', 'Validation was cancelled.');
      diagnostics.push({
        engine: adapter.name,
        authority: 'advisory',
        severity: 'warning',
        code: 'adapter.failed',
        message: `Validation adapter failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  diagnostics.sort(compareDiagnostics);
  return {
    ok: !diagnostics.some((entry) => entry.severity === 'error'),
    diagnostics,
    filesScanned: scan.entries.length,
    bytesScanned: scan.totalBytes,
  };
}
