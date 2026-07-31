import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Workspace,
  PackwrightError,
  assertScanSnapshotUnchanged,
  buildDatapack,
  createDatapack,
  deleteResource,
  inspectDatapack,
  readResource,
  sha256Buffer,
  scanDatapack,
  upsertResource,
  validateDatapack,
  type Diagnostic,
  type ResourceLocator,
  type ScanResult,
  type ValidationAdapter,
  type ValidationResult,
} from './core/index.js';
import { assertRuntimePathSeparation, type RuntimeConfig } from './config.js';
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
import type { VisualResourceInput, VisualResourceResult } from './mcp/service.js';
import type {
  ProjectBuildInput,
  ProjectBuildResult,
  TextureImportInput,
  VisualAssetInspectInput,
  VisualAssetInspectResult,
  VisualCapabilitiesInput,
  VisualCapabilitiesResult,
  VisualCommitInput,
  VisualCommitResult,
  VisualCompileInput,
  VisualConnectInput,
  VisualDraftResult,
  VisualProjectAttachInput,
  VisualProjectAttachResult,
  VisualRenderInput,
  VisualRenderResult,
  VisualRevisionCreateInput,
  VisualSpecUpsertInput,
  VisualValidateInput,
  VisualValidateResult,
} from './mcp/visual-schemas.js';
import type { BuildResult, GameTestResult, OperationResult } from './core/types.js';
import { MINECRAFT_26_2 } from './core/version.js';
import { readStableFile } from './core/stable-file.js';
import { listVisualCapabilities } from './visual/capabilities.js';
import { createDeterministicZipArchive } from './visual/builder.js';
import { validateResourcePackSnapshot } from './visual/resourcepack-validation.js';
import { commitFileTransaction, VISUAL_TRANSACTION_LIMITS } from './visual/transaction.js';
import { VisualWorkflow, visualDiagnostic } from './visual/workflow.js';
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

async function readPackSnapshot(
  workspace: Workspace,
  packPath: string,
  signal?: AbortSignal,
  preparedScan?: ScanResult,
): Promise<{
  readonly entries: readonly { path: string; data: Buffer }[];
  readonly count: number;
  readonly scan: ScanResult;
}> {
  const scan = preparedScan ?? (await scanDatapack(workspace, packPath, { signal }));
  const entries: { path: string; data: Buffer }[] = [];
  for (const entry of scan.entries) {
    const absolute = await workspace.resolve(`${packPath}/${entry.path}`, {
      mustExist: true,
      rejectSymlinks: true,
    });
    const stable = await readStableFile(absolute, {
      maxBytes: Math.max(1, entry.size),
      expected: entry,
      collect: true,
      signal,
      pathLabel: `${packPath}/${entry.path}`,
    });
    if (stable.data === undefined) {
      throw new PackwrightError(
        'precondition_failed',
        'Pack file changed while preparing a paired build.',
        { path: `${packPath}/${entry.path}` },
      );
    }
    entries.push({ path: entry.path, data: stable.data });
  }
  assertScanSnapshotUnchanged(scan, await scanDatapack(workspace, packPath, { signal }));
  return { entries, count: scan.entries.length, scan };
}

export function assertPairedBuildByteBudget(
  stage: 'source snapshots' | 'ZIP artifacts',
  totalBytes: number,
): void {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    totalBytes > VISUAL_TRANSACTION_LIMITS.maxBytes
  ) {
    throw new PackwrightError(
      'size_limit',
      `Paired build ${stage} exceed the ${String(VISUAL_TRANSACTION_LIMITS.maxBytes)}-byte transaction budget.`,
      {
        stage,
        totalBytes,
        maxBytes: VISUAL_TRANSACTION_LIMITS.maxBytes,
      },
    );
  }
}

