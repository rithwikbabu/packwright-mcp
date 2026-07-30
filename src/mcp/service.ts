import type {
  BuildResult,
  GameTestResult,
  OperationResult,
  ValidationResult,
} from '../core/types.js';
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
} from './schemas.js';

export interface PackwrightProgress {
  /** Completed work units. Values must increase across notifications. */
  progress: number;
  /** Total work units, when known. */
  total?: number;
  message?: string;
}

/**
 * Transport-neutral request context passed into the Packwright application
 * layer. Implementations must stop long-running subprocesses and temporary
 * work when `signal` is aborted.
 */
export interface PackwrightServiceContext {
  readonly signal: AbortSignal;
  reportProgress(update: PackwrightProgress): Promise<void>;
}

/**
 * Application boundary consumed by the MCP adapter. Implementations should
 * throw `PackwrightError` for business failures; the adapter translates those
 * into MCP tool execution errors while SDK schema failures remain protocol
 * errors.
 */
export interface PackwrightService {
  createDatapack(
    input: DatapackCreateInput,
    context: PackwrightServiceContext,
  ): Promise<OperationResult<JsonValue>>;

  inspectDatapack(
    input: DatapackInspectInput,
    context: PackwrightServiceContext,
  ): Promise<DatapackInspectResult>;

  readResource(
    input: ResourceReadInput,
    context: PackwrightServiceContext,
  ): Promise<ResourceReadResult>;

  upsertResource(
    input: ResourceUpsertInput,
    context: PackwrightServiceContext,
  ): Promise<OperationResult<JsonValue>>;

  deleteResource(
    input: ResourceDeleteInput,
    context: PackwrightServiceContext,
  ): Promise<OperationResult<JsonValue>>;

  validateDatapack(
    input: DatapackValidateInput,
    context: PackwrightServiceContext,
  ): Promise<ValidationResult>;

  lookupMinecraft(
    input: MinecraftLookupInput,
    context: PackwrightServiceContext,
  ): Promise<MinecraftLookupResult>;

  testDatapack(
    input: DatapackTestInput,
    context: PackwrightServiceContext,
  ): Promise<GameTestResult>;

  buildDatapack(input: DatapackBuildInput, context: PackwrightServiceContext): Promise<BuildResult>;

  listProjects(context: PackwrightServiceContext): Promise<readonly ProjectSummary[]>;

  getLastDiagnostics(
    input: DatapackInspectInput,
    context: PackwrightServiceContext,
  ): Promise<LastDiagnosticsResult>;

  getCachedRegistries(
    input: { minecraftVersion: '26.2' },
    context: PackwrightServiceContext,
  ): Promise<CachedRegistriesResult>;

  /** Whether the most recent project listing was shortened for payload safety. */
  projectsWereTruncated?(): boolean;
}
