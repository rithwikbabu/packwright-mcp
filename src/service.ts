import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  Workspace,
  PackwrightError,
  buildDatapack,
  createDatapack,
  deleteResource,
  inspectDatapack,
  readResource,
  sha256Buffer,
  upsertResource,
  validateDatapack,
  type Diagnostic,
  type ResourceLocator,
  type ValidationAdapter,
  type ValidationResult,
} from './core/index.js';
import type { RuntimeConfig } from './config.js';
import { getCacheStatus } from './minecraft/cache.js';
import { runGameTests } from './minecraft/gametest.js';
import { VanillaCommandValidationAdapter } from './minecraft/command-validation.js';
import { getJavaVersion } from './minecraft/java.js';
import {
  getCachedRegistries as readCachedRegistries,
  lookupMinecraft as searchMinecraft,
} from './minecraft/lookup.js';
import type {
  CachedRegistriesResult,
  DatapackBuildInput,
  DatapackCreateInput,
  DatapackInspectInput,
  DatapackInspectResult,
  DatapackTestInput,
  DatapackValidateInput,
  JsonValue,
  LastDiagnosticsResult,
  MinecraftLookupInput,
  MinecraftLookupResult,
  ProjectSummary,
  ResourceDeleteInput,
  ResourceReadInput,
  ResourceReadResult,
  ResourceUpsertInput,
} from './mcp/schemas.js';
import type { PackwrightService, PackwrightServiceContext } from './mcp/service.js';
import type { BuildResult, GameTestResult, OperationResult } from './core/types.js';
import {
  ExternalSpyglassAdapter,
  getSpyglassStatus,
  spyglassUnavailableDiagnostic,
} from './validation/spyglass.js';

interface StoredDiagnostics {
  readonly validation: ValidationResult;
  readonly updatedAt: string;
}

const INVENTORY_PAYLOAD_BUDGET = 480 * 1024;
const DIAGNOSTIC_PAYLOAD_BUDGET = 96 * 1024;
const TEST_CASE_PAYLOAD_BUDGET = 220 * 1024;
const LOG_PAYLOAD_BUDGET = 140 * 1024;
const RESOURCE_RESULT_PAYLOAD_BUDGET = 700 * 1024;
const PROJECT_LIST_PAYLOAD_BUDGET = 96 * 1024;
const NAMESPACE_PAYLOAD_BUDGET = 48 * 1024;
const METADATA_PAYLOAD_BUDGET = 48 * 1024;

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safePrefix(value: string, length: number): string {
  let end = Math.min(length, value.length);
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return value.slice(0, end);
}

function fitString<T>(
  value: string,
  byteBudget: number,
  create: (content: string, truncated: boolean) => T,
): { readonly result: T; readonly truncated: boolean } {
  const complete = create(value, false);
  if (serializedBytes(complete) <= byteBudget) return { result: complete, truncated: false };
  let low = 0;
  let high = value.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = safePrefix(value, middle);
    if (serializedBytes(create(candidate, true)) <= byteBudget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { result: create(best, true), truncated: true };
}

function boundedItems<T>(
  items: readonly T[],
  byteBudget: number,
): { readonly items: T[]; readonly truncated: boolean } {
  const output: T[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (bytes + itemBytes > byteBudget) {
      return { items: output, truncated: true };
    }
    output.push(item);
    bytes += itemBytes;
  }
  return { items: output, truncated: false };
}

function boundedDiagnostics(diagnostics: readonly Diagnostic[]): {
  readonly diagnostics: Diagnostic[];
  readonly truncated: boolean;
} {
  const priority: Record<Diagnostic['severity'], number> = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3,
  };
  const ordered = [...diagnostics].sort(
    (left, right) => priority[left.severity] - priority[right.severity],
  );
  const bounded = boundedItems(ordered, DIAGNOSTIC_PAYLOAD_BUDGET);
  if (!bounded.truncated) return { diagnostics: bounded.items, truncated: false };
  const marker: Diagnostic = {
    engine: 'packwright',
    authority: 'structural',
    severity: 'information',
    code: 'payload.truncated',
    message:
      'Additional diagnostics were omitted to keep the MCP response within the one MiB payload limit.',
  };
  const withMarker = boundedItems([...bounded.items, marker], DIAGNOSTIC_PAYLOAD_BUDGET);
  return { diagnostics: withMarker.items, truncated: true };
}