async function withStagedDatapack<T>(
  snapshot: Awaited<ReturnType<typeof readPackSnapshot>>,
  overlay: readonly { path: string; data: Buffer }[],
  task: (workspace: Workspace, project: string) => Promise<T>,
): Promise<T> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'packwright-visual-overlay-'));
  const project = 'pack-under-validation';
  const packRoot = path.join(temporaryRoot, project);
  try {
    const files = new Map(snapshot.entries.map((entry) => [entry.path, entry.data]));
    for (const file of overlay) {
      if (
        file.path.length === 0 ||
        file.path.includes('\\') ||
        path.posix.isAbsolute(file.path) ||
        path.posix.normalize(file.path) !== file.path ||
        file.path === '..' ||
        file.path.startsWith('../')
      ) {
        throw new PackwrightError('unsafe_path', 'Proposal overlay contains an unsafe path.', {
          path: file.path,
        });
      }
      files.set(file.path, file.data);
    }
    for (const [relative, data] of files) {
      const destination = path.join(packRoot, ...relative.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { flag: 'wx', mode: 0o600 });
    }
    const workspace = await Workspace.open(temporaryRoot, { readOnly: true });
    return await task(workspace, project);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function applySnapshotOverlay(
  snapshot: Awaited<ReturnType<typeof readPackSnapshot>>,
  overlay: readonly { path: string; data: Buffer }[],
): readonly { path: string; data: Buffer }[] {
  const files = new Map(snapshot.entries.map((entry) => [entry.path, entry.data]));
  for (const file of overlay) files.set(file.path, file.data);
  return [...files].map(([entryPath, data]) => ({ path: entryPath, data }));
}

export class PackwrightApplication implements PackwrightService {
  readonly config: RuntimeConfig;
  readonly workspace: Workspace;
  readonly visual: VisualWorkflow;
  private readonly lastDiagnostics = new Map<string, StoredDiagnostics>();
  private projectListTruncated = false;

  private constructor(config: RuntimeConfig, workspace: Workspace) {
    this.config = config;
    this.workspace = workspace;
    this.visual = new VisualWorkflow(workspace, config.cacheDir);
  }

  static async open(config: RuntimeConfig): Promise<PackwrightApplication> {
    await assertRuntimePathSeparation(config);
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
    return this.validateDatapackAt(this.workspace, input, context, true);
  }

  private async validateDatapackAt(
    workspace: Workspace,
    input: DatapackValidateInput,
    context: PackwrightServiceContext,
    recordDiagnostics: boolean,
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
    const result = await validateDatapack(workspace, input.project, {
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
    if (recordDiagnostics) {
      this.lastDiagnostics.set(input.project, {
        validation: normalized,
        updatedAt: new Date().toISOString(),
      });
    }
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

  getVisualCapabilities(input: VisualCapabilitiesInput): Promise<VisualCapabilitiesResult> {
    const capabilities = listVisualCapabilities(MINECRAFT_26_2.visualCapabilities).filter(
      (entry) => input.target === undefined || entry.target === input.target,
    );
    return Promise.resolve({
      ok: true,
      minecraftVersion: '26.2',
      resourcePackFormat: [...MINECRAFT_26_2.resourcePack.packFormat],
      capabilities: capabilities.map((entry) => ({
        ...entry,
        strategies: [...entry.strategies],
      })),
      reviewProfiles: [{ id: 'held_item', version: 1, targetKind: 'item', support: 'full' }],
    });
  }

  async attachVisualProject(
    input: VisualProjectAttachInput,
    context: PackwrightServiceContext,
  ): Promise<VisualProjectAttachResult> {
    await context.reportProgress({ progress: 0, total: 1, message: 'Attaching paired packs' });
    const result = await this.visual.attachProject(input);
    await context.reportProgress({ progress: 1, total: 1, message: 'Paired project ready' });
    return result;
  }

  async inspectVisualAsset(input: VisualAssetInspectInput): Promise<VisualAssetInspectResult> {
    return await this.visual.inspect(input.projectId, input.assetId);
  }

  async upsertVisualSpec(
    input: VisualSpecUpsertInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult> {
    return await this.visual.upsertSpec(input, context.signal);
  }

  async importTexture(
    input: TextureImportInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult> {
    return await this.visual.importTexture(input, context.signal);
  }

  async compileVisual(
    input: VisualCompileInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult> {
    await context.reportProgress({ progress: 0, total: 1, message: 'Compiling visual draft' });
    const result = await this.visual.compile(
      input.projectId,
      input.runId,
      input.revisionId,
      context.signal,
    );
    await context.reportProgress({ progress: 1, total: 1, message: 'Visual draft compiled' });
    return result;
  }

  async connectVisual(
    input: VisualConnectInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult> {
    return await this.visual.connect(input, context.signal);
  }

  async renderVisual(
    input: VisualRenderInput,
    context: PackwrightServiceContext,
  ): Promise<VisualRenderResult> {
    await context.reportProgress({ progress: 0, total: 2, message: 'Rendering standard views' });
    const result = await this.visual.render(input, context.signal);
    await context.reportProgress({ progress: 2, total: 2, message: 'Contact sheet ready' });
    return result;
  }

  async createVisualRevision(
    input: VisualRevisionCreateInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult> {
    return await this.visual.revise(input, context.signal);
  }

  async commitVisual(
    input: VisualCommitInput,
    context: PackwrightServiceContext,
  ): Promise<VisualCommitResult> {
    return await this.visual.commit(
      input.projectId,
      input.runId,
      input.revisionId,
      input.proposalSha256,
      context.signal,
    );
  }

  async validateVisual(
    input: VisualValidateInput,
    context: PackwrightServiceContext,
  ): Promise<VisualValidateResult> {
    await context.reportProgress({ progress: 0, total: 3, message: 'Validating visual graph' });
    const draft = await this.visual.validateDraft(input.projectId, input.runId, input.revisionId);
    const diagnostics: Diagnostic[] = draft.result?.diagnostics.map(visualDiagnostic) ?? [];
    if (draft.result === undefined) {
      diagnostics.push({
        engine: 'packwright.visual',
        authority: 'structural',
        severity: 'error',
        code: 'visual.draft.required',
        message: 'Create a visual draft before running paired-project validation.',
      });
    }
    const readiness = draft.readiness;
    const selectedRunId = draft.runId;
    const selectedRevisionId = draft.revisionId;
    if (draft.project.resourcepack.present) {
      const snapshot = await readPackSnapshot(
        this.workspace,
        draft.project.manifest.resourcepack,
        context.signal,
      );
      const overlay =
        selectedRunId !== undefined &&
        selectedRevisionId !== undefined &&
        readiness?.binding === true
          ? (
              await this.visual.readProposalOverlay(
                input.projectId,
                selectedRunId,
                selectedRevisionId,
              )
            ).files
              .filter((file) => file.pack === 'resourcepack')
              .map((file) => ({ path: file.path, data: file.data }))
          : [];
      diagnostics.push(
        ...validateResourcePackSnapshot(applySnapshotOverlay(snapshot, overlay)).diagnostics.map(
          visualDiagnostic,
        ),
      );
    }
    const visualFailed =
      draft.result === undefined ||
      diagnostics.some((entry) => entry.authority === 'structural' && entry.severity === 'error');
    const layers: VisualValidateResult['layers'] = [
      { name: 'metadata', status: draft.project.ready ? 'passed' : 'failed' },
      { name: 'schema', status: visualFailed ? 'failed' : 'passed' },
      {
        name: 'texture',
        status: readiness?.textures === true ? 'passed' : 'failed',
      },
      { name: 'asset_graph', status: visualFailed ? 'failed' : 'passed' },
      { name: 'geometry', status: visualFailed ? 'failed' : 'passed' },
      { name: 'render', status: readiness?.rendered === true ? 'passed' : 'failed' },
      {
        name: 'review_profile',
        status: readiness?.reviewProfile === true ? 'passed' : 'failed',
      },
      { name: 'binding', status: readiness?.binding === true ? 'passed' : 'failed' },
    ];

    await context.reportProgress({
      progress: 1,
      total: 3,
      message: 'Validating datapack commands',
    });
    const validationInput: DatapackValidateInput = {
      project: draft.project.manifest.datapack,
      includeSpyglass: true,
      includeVanilla: input.includeVanilla,
    };
    const datapack =
      selectedRunId !== undefined && selectedRevisionId !== undefined && readiness?.binding === true
        ? await (async (): Promise<ValidationResult> => {
            const [snapshot, proposal] = await Promise.all([
              readPackSnapshot(this.workspace, draft.project.manifest.datapack, context.signal),
              this.visual.readProposalOverlay(input.projectId, selectedRunId, selectedRevisionId),
            ]);
            return withStagedDatapack(
              snapshot,
              proposal.files
                .filter((file) => file.pack === 'datapack')
                .map((file) => ({ path: file.path, data: file.data })),
              (workspace, project) =>
                this.validateDatapackAt(workspace, { ...validationInput, project }, context, false),
            );
          })()
        : await this.validateDatapack(validationInput, context);
    diagnostics.push(...datapack.diagnostics);
    layers.push({
      name: 'vanilla_commands',
      status: !input.includeVanilla
        ? 'skipped'
        : datapack.vanilla?.status === 'setup_required'
          ? 'setup_required'
          : datapack.ok
            ? 'passed'
            : 'failed',
    });

    if (input.includeGameTests) {
      const tested =
        selectedRunId !== undefined &&
        selectedRevisionId !== undefined &&
        readiness?.binding === true
          ? await (async (): Promise<GameTestResult> => {
              const [snapshot, proposal] = await Promise.all([
                readPackSnapshot(this.workspace, draft.project.manifest.datapack, context.signal),
                this.visual.readProposalOverlay(input.projectId, selectedRunId, selectedRevisionId),
              ]);
              return withStagedDatapack(
                snapshot,
                proposal.files
                  .filter((file) => file.pack === 'datapack')
                  .map((file) => ({ path: file.path, data: file.data })),
                (workspace, project) =>
                  runGameTests(
                    this.config,
                    workspace,
                    { project, timeoutMs: 300_000 },
                    context.signal,
                  ),
              );
            })()
          : await this.testDatapack(
              { project: draft.project.manifest.datapack, timeoutMs: 300_000 },
              context,
            );
      diagnostics.push(...tested.diagnostics);
      layers.push({
        name: 'gametest',
        status:
          tested.status === 'setup_required' ? 'setup_required' : tested.ok ? 'passed' : 'failed',
      });
    } else {
      layers.push({ name: 'gametest', status: 'skipped' });
    }
    await context.reportProgress({ progress: 3, total: 3, message: 'Visual validation complete' });
    const bounded = boundedDiagnostics(diagnostics);
    return {
      ok:
        draft.project.ready &&
        !bounded.diagnostics.some((entry) => entry.severity === 'error') &&
        !layers.some((entry) => entry.status === 'failed' || entry.status === 'setup_required'),
      projectId: input.projectId,
      ...(draft.runId === undefined ? {} : { runId: draft.runId }),
      ...(draft.revisionId === undefined ? {} : { revisionId: draft.revisionId }),
      layers,
      diagnostics: bounded.diagnostics,
      truncated: bounded.truncated,
    };
  }

  async buildProject(
    input: ProjectBuildInput,
    context: PackwrightServiceContext,
  ): Promise<ProjectBuildResult> {
    return this.visual.runProjectOperation(input.projectId, () =>
      this.buildProjectUnlocked(input, context),
    );
  }

  private async buildProjectUnlocked(
    input: ProjectBuildInput,
    context: PackwrightServiceContext,
  ): Promise<ProjectBuildResult> {
    let expectedDatapackSha256: string | null;
    let expectedResourcepackSha256: string | null;
    if (input.overwrite) {
      if (
        input.expectedDatapackSha256 === undefined ||
        input.expectedResourcepackSha256 === undefined
      ) {
        throw new PackwrightError(
          'precondition_required',
          'Both paired ZIP preconditions are required when overwrite is true.',
        );
      }
      expectedDatapackSha256 = input.expectedDatapackSha256;
      expectedResourcepackSha256 = input.expectedResourcepackSha256;
    } else {
      if (
        input.expectedDatapackSha256 !== undefined ||
        input.expectedResourcepackSha256 !== undefined
      ) {
        throw new PackwrightError(
          'invalid_argument',
          'Paired ZIP preconditions may only be supplied when overwrite is true.',
        );
      }
      expectedDatapackSha256 = null;
      expectedResourcepackSha256 = null;
    }
    const inspection = await this.visual.validateDraft(input.projectId);
    const readiness = inspection.readiness;
    if (
      !inspection.project.ready ||
      inspection.result?.ok !== true ||
      !readiness?.textures ||
      !readiness.compiled ||
      !readiness.rendered ||
      !readiness.reviewProfile ||
      !readiness.binding ||
      !readiness.committed
    ) {
      throw new PackwrightError(
        'validation_failed',
        'The latest visual revision must be compiled, rendered, connected, validated, and committed before building.',
        {
          readiness,
          diagnostics: inspection.result?.diagnostics,
        },
      );
    }
    const selectedRunId = inspection.runId;
    const selectedRevisionId = inspection.revisionId;
    if (selectedRunId === undefined || selectedRevisionId === undefined) {
      throw new PackwrightError('precondition_required', 'No latest visual revision is selected.');
    }
    const outputDirectory = input.outputDirectory ?? 'build';
    const normalizedOutput = this.workspace.normalize(outputDirectory);
    for (const pack of [
      inspection.project.manifest.datapack,
      inspection.project.manifest.resourcepack,
    ]) {
      if (normalizedOutput === pack || normalizedOutput.startsWith(`${pack}/`)) {
        throw new PackwrightError(
          'invalid_argument',
          'Paired build output cannot be inside either source pack.',
          { outputDirectory: normalizedOutput, pack },
        );
      }
    }
    const datapackOutput = `${normalizedOutput}/${input.projectId}-data-26.2.zip`;
    const resourcepackOutput = `${normalizedOutput}/${input.projectId}-assets-26.2.zip`;
    const [datapackScan, resourcepackScan] = await Promise.all([
      scanDatapack(this.workspace, inspection.project.manifest.datapack, {
        signal: context.signal,
      }),
      scanDatapack(this.workspace, inspection.project.manifest.resourcepack, {
        signal: context.signal,
      }),
    ]);
    assertPairedBuildByteBudget(
      'source snapshots',
      datapackScan.totalBytes + resourcepackScan.totalBytes,
    );
    const [datapackSnapshot, resourcepackSnapshot] = await Promise.all([
      readPackSnapshot(
        this.workspace,
        inspection.project.manifest.datapack,
        context.signal,
        datapackScan,
      ),
      readPackSnapshot(
        this.workspace,
        inspection.project.manifest.resourcepack,
        context.signal,
        resourcepackScan,
      ),
    ]);
    const datapackValidation = await withStagedDatapack(
      datapackSnapshot,
      [],
      (workspace, project) =>
        this.validateDatapackAt(
          workspace,
          {
            project,
            includeSpyglass: false,
            includeVanilla: true,
          },
          context,
          false,
        ),
    );
    const resourcepackValidation = validateResourcePackSnapshot(resourcepackSnapshot.entries);
    const allDiagnostics: Diagnostic[] = [
      ...inspection.result.diagnostics.map(visualDiagnostic),
      ...datapackValidation.diagnostics,
      ...resourcepackValidation.diagnostics.map(visualDiagnostic),
    ];
    const bounded = boundedDiagnostics(allDiagnostics);
    if (
      !datapackValidation.ok ||
      !resourcepackValidation.ok ||
      bounded.diagnostics.some((entry) => entry.severity === 'error')
    ) {
      throw new PackwrightError(
        'validation_failed',
        'The exact paired-pack snapshots failed validation before build.',
        { diagnostics: bounded.diagnostics, truncated: bounded.truncated },
      );
    }
    const [datapackArchive, resourcepackArchive] = await Promise.all([
      createDeterministicZipArchive(datapackSnapshot.entries),
      createDeterministicZipArchive(resourcepackSnapshot.entries),
    ]);
    assertPairedBuildByteBudget('ZIP artifacts', datapackArchive.size + resourcepackArchive.size);
    const [currentDatapackScan, currentResourcepackScan] = await Promise.all([
      scanDatapack(this.workspace, inspection.project.manifest.datapack, {
        signal: context.signal,
      }),
      scanDatapack(this.workspace, inspection.project.manifest.resourcepack, {
        signal: context.signal,
      }),
      this.visual.assertCurrentSelection(
        input.projectId,
        selectedRunId,
        selectedRevisionId,
        inspection.project.manifestSha256,
      ),
    ]);
    assertScanSnapshotUnchanged(datapackSnapshot.scan, currentDatapackScan);
    assertScanSnapshotUnchanged(resourcepackSnapshot.scan, currentResourcepackScan);
    const transaction = await commitFileTransaction(
      this.workspace,
      [
        {
          path: datapackOutput,
          content: datapackArchive.data,
          expectedSha256: expectedDatapackSha256,
        },
        {
          path: resourcepackOutput,
          content: resourcepackArchive.data,
          expectedSha256: expectedResourcepackSha256,
        },
      ],
      context.signal,
    );
    const datapackInstalled = transaction.files.find((file) => file.path === datapackOutput);
    const resourcepackInstalled = transaction.files.find(
      (file) => file.path === resourcepackOutput,
    );
    if (datapackInstalled === undefined || resourcepackInstalled === undefined) {
      throw new Error('Paired build transaction did not install both archives.');
    }
    return {
      ok: true,
      projectId: input.projectId,
      datapack: {
        path: datapackOutput,
        size: datapackArchive.size,
        sha256: datapackInstalled.sha256,
        entries: datapackSnapshot.count,
      },
      resourcepack: {
        path: resourcepackOutput,
        size: resourcepackArchive.size,
        sha256: resourcepackInstalled.sha256,
        entries: resourcepackSnapshot.count,
      },
      diagnostics: bounded.diagnostics,
      truncated: bounded.truncated || (datapackValidation.truncated ?? false),
    };
  }

  async readVisualResource(input: VisualResourceInput): Promise<VisualResourceResult> {
    const result = await this.visual.readResource(input);
    return {
      mimeType: result.mimeType,
      encoding: result.mimeType === 'image/png' ? 'base64' : 'utf8',
      data:
        result.mimeType === 'image/png'
          ? result.data.toString('base64')
          : result.data.toString('utf8'),
      sha256: sha256Buffer(result.data),
    };
  }

  projectsWereTruncated(): boolean {
    return this.projectListTruncated;
  }
}
