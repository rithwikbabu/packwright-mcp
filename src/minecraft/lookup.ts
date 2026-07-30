import type { Diagnostic } from '../core/types.js';
import { MINECRAFT_26_2, RESOURCE_TYPES } from '../core/version.js';
import type {
  CachedRegistriesResult,
  MinecraftLookupInput,
  MinecraftLookupResult,
} from '../mcp/schemas.js';
import { cacheUnavailableDiagnostic, emptyRegistryMap, loadReferenceCache } from './cache.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function collectCommands(report: unknown): string[] {
  const output = new Set<string>();

  function visit(node: unknown, prefix: readonly string[]): void {
    const object = asObject(node);
    const children = asObject(object?.children);
    if (children === undefined) return;
    for (const [name, child] of Object.entries(children)) {
      const childObject = asObject(child);
      const type = childObject?.type;
      const next = type === 'literal' ? [...prefix, name] : prefix;
      if (next.length > 0) output.add(next.join(' '));
      visit(child, next);
    }
  }

  visit(report, []);
  return [...output].sort((left, right) => left.localeCompare(right, 'en'));
}

function collectRegistries(report: unknown): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const [rawRegistry, value] of Object.entries(asObject(report) ?? {})) {
    const registry = rawRegistry.replace(/^minecraft:/u, '');
    const entries = asObject(asObject(value)?.entries);
    output[registry] = Object.keys(entries ?? {}).sort((left, right) =>
      left.localeCompare(right, 'en'),
    );
  }
  return output;
}

export async function lookupMinecraft(
  cacheDir: string,
  input: MinecraftLookupInput,
): Promise<MinecraftLookupResult> {
  const cache = await loadReferenceCache(cacheDir);
  const query = input.query.toLowerCase();
  const categories = new Set(
    input.categories ?? ['command', 'registry', 'resource_type', 'identifier'],
  );
  const candidates: MinecraftLookupResult['results'] = [];

  if (categories.has('resource_type')) {
    for (const resourceType of RESOURCE_TYPES) {
      if (resourceType.includes(query)) {
        candidates.push({ category: 'resource_type', id: resourceType });
      }
    }
  }

  if (cache !== undefined) {
    if (categories.has('command')) {
      for (const command of collectCommands(cache.commands)) {
        if (command.toLowerCase().includes(query)) {
          candidates.push({ category: 'command', id: command });
        }
      }
    }
    const registries = collectRegistries(cache.registries);
    for (const [registry, ids] of Object.entries(registries)) {
      if (categories.has('registry') && registry.toLowerCase().includes(query)) {
        candidates.push({
          category: 'registry',
          id: registry,
          summary: `${String(ids.length)} cached identifiers`,
        });
      }
      if (categories.has('identifier')) {
        for (const id of ids) {
          if (id.toLowerCase().includes(query)) {
            candidates.push({
              category: 'identifier',
              id,
              summary: `Registry: ${registry}`,
            });
          }
        }
      }
    }
  }

  candidates.sort(
    (left, right) =>
      left.category.localeCompare(right.category, 'en') || left.id.localeCompare(right.id, 'en'),
  );
  return {
    ok: true,
    minecraftVersion: '26.2',
    query: input.query,
    cacheReady: cache !== undefined,
    results: candidates.slice(0, input.limit),
    truncated: candidates.length > input.limit,
  };
}

export async function getCachedRegistries(cacheDir: string): Promise<CachedRegistriesResult> {
  const cache = await loadReferenceCache(cacheDir);
  if (cache === undefined) {
    return {
      ok: true,
      minecraftVersion: '26.2',
      cacheReady: false,
      registries: emptyRegistryMap(),
      resourceTypes: [...RESOURCE_TYPES],
      diagnostics: [cacheUnavailableDiagnostic()],
      truncated: false,
    };
  }

  const diagnostics: Diagnostic[] = [];
  const commands = collectCommands(cache.commands);
  const registries = collectRegistries(cache.registries);
  const boundedRegistries: Record<string, string[]> = {};
  const boundedCommands: string[] = [];
  let approximateBytes = 0;
  let truncated = false;
  for (const command of commands) {
    const bytes = Buffer.byteLength(command, 'utf8') + 4;
    if (approximateBytes + bytes > 96 * 1024) {
      truncated = true;
      break;
    }
    boundedCommands.push(command);
    approximateBytes += bytes;
  }
  for (const [registry, identifiers] of Object.entries(registries)) {
    const bounded: string[] = [];
    for (const identifier of identifiers) {
      const bytes = Buffer.byteLength(identifier, 'utf8') + 4;
      if (approximateBytes + bytes > 520 * 1024) {
        truncated = true;
        break;
      }
      bounded.push(identifier);
      approximateBytes += bytes;
    }
    boundedRegistries[registry] = bounded;
    if (truncated) break;
  }
  if (truncated) {
    diagnostics.push({
      engine: 'packwright',
      authority: 'structural',
      severity: 'information',
      code: 'payload.truncated',
      message:
        'The cached registry resource was truncated to stay within the MCP payload limit; use minecraft_lookup for targeted search.',
    });
  }

  return {
    ok: true,
    minecraftVersion: '26.2',
    cacheReady: true,
    ...(cache.generatedAt === undefined ? {} : { generatedAt: cache.generatedAt }),
    commands: boundedCommands,
    registries: boundedRegistries,
    resourceTypes: [...RESOURCE_TYPES],
    diagnostics,
    truncated,
  };
}

export function supportedVersionResource(): Record<string, unknown> {
  return {
    minecraftVersion: MINECRAFT_26_2.minecraftVersion,
    packFormat: [...MINECRAFT_26_2.packFormat],
    javaMajor: MINECRAFT_26_2.javaMajor,
    resourceDirectories: MINECRAFT_26_2.resourceDirectories,
    supportedRegistries: MINECRAFT_26_2.supportedRegistries,
    experimentalFlags: MINECRAFT_26_2.experimentalFlags,
  };
}
