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
  VisualClientCaptureInput,
  VisualClientCaptureResult,
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
} from './visual-schemas.js';

export type VisualResourceInput =
  | { readonly kind: 'project_manifest' | 'project_graph'; readonly projectId: string }
  | {
      readonly kind:
        | 'spec'
        | 'contact_sheet'
        | 'render_report'
        | 'review'
        | 'binding'
        | 'client_capture_report'
        | 'client_contact_sheet'
        | 'client_scale_reference_sheet';
      readonly runId: string;
      readonly revisionId: string;
    }
  | {
      readonly kind: 'view' | 'client_view';
      readonly runId: string;
      readonly revisionId: string;
      readonly view: string;
    };

export interface VisualResourceResult {
  readonly mimeType: 'application/json' | 'image/png';
  readonly encoding: 'utf8' | 'base64';
  readonly data: string;
  readonly sha256: string;
}

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

  getVisualCapabilities(
    input: VisualCapabilitiesInput,
    context: PackwrightServiceContext,
  ): Promise<VisualCapabilitiesResult>;

  attachVisualProject(
    input: VisualProjectAttachInput,
    context: PackwrightServiceContext,
  ): Promise<VisualProjectAttachResult>;

  inspectVisualAsset(
    input: VisualAssetInspectInput,
    context: PackwrightServiceContext,
  ): Promise<VisualAssetInspectResult>;

  upsertVisualSpec(
    input: VisualSpecUpsertInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult>;

  importTexture(
    input: TextureImportInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult>;

  compileVisual(
    input: VisualCompileInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult>;

  connectVisual(
    input: VisualConnectInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult>;

  renderVisual(
    input: VisualRenderInput,
    context: PackwrightServiceContext,
  ): Promise<VisualRenderResult>;

  captureVisual(
    input: VisualClientCaptureInput,
    context: PackwrightServiceContext,
  ): Promise<VisualClientCaptureResult>;

  createVisualRevision(
    input: VisualRevisionCreateInput,
    context: PackwrightServiceContext,
  ): Promise<VisualDraftResult>;

  commitVisual(
    input: VisualCommitInput,
    context: PackwrightServiceContext,
  ): Promise<VisualCommitResult>;

  validateVisual(
    input: VisualValidateInput,
    context: PackwrightServiceContext,
  ): Promise<VisualValidateResult>;

  buildProject(
    input: ProjectBuildInput,
    context: PackwrightServiceContext,
  ): Promise<ProjectBuildResult>;

  readVisualResource(
    input: VisualResourceInput,
    context: PackwrightServiceContext,
  ): Promise<VisualResourceResult>;

  /** Whether the most recent project listing was shortened for payload safety. */
  projectsWereTruncated?(): boolean;
}