function boundedText(value: string | undefined): {
  readonly value?: string;
  readonly truncated: boolean;
} {
  if (value === undefined) return { truncated: false };
  const bounded = fitString(value, LOG_PAYLOAD_BUDGET, (content, truncated) =>
    truncated ? `${content}\n... output truncated ...` : content,
  );
  return { value: bounded.result, truncated: bounded.truncated };
}

function boundedMetadata(value: JsonValue): {
  readonly value: JsonValue;
  readonly truncated: boolean;
} {
  if (serializedBytes(value) <= METADATA_PAYLOAD_BUDGET) {
    return { value, truncated: false };
  }
  return {
    value: {
      truncated: true,
      message:
        'pack.mcmeta was omitted from this response because it exceeds the MCP payload budget.',
    },
    truncated: true,
  };
}

function selector(input: ResourceReadInput['selector']): ResourceLocator {
  return input.kind === 'path' ? { path: input.path } : { type: input.resourceType, id: input.id };
}

function combinedHash(entries: readonly { path: string; sha256: string }[]): string {
  return sha256Buffer(
    entries
      .map((entry) => `${entry.path}\0${entry.sha256}\n`)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .join(''),
  );
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function mimeType(filename: string): string {
  if (filename.endsWith('.json') || filename.endsWith('.mcmeta')) {
    return 'application/json';
  }
  if (filename.endsWith('.mcfunction')) return 'text/x-mcfunction';
  if (filename.endsWith('.snbt')) return 'text/x-snbt';
  return 'text/plain';
}

function contentText(content: ResourceUpsertInput['content']): string {
  if (content.kind === 'text') return content.text;
  return content.pretty
    ? `${JSON.stringify(content.value, null, 2)}\n`
    : JSON.stringify(content.value);
}

function gameTestTimeout(startedAt: number, timeoutMs: number): GameTestResult {
  return {
    ok: false,
    status: 'timeout',
    durationMs: Date.now() - startedAt,
    tests: [],
    diagnostics: [
      {
        engine: 'minecraft',
        authority: 'authoritative',
        severity: 'error',
        code: 'minecraft.timeout',
        message: `Datapack validation and GameTests exceeded the ${String(timeoutMs)} ms timeout.`,
      },
    ],
  };
}

export class PackwrightApplication implements PackwrightService {
  readonly config: RuntimeConfig;
  readonly workspace: Workspace;
  private readonly lastDiagnostics = new Map<string, StoredDiagnostics>();
  private projectListTruncated = false;

  private constructor(config: RuntimeConfig, workspace: Workspace) {
    this.config = config;
    this.workspace = workspace;
  }

  static async open(config: RuntimeConfig): Promise<PackwrightApplication> {
    const workspace = await Workspace.open(config.workspaceRoot, {
      readOnly: config.readOnly,
    });
    return new PackwrightApplication(config, workspace);
  }

  async createDatapack(
    input: DatapackCreateInput,
    context: PackwrightServiceContext,
  ): Promise<OperationResult<JsonValue>> {
    await context.reportProgress({ progress: 0, total: 1, message: 'Preparing datapack' });
    const result = await createDatapack(this.workspace, {
      packPath: input.project,
      namespace: input.namespace,
      description: input.description,
      ...(input.loadFunction === undefined ? {} : { loadFunction: input.loadFunction }),
      ...(input.tickFunction === undefined ? {} : { tickFunction: input.tickFunction }),
      dryRun: input.dryRun,
    });
    await context.reportProgress({ progress: 1, total: 1, message: 'Datapack prepared' });
    const { value, ...base } = result;
    return {
      ...base,
      ...(value === undefined ? {} : { value: asJson(value) }),
    };
  }

  async inspectDatapack(
    input: DatapackInspectInput,
    context: PackwrightServiceContext,
  ): Promise<DatapackInspectResult> {
    await context.reportProgress({ progress: 0, total: 2, message: 'Scanning datapack' });
    const [inspection, cache, java, spyglass] = await Promise.all([
      inspectDatapack(this.workspace, input.project, { signal: context.signal }),
      getCacheStatus(this.config.cacheDir),
      getJavaVersion(this.config.javaCommand, context.signal),
      this.config.spyglassCommand === undefined
        ? Promise.resolve(undefined)
        : getSpyglassStatus(this.config.spyglassCommand, context.signal),
    ]);
    const validation = await validateDatapack(this.workspace, input.project, {
      signal: context.signal,
    });
    const resources = boundedItems(inspection.resources, INVENTORY_PAYLOAD_BUDGET);
    const diagnostics = boundedDiagnostics(validation.diagnostics);
    const namespaces = boundedItems(inspection.namespaces, NAMESPACE_PAYLOAD_BUDGET);
    const metadata = boundedMetadata(asJson(inspection.metadata));
    await context.reportProgress({ progress: 2, total: 2, message: 'Inspection complete' });
    return {
      ok: true,
      project: inspection.packPath,
      metadata: metadata.value,
      minecraftVersion: '26.2',
      packFormat: [107, 1],
      compatible: inspection.compatible,
      namespaces: namespaces.items,
      resources: resources.items,
      files: inspection.files,
      totalBytes: inspection.totalBytes,
      sha256: combinedHash(inspection.resources),
      validationReadiness: {
        structural: true,
        spyglass: spyglass?.compatible ?? false,
        vanilla: cache.ready && java.available && java.major === 25,
      },
      diagnostics: diagnostics.diagnostics,
      truncated:
        resources.truncated || diagnostics.truncated || namespaces.truncated || metadata.truncated,
    };
  }

  async readResource(input: ResourceReadInput): Promise<ResourceReadResult> {
    const resource = await readResource(this.workspace, input.project, selector(input.selector));
    const bounded = fitString(
      resource.content,
      RESOURCE_RESULT_PAYLOAD_BUDGET,
      (content, truncated): ResourceReadResult => ({
        ok: true,
        project: input.project,
        path: resource.path,
        mimeType: mimeType(resource.path),
        content,
        sha256: resource.sha256,
        size: resource.size,
        bytesReturned: Buffer.byteLength(content, 'utf8'),
        truncated: resource.truncated || truncated,
      }),
    );
    return bounded.result;
  }

  async upsertResource(input: ResourceUpsertInput): Promise<OperationResult<JsonValue>> {
    const result = await upsertResource(this.workspace, input.project, {
      ...selector(input.selector),
      content: contentText(input.content),
      overwrite: input.overwrite,
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      dryRun: input.dryRun,
    });
    const { value, ...base } = result;
    return {
      ...base,
      ...(value === undefined ? {} : { value: asJson(value) }),
    };
  }

  async deleteResource(input: ResourceDeleteInput): Promise<OperationResult<JsonValue>> {
    const result = await deleteResource(this.workspace, input.project, {
      ...selector(input.selector),
      confirm: input.confirm,
      expectedSha256: input.expectedSha256,
    });
    const { value, ...base } = result;
    return {
      ...base,
      ...(value === undefined ? {} : { value: asJson(value) }),
    };
  }

  async validateDatapack(
    input: DatapackValidateInput,
    context: PackwrightServiceContext,
  ): Promise<ValidationResult> {
    const total = 1 + (input.includeVanilla ? 1 : 0) + (input.includeSpyglass ? 1 : 0);
    await context.reportProgress({
      progress: 0,
      total,
      message: 'Running structural validation',
    });
    let spyglassUnavailableReason: string | undefined;
    let spyglassAdapter: ExternalSpyglassAdapter | undefined;
    if (input.includeSpyglass && this.config.spyglassCommand !== undefined) {
      const status = await getSpyglassStatus(this.config.spyglassCommand, context.signal);
      if (context.signal.aborted) {
        throw new PackwrightError('cancelled', 'Validation was cancelled.');
      }
      if (status.compatible) {
        spyglassAdapter = new ExternalSpyglassAdapter(this.config.spyglassCommand);
      } else {
        spyglassUnavailableReason = status.description;
      }
    }
    const vanillaAdapter = input.includeVanilla
      ? new VanillaCommandValidationAdapter(this.config)
      : undefined;
    const adapters: ValidationAdapter[] = [];
    if (vanillaAdapter !== undefined) adapters.push(vanillaAdapter);
    if (spyglassAdapter !== undefined) adapters.push(spyglassAdapter);
    const result = await validateDatapack(this.workspace, input.project, {
      adapters,
      signal: context.signal,
    });
    const diagnostics: Diagnostic[] = [...result.diagnostics];
    if (input.includeSpyglass && spyglassAdapter === undefined) {
      diagnostics.push(spyglassUnavailableDiagnostic(spyglassUnavailableReason));
    }
    const bounded = boundedDiagnostics(diagnostics);
    const vanilla = vanillaAdapter?.lastResult;
    const normalized: ValidationResult = {
      ...result,
      diagnostics: bounded.diagnostics,
      ok: !diagnostics.some((item) => item.severity === 'error'),
      ...(vanilla === undefined
        ? {}
        : {
            vanilla: {
              status: vanilla.status,
              filesChecked: vanilla.filesChecked,
              commandLinesChecked: vanilla.commandLinesChecked,
              macroLinesDeferred: vanilla.macroLinesDeferred,
              durationMs: vanilla.durationMs,
            },
          }),
      truncated: bounded.truncated,
    };
    this.lastDiagnostics.set(input.project, {
      validation: normalized,
      updatedAt: new Date().toISOString(),
    });
    await context.reportProgress({
      progress: total,
      total,
      message: 'Validation complete',
    });
    return normalized;
  }

  async lookupMinecraft(input: MinecraftLookupInput): Promise<MinecraftLookupResult> {
    return await searchMinecraft(this.config.cacheDir, input);
  }

  async testDatapack(
    input: DatapackTestInput,
    context: PackwrightServiceContext,
  ): Promise<GameTestResult> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + input.timeoutMs;
    const operationController = new AbortController();
    const forwardCancellation = (): void => operationController.abort();
    const deadlineReached = (): boolean => Date.now() >= deadlineAt && !context.signal.aborted;
    context.signal.addEventListener('abort', forwardCancellation, { once: true });
    if (context.signal.aborted) forwardCancellation();
    const deadlineTimer = setTimeout(() => {
      operationController.abort();
    }, input.timeoutMs);
    deadlineTimer.unref();

    try {
      await context.reportProgress({ progress: 0, total: 3, message: 'Validating datapack' });
      const vanillaAdapter = new VanillaCommandValidationAdapter(
        this.config,
        input.timeoutMs,
        deadlineAt,
      );
      const validation = await validateDatapack(this.workspace, input.project, {
        adapters: [vanillaAdapter],
        signal: operationController.signal,
      });
      if (deadlineReached()) return gameTestTimeout(startedAt, input.timeoutMs);
      if (!validation.ok) {
        const diagnostics = boundedDiagnostics(validation.diagnostics);
        const vanillaStatus = vanillaAdapter.lastResult?.status;
        return {
          ok: false,
          status:
            vanillaStatus === 'setup_required'
              ? 'setup_required'
              : vanillaStatus === 'timeout'
                ? 'timeout'
                : 'failed',
          durationMs: Date.now() - startedAt,
          tests: [],
          diagnostics: diagnostics.diagnostics,
          truncated: diagnostics.truncated,
        };
      }
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) return gameTestTimeout(startedAt, input.timeoutMs);
      await context.reportProgress({
        progress: 2,
        total: 3,
        message: 'Running disposable vanilla GameTests',
      });
      const result = await runGameTests(
        this.config,
        this.workspace,
        {
          project: input.project,
          ...(input.tests === undefined ? {} : { tests: input.tests }),
          timeoutMs: remainingMs,
        },
        operationController.signal,
      );
      if (deadlineReached()) return gameTestTimeout(startedAt, input.timeoutMs);
      await context.reportProgress({ progress: 3, total: 3, message: 'GameTests complete' });
      const tests = boundedItems(result.tests, TEST_CASE_PAYLOAD_BUDGET);
      const diagnostics = boundedDiagnostics(result.diagnostics);
      const stdout = boundedText(result.stdout);
      const stderr = boundedText(result.stderr);
      return {
        ...result,
        durationMs: Date.now() - startedAt,
        tests: tests.items,
        diagnostics: diagnostics.diagnostics,
        ...(stdout.value === undefined ? {} : { stdout: stdout.value }),
        ...(stderr.value === undefined ? {} : { stderr: stderr.value }),
        truncated:
          (result.truncated ?? false) ||
          tests.truncated ||
          diagnostics.truncated ||
          stdout.truncated ||
          stderr.truncated,
      };
    } catch (error) {
      if (deadlineReached()) return gameTestTimeout(startedAt, input.timeoutMs);
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      context.signal.removeEventListener('abort', forwardCancellation);
    }
  }

  async buildDatapack(
    input: DatapackBuildInput,
    context: PackwrightServiceContext,
  ): Promise<BuildResult> {
    const outputPath = input.outputPath ?? `${input.project}.zip`;
    await context.reportProgress({ progress: 0, total: 2, message: 'Validating datapack' });
    const vanillaAdapter = new VanillaCommandValidationAdapter(this.config);
    const result = await buildDatapack(this.workspace, input.project, {
      outputPath,
      overwrite: input.overwrite,
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      adapters: [vanillaAdapter],
      signal: context.signal,
    });
    await context.reportProgress({ progress: 2, total: 2, message: 'Build complete' });
    const diagnostics = boundedDiagnostics(result.diagnostics);
    const vanilla = vanillaAdapter.lastResult;
    return {
      ...result,
      diagnostics: diagnostics.diagnostics,
      ...(vanilla === undefined
        ? {}
        : {
            vanilla: {
              status: vanilla.status,
              filesChecked: vanilla.filesChecked,
              commandLinesChecked: vanilla.commandLinesChecked,
              macroLinesDeferred: vanilla.macroLinesDeferred,
              durationMs: vanilla.durationMs,
            },
          }),
      truncated: diagnostics.truncated,
    };
  }

  async listProjects(context: PackwrightServiceContext): Promise<readonly ProjectSummary[]> {
    const candidates: string[] = [];
    let visited = 0;

    const visit = async (absolute: string, relative: string): Promise<void> => {
      if (context.signal.aborted) return;
      const entries = await readdir(absolute, { withFileTypes: true });
      visited += entries.length;
      if (visited > 20_000) return;
      if (entries.some((entry) => entry.isFile() && entry.name === 'pack.mcmeta')) {
        if (relative !== '') candidates.push(relative);
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const childAbsolute = path.join(absolute, entry.name);
        const info = await lstat(childAbsolute);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        await visit(childAbsolute, childRelative);
        if (visited > 20_000) return;
      }
    };
    await visit(this.workspace.root, '');

    const projects: ProjectSummary[] = [];
    for (const project of candidates.sort((left, right) => left.localeCompare(right, 'en'))) {
      try {
        const inspection = await inspectDatapack(this.workspace, project, {
          signal: context.signal,
        });
        const metadata = asJson(inspection.metadata);
        const metadataObject =
          metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
            ? (metadata as Record<string, JsonValue>)
            : undefined;
        const packObject =
          metadataObject?.pack !== null &&
          typeof metadataObject?.pack === 'object' &&
          !Array.isArray(metadataObject.pack)
            ? (metadataObject.pack as Record<string, JsonValue>)
            : undefined;
        const description =
          packObject?.description === undefined ||
          serializedBytes(packObject.description) > 8 * 1024
            ? undefined
            : packObject.description;
        projects.push({
          project,
          name: path.posix.basename(project),
          ...(description === undefined ? {} : { description }),
          minecraftVersion: '26.2',
          namespaces: inspection.namespaces,
          sha256: combinedHash(inspection.resources),
        });
      } catch {
        // A changing or unreadable candidate is omitted from discovery.
      }
    }
    const bounded = boundedItems(projects, PROJECT_LIST_PAYLOAD_BUDGET);
    this.projectListTruncated =
      visited > 20_000 || candidates.length > projects.length || bounded.truncated;
    return bounded.items;
  }

  getLastDiagnostics(input: DatapackInspectInput): Promise<LastDiagnosticsResult> {
    const stored = this.lastDiagnostics.get(input.project);
    return Promise.resolve(
      stored === undefined
        ? { project: input.project, available: false }
        : {
            project: input.project,
            available: true,
            validation: stored.validation,
            updatedAt: stored.updatedAt,
          },
    );
  }

  async getCachedRegistries(): Promise<CachedRegistriesResult> {
    return await readCachedRegistries(this.config.cacheDir);
  }

  projectsWereTruncated(): boolean {
    return this.projectListTruncated;
  }
}
