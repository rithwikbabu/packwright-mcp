import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { PackwrightError } from '../core/errors.js';
import { sha256Buffer } from '../core/hash.js';
import { parseResourceId } from '../core/identifiers.js';
import { withPathLock } from '../core/locks.js';
import { inspectDatapack } from '../core/project.js';
import { readStableFile, snapshotStableFile } from '../core/stable-file.js';
import type { Diagnostic } from '../core/types.js';
import { createResourcePackMetadata, MINECRAFT_26_2 } from '../core/version.js';
import type { Workspace } from '../core/workspace.js';
import type { RuntimeConfig } from '../config.js';
import {
  executeMinecraftClientCapture,
  preflightMinecraftClientCapture,
} from '../minecraft/client-capture.js';
import type {
  ClientCaptureCompleteReport,
  ClientCapturePlan,
} from '../minecraft/client-capture-protocol.js';
import {
  parseClientCaptureCompletionSentinelBytes,
  parseClientCapturePlan,
  parseClientCaptureReport,
  parseClientCaptureReportBytes,
} from '../minecraft/client-capture-protocol.js';
import type {
  TextureImportInput,
  VisualAssetInspectResult,
  VisualCommitResult,
  VisualClientCaptureInput,
  VisualClientCaptureResult,
  VisualConnectInput,
  VisualDraftResult,
  VisualFileSchema,
  VisualProjectAttachInput,
  VisualProjectAttachResult,
  VisualRenderInput,
  VisualRenderResult,
  VisualRevisionCreateInput,
  VisualSpecUpsertInput,
} from '../mcp/visual-schemas.js';
import { VisualConnectInputSchema } from '../mcp/visual-schemas.js';
import {
  visualRunClientCaptureContactSheetUri,
  visualRunClientCaptureReportUri,
  visualRunClientCaptureViewUri,
  visualRunContactSheetUri,
  visualRunRenderReportUri,
  visualRunViewUri,
} from '../mcp/visual-uris.js';
import type { z } from 'zod/v4';
import { createItemAssetGraph, type VisualAssetGraph } from './asset-graph.js';
import {
  compareVisualStrings,
  compileItemAsset,
  createItemBindingProposal,
  serializeVisualJson,
  type CompiledItemAsset,
  type ItemBindingProposal,
} from './compiler.js';
import { decodePng, encodePng, normalizePng, type PixelImage } from './png.js';
import {
  attachVisualProject as attachVisualProjectManifest,
  inspectVisualProject,
  isVisualProjectId,
  parseVisualProjectManifest,
  visualProjectManifestPath,
  type VisualProjectInspection,
  type VisualProjectManifest,
} from './project.js';
import {
  createBoundedClientPreview,
  createContactSheet,
  renderCompiledItemAsset,
  solidTexture,
  type RenderedView,
  type Rgba,
} from './renderer.js';
import {
  MAX_REVIEW_MEASUREMENTS,
  MAX_REVIEW_SCENES,
  REVIEW_MEASUREMENT_IDS,
  REVIEW_MEASUREMENT_UNITS,
  REVIEW_PROFILE_RENDERER_VERSION,
  isReviewProfileId,
  resolveReviewProfile,
  type ReviewMeasurementResult,
  type ReviewProfileId,
} from './review-profile.js';
import { canonicalJsonBytes, VisualRunStore } from './run-store.js';
import { commitFileTransaction } from './transaction.js';
import {
  validateVisualAsset,
  type VisualDiagnostic,
  type VisualValidationResult,
} from './visual-validation.js';
import {
  VisualWorkflowStateStore,
  type VisualPngReference,
  type VisualProjectWorkflowState,
  type VisualRevisionState,
} from './workflow-state.js';
import { parseModelSpec, type ModelSpec } from './model-spec.js';
import { clientCaptureReviewSupport } from './client-capture-support.js';
import {
  clientCaptureComponentLiterals,
  createVisualClientCapturePlan,
} from './client-capture-plan.js';
import { applyPackSnapshotOverlay, readConfinedPackSnapshot } from './pack-snapshot.js';
import { createDeterministicZipArchive } from './builder.js';

type VisualFile = z.infer<typeof VisualFileSchema>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface ProposalFile {
  readonly pack: 'datapack' | 'resourcepack';
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly role: VisualFile['role'];
}

interface CommitProposal {
  readonly schemaVersion: 1;
  readonly compiler: 'packwright-visual-v1';
  readonly minecraftVersion: '26.2';
  readonly dataPackFormat: readonly [107, 1];
  readonly resourcePackFormat: readonly [88, 0];
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly manifestSha256: string;
  readonly datapack: string;
  readonly resourcepack: string;
  readonly compiledArtifactId: string;
  readonly binding: ItemBindingProposal;
  readonly connection: Readonly<{
    generateGiveFunction: boolean;
    generateRecipe: boolean;
    recipe?: VisualConnectInput['recipe'] | undefined;
  }>;
  readonly files: readonly ProposalFile[];
}

interface VisualCommitReceipt {
  readonly schemaVersion: 1;
  readonly kind: 'packwright.visual-commit';
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly proposalSha256: string;
  readonly manifestSha256: string;
  readonly transactionId: string;
  readonly clientCapture?: Readonly<{
    readonly authority: 'authoritative_environment_capture';
    readonly evidenceSha256: string;
    readonly sourceReportSha256: string;
    readonly planSha256: string;
    readonly clientJarSha256: string;
    readonly captureModSha256: string;
    readonly datapackContentSha256: string;
    readonly resourcepackContentSha256: string;
    readonly runtimeManifestSha256: string;
  }>;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
  }[];
}

interface ProposedContent {
  readonly pack: ProposalFile['pack'];
  readonly path: string;
  readonly content: Buffer | string;
  readonly role: VisualFile['role'];
  readonly mediaType: string;
}

interface LoadedRevision {
  readonly project: VisualProjectInspection;
  readonly state: VisualProjectWorkflowState;
  readonly record: VisualRevisionState;
  readonly spec: ModelSpec;
}

interface VisualArtifactReadiness {
  readonly spec: boolean;
  readonly textures: boolean;
  readonly compiled: boolean;
  readonly rendered: boolean;
  readonly reviewProfile: boolean;
  readonly binding: boolean;
  readonly committed: boolean;
  readonly clientCaptured: boolean;
}

interface VerifiedVisualArtifacts {
  readonly readiness: VisualArtifactReadiness;
  readonly diagnostics: readonly VisualDiagnostic[];
  readonly availableTextureResourceIds: ReadonlySet<string>;
  readonly availableModelResourceIds: ReadonlySet<string>;
  readonly binding?: ItemBindingProposal | undefined;
  readonly proposal?: CommitProposal | undefined;
}

interface StoredRenderProfileReport {
  readonly schemaVersion: 1;
  readonly kind: 'packwright.render-profile-report';
  readonly projectId: string;
  readonly runId: string;
  readonly revisionId: string;
  readonly specSha256: string;
  readonly compiledArtifactId: string;
  readonly rendererVersion: typeof REVIEW_PROFILE_RENDERER_VERSION;
  readonly profileId: ReviewProfileId;
  readonly profileVersion: number;
  readonly viewSize: number;
  readonly planSha256: string;
  readonly requiredViewIds: readonly string[];
  readonly reviewReady: boolean;
  readonly views: readonly {
    readonly id: string;
    readonly required: boolean;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
  }[];
  readonly measurements: readonly ReviewMeasurementResult[];
}

interface StoredClientCaptureEvidence {
  readonly schemaVersion: 1;
  readonly kind: 'packwright.minecraft-client-capture-evidence';
  readonly authority: 'authoritative_environment_capture';
  readonly plan: ClientCapturePlan;
  readonly report: ClientCaptureCompleteReport;
  readonly sourceReportSha256: string;
  readonly completionSha256: string;
  readonly sourceReport: Readonly<{
    readonly label: string;
    readonly sha256: string;
    readonly bytes: number;
  }>;
  readonly completion: Readonly<{
    readonly label: string;
    readonly sha256: string;
    readonly bytes: number;
  }>;
  readonly log: Readonly<{ label: string; sha256: string; bytes: number }>;
  readonly views: readonly {
    readonly id: string;
    readonly label: string;
    readonly sourceSha256: string;
    readonly normalizedSha256: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  }[];
  readonly contactSheet: Readonly<{
    readonly label: string;
    readonly sha256: string;
    readonly width: number;
    readonly height: number;
    readonly bytes: number;
  }>;
}

const CAPTURE_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

function captureBlobReference(
  value: unknown,
  label: string,
): Readonly<{ label: string; sha256: string; bytes: number }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Stored client-capture ${label} reference is invalid.`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.label !== 'string' ||
    !CAPTURE_LABEL_PATTERN.test(record.label) ||
    typeof record.sha256 !== 'string' ||
    !SHA256_PATTERN.test(record.sha256) ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) <= 0
  ) {
    throw new Error(`Stored client-capture ${label} reference is invalid.`);
  }
  return {
    label: record.label,
    sha256: record.sha256,
    bytes: record.bytes as number,
  };
}

function parseStoredClientCaptureEvidence(value: unknown): StoredClientCaptureEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored client-capture evidence is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'packwright.minecraft-client-capture-evidence' ||
    record.authority !== 'authoritative_environment_capture' ||
    typeof record.sourceReportSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.sourceReportSha256) ||
    typeof record.completionSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.completionSha256) ||
    !Array.isArray(record.views)
  ) {
    throw new Error('Stored client-capture evidence identity is invalid.');
  }
  const plan = parseClientCapturePlan(record.plan);
  const parsedReport = parseClientCaptureReport(record.report, plan);
  if (parsedReport.status !== 'complete') {
    throw new Error('Stored client-capture evidence contains a failed report.');
  }
  const views = record.views.map((entryValue) => {
    if (entryValue === null || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
      throw new Error('Stored client-capture view reference is invalid.');
    }
    const entry = entryValue as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      !CAPTURE_LABEL_PATTERN.test(entry.id) ||
      typeof entry.label !== 'string' ||
      !CAPTURE_LABEL_PATTERN.test(entry.label) ||
      typeof entry.sourceSha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sourceSha256) ||
      typeof entry.normalizedSha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.normalizedSha256) ||
      !Number.isSafeInteger(entry.width) ||
      (entry.width as number) <= 0 ||
      !Number.isSafeInteger(entry.height) ||
      (entry.height as number) <= 0 ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) <= 0
    ) {
      throw new Error('Stored client-capture view reference is invalid.');
    }
    return {
      id: entry.id,
      label: entry.label,
      sourceSha256: entry.sourceSha256,
      normalizedSha256: entry.normalizedSha256,
      width: entry.width as number,
      height: entry.height as number,
      bytes: entry.bytes as number,
    };
  });
  if (new Set(views.map((view) => view.id)).size !== views.length) {
    throw new Error('Stored client-capture evidence contains duplicate views.');
  }
  const contactSheet = captureBlobReference(record.contactSheet, 'contact sheet');
  const contactValue = record.contactSheet as Record<string, unknown>;
  if (
    !Number.isSafeInteger(contactValue.width) ||
    (contactValue.width as number) <= 0 ||
    !Number.isSafeInteger(contactValue.height) ||
    (contactValue.height as number) <= 0
  ) {
    throw new Error('Stored client-capture contact-sheet dimensions are invalid.');
  }
  return {
    schemaVersion: 1,
    kind: 'packwright.minecraft-client-capture-evidence',
    authority: 'authoritative_environment_capture',
    plan,
    report: parsedReport,
    sourceReportSha256: record.sourceReportSha256,
    completionSha256: record.completionSha256,
    sourceReport: captureBlobReference(record.sourceReport, 'source report'),
    completion: captureBlobReference(record.completion, 'completion sentinel'),
    log: captureBlobReference(record.log, 'log'),
    views,
    contactSheet: {
      ...contactSheet,
      width: contactValue.width as number,
      height: contactValue.height as number,
    },
  };
}

export interface VisualProposalOverlay {
  readonly project: VisualProjectInspection;
  readonly runId: string;
  readonly revisionId: string;
  readonly proposalSha256: string;
  readonly files: readonly {
    readonly pack: 'datapack' | 'resourcepack';
    readonly path: string;
    readonly data: Buffer;
    readonly sha256: string;
  }[];
}

function asVisualFile(
  path: string,
  content: Uint8Array | string,
  mediaType: string,
  role: VisualFile['role'],
): VisualFile {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return { path, sha256: sha256Buffer(bytes), size: bytes.length, mediaType, role };
}

export function visualDiagnostic(entry: VisualDiagnostic): Diagnostic {
  const semantic = [
    entry.target,
    entry.partId === undefined ? undefined : `part ${entry.partId}`,
    entry.materialId === undefined ? undefined : `material ${entry.materialId}`,
    entry.displayContext === undefined ? undefined : `display.${entry.displayContext}`,
    entry.reviewProfile === undefined ? undefined : `profile ${entry.reviewProfile}`,
    entry.reviewView === undefined ? undefined : `view ${entry.reviewView}`,
    entry.reviewMetric === undefined ? undefined : `metric ${entry.reviewMetric}`,
  ].filter((value): value is string => value !== undefined);
  return {
    engine: entry.engine,
    authority: entry.authority,
    severity: entry.severity,
    code: entry.code,
    message: semantic.length === 0 ? entry.message : `${semantic.join(' / ')}\n${entry.message}`,
    ...(entry.path === undefined ? {} : { path: entry.path }),
    ...(entry.suggestedFix === undefined ? {} : { suggestedFix: entry.suggestedFix }),
  };
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PackwrightError('cancelled', 'Visual operation was cancelled.');
}

function artifactDiagnostic(code: string, message: string, target?: string): VisualDiagnostic {
  return {
    engine: 'packwright.visual',
    authority: 'structural',
    severity: 'error',
    code,
    message,
    ...(target === undefined ? {} : { target }),
  };
}

function reviewMeasurementDiagnostic(
  target: string,
  profileId: ReviewProfileId,
  measurement: ReviewMeasurementResult,
): VisualDiagnostic | undefined {
  if (measurement.status === 'passed') return undefined;
  const suggestedFix =
    measurement.metric === 'primary_grip_distance' ||
    measurement.metric === 'secondary_grip_distance'
      ? `Adjust heldItem.${measurement.metric === 'primary_grip_distance' ? 'primaryGrip' : 'secondaryGrip'} or the matching held display transform, then rerender.`
      : measurement.metric === 'arm_intersection' || measurement.metric === 'torso_intersection'
        ? 'Adjust the held display transform or the intersecting semantic part, then rerender.'
        : measurement.metric === 'screen_obscuration'
          ? 'Reduce first-person scale or translation so the item obstructs less of the frame.'
          : measurement.metric === 'forward_axis'
            ? 'Correct heldItem.forwardAxis or the held display rotation so it points away from the player.'
            : measurement.metric === 'hand_symmetry'
              ? 'Repair the left/right display transforms or explicitly declare one-handed intent.'
              : 'Adjust the named part or display transform so important geometry remains in frame.';
  return {
    engine: 'packwright.visual',
    authority: 'advisory',
    severity:
      measurement.status === 'failed'
        ? 'error'
        : measurement.status === 'warning' ||
            measurement.metric === 'primary_grip_distance' ||
            measurement.metric === 'secondary_grip_distance'
          ? 'warning'
          : 'information',
    code: `visual.review.${measurement.metric}.${measurement.status}`,
    message: measurement.message,
    target,
    reviewProfile: profileId,
    ...(measurement.view === undefined ? {} : { reviewView: measurement.view }),
    reviewMetric: measurement.metric,
    ...(measurement.partId === undefined ? {} : { partId: measurement.partId }),
    suggestedFix,
  };
}

function reviewMeasurementDiagnostics(
  target: string,
  profileId: ReviewProfileId,
  measurements: readonly ReviewMeasurementResult[],
): readonly VisualDiagnostic[] {
  return measurements
    .map((measurement) => reviewMeasurementDiagnostic(target, profileId, measurement))
    .filter((entry): entry is VisualDiagnostic => entry !== undefined);
}

function parseRenderProfileReport(value: unknown): StoredRenderProfileReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Render profile report is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'packwright.render-profile-report' ||
    record.rendererVersion !== REVIEW_PROFILE_RENDERER_VERSION ||
    !isReviewProfileId(record.profileId) ||
    !Number.isSafeInteger(record.profileVersion) ||
    (record.profileVersion as number) <= 0 ||
    typeof record.projectId !== 'string' ||
    typeof record.runId !== 'string' ||
    typeof record.revisionId !== 'string' ||
    typeof record.specSha256 !== 'string' ||
    typeof record.compiledArtifactId !== 'string' ||
    typeof record.planSha256 !== 'string' ||
    typeof record.reviewReady !== 'boolean' ||
    !Number.isSafeInteger(record.viewSize) ||
    (record.viewSize as number) < 32 ||
    (record.viewSize as number) > 256 ||
    !Array.isArray(record.requiredViewIds) ||
    !Array.isArray(record.views) ||
    !Array.isArray(record.measurements)
  ) {
    throw new Error('Render profile report identity is invalid.');
  }
  for (const hash of [record.specSha256, record.compiledArtifactId, record.planSha256]) {
    if (!SHA256_PATTERN.test(hash)) throw new Error('Render profile report hash is invalid.');
  }
  const requiredViewIds = record.requiredViewIds.map((view) => {
    if (typeof view !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(view)) {
      throw new Error('Render profile report required view is invalid.');
    }
    return view;
  });
  if (
    requiredViewIds.length > MAX_REVIEW_SCENES ||
    new Set(requiredViewIds).size !== requiredViewIds.length
  ) {
    throw new Error('Render profile report required views are duplicated or unbounded.');
  }
  const views = record.views.map((view) => {
    if (view === null || typeof view !== 'object' || Array.isArray(view)) {
      throw new Error('Render profile report view is invalid.');
    }
    const entry = view as Record<string, unknown>;
    if (
      typeof entry.id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(entry.id) ||
      typeof entry.required !== 'boolean' ||
      !Number.isSafeInteger(entry.width) ||
      (entry.width as number) <= 0 ||
      !Number.isSafeInteger(entry.height) ||
      (entry.height as number) <= 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error('Render profile report view is invalid.');
    }
    return {
      id: entry.id,
      required: entry.required,
      width: entry.width as number,
      height: entry.height as number,
      sha256: entry.sha256,
    };
  });
  if (
    views.length > MAX_REVIEW_SCENES ||
    new Set(views.map((view) => view.id)).size !== views.length
  ) {
    throw new Error('Render profile report views are duplicated or unbounded.');
  }
  const metricIds = new Set<string>(REVIEW_MEASUREMENT_IDS);
  const units = new Set<string>(REVIEW_MEASUREMENT_UNITS);
  const viewIds = new Set(views.map((view) => view.id));
  const measurements = record.measurements.map((measurement) => {
    if (measurement === null || typeof measurement !== 'object' || Array.isArray(measurement)) {
      throw new Error('Render profile measurement is invalid.');
    }
    const entry = measurement as Record<string, unknown>;
    if (
      typeof entry.metric !== 'string' ||
      !metricIds.has(entry.metric) ||
      (entry.view !== undefined &&
        (typeof entry.view !== 'string' ||
          !/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(entry.view) ||
          !viewIds.has(entry.view))) ||
      !['passed', 'warning', 'failed', 'skipped'].includes(String(entry.status)) ||
      !units.has(String(entry.unit)) ||
      typeof entry.message !== 'string' ||
      entry.message.length === 0 ||
      entry.message.length > 4096 ||
      (entry.value !== undefined &&
        (typeof entry.value !== 'number' || !Number.isFinite(entry.value))) ||
      (entry.threshold !== undefined &&
        (typeof entry.threshold !== 'number' || !Number.isFinite(entry.threshold))) ||
      (entry.partId !== undefined &&
        (typeof entry.partId !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(entry.partId)))
    ) {
      throw new Error('Render profile measurement is invalid.');
    }
    return entry as unknown as ReviewMeasurementResult;
  });
  if (measurements.length > MAX_REVIEW_MEASUREMENTS) {
    throw new Error('Render profile report contains too many measurements.');
  }
  return {
    schemaVersion: 1,
    kind: 'packwright.render-profile-report',
    projectId: record.projectId,
    runId: record.runId,
    revisionId: record.revisionId,
    specSha256: record.specSha256,
    compiledArtifactId: record.compiledArtifactId,
    rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
    profileId: record.profileId,
    profileVersion: record.profileVersion as number,
    viewSize: record.viewSize as number,
    planSha256: record.planSha256,
    requiredViewIds,
    reviewReady: record.reviewReady,
    views,
    measurements,
  };
}

function mediaType(filename: string): string {
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.mcfunction')) return 'text/x-mcfunction';
  return 'application/json';
}

function roleForCompiled(filename: string): VisualFile['role'] {
  if (filename.endsWith('.png')) return 'texture';
  if (filename.includes('/items/')) return 'item_definition';
  if (filename.includes('/models/')) return 'item_model';
  if (filename.endsWith('.mcfunction') || filename.includes('/recipe/')) return 'binding';
  return 'other';
}

function parseHexColor(value: string | undefined, fallback: string): Rgba {
  if (value !== undefined) {
    const match = /^#(?<rgb>[a-fA-F0-9]{6})(?<alpha>[a-fA-F0-9]{2})?$/u.exec(value);
    if (match?.groups?.rgb !== undefined) {
      const rgb = match.groups.rgb;
      const alpha = match.groups.alpha;
      return [
        Number.parseInt(rgb.slice(0, 2), 16),
        Number.parseInt(rgb.slice(2, 4), 16),
        Number.parseInt(rgb.slice(4, 6), 16),
        alpha === undefined ? 255 : Number.parseInt(alpha, 16),
      ];
    }
  }
  const digest = Buffer.from(sha256Buffer(fallback), 'hex');
  return [
    80 + ((digest[0] ?? 0) % 144),
    80 + ((digest[1] ?? 0) % 144),
    80 + ((digest[2] ?? 0) % 144),
    255,
  ];
}

function recordWithRevision(
  state: VisualProjectWorkflowState,
  record: VisualRevisionState,
  options: {
    readonly advanceLatest: boolean;
    readonly replaceTextures?: boolean;
  },
): VisualProjectWorkflowState {
  const previous = state.revisions[record.revisionId];
  if (previous !== undefined && previous.runId !== record.runId) {
    throw new PackwrightError(
      'precondition_failed',
      'A visual revision identity is already assigned to another run.',
    );
  }
  const merged: VisualRevisionState = {
    ...previous,
    ...record,
    textures: options.replaceTextures
      ? record.textures
      : { ...previous?.textures, ...record.textures },
  };
  return {
    schemaVersion: 1,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    ...(options.advanceLatest
      ? { latest: { runId: record.runId, revisionId: record.revisionId } }
      : state.latest === undefined
        ? {}
        : { latest: state.latest }),
    revisions: { ...state.revisions, [record.revisionId]: merged },
  };
}

function replaceRevisionRecord(
  state: VisualProjectWorkflowState,
  record: VisualRevisionState,
): VisualProjectWorkflowState {
  const previous = state.revisions[record.revisionId];
  if (previous?.runId !== record.runId || previous.specSha256 !== record.specSha256) {
    throw new PackwrightError(
      'precondition_failed',
      'The visual revision changed while a derived artifact was being prepared.',
    );
  }
  return {
    schemaVersion: 1,
    workspaceId: state.workspaceId,
    projectId: state.projectId,
    ...(state.latest === undefined ? {} : { latest: state.latest }),
    revisions: { ...state.revisions, [record.revisionId]: record },
  };
}

function withoutCommittedTransaction(record: VisualRevisionState): VisualRevisionState {
  return {
    runId: record.runId,
    revisionId: record.revisionId,
    specSha256: record.specSha256,
    textures: record.textures,
    ...(record.compiledArtifactId === undefined
      ? {}
      : { compiledArtifactId: record.compiledArtifactId }),
    ...(record.proposalArtifactId === undefined
      ? {}
      : { proposalArtifactId: record.proposalArtifactId }),
    ...(record.render === undefined ? {} : { render: record.render }),
    ...(record.reviewSha256 === undefined ? {} : { reviewSha256: record.reviewSha256 }),
  };
}

function withoutCompiledDerivatives(record: VisualRevisionState): VisualRevisionState {
  return {
    runId: record.runId,
    revisionId: record.revisionId,
    specSha256: record.specSha256,
    textures: record.textures,
    ...(record.reviewSha256 === undefined ? {} : { reviewSha256: record.reviewSha256 }),
  };
}

function currentRevision(
  state: VisualProjectWorkflowState,
  runId: string,
  revisionId?: string,
): VisualRevisionState {
  const selected =
    revisionId ?? (state.latest?.runId === runId ? state.latest.revisionId : undefined);
  if (selected === undefined) {
    throw new PackwrightError('not_found', 'No visual revision was selected for this run.', {
      runId,
    });
  }
  const record = state.revisions[selected];
  if (record?.runId !== runId) {
    throw new PackwrightError('not_found', 'Visual revision does not belong to the selected run.', {
      runId,
      revisionId: selected,
    });
  }
  return record;
}

function proposalValue(value: unknown): CommitProposal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackwrightError('invalid_content', 'Visual commit proposal is malformed.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.compiler !== 'packwright-visual-v1' ||
    record.minecraftVersion !== '26.2' ||
    !Array.isArray(record.dataPackFormat) ||
    record.dataPackFormat[0] !== 107 ||
    record.dataPackFormat[1] !== 1 ||
    !Array.isArray(record.resourcePackFormat) ||
    record.resourcePackFormat[0] !== 88 ||
    record.resourcePackFormat[1] !== 0 ||
    typeof record.projectId !== 'string' ||
    typeof record.runId !== 'string' ||
    typeof record.revisionId !== 'string' ||
    typeof record.manifestSha256 !== 'string' ||
    !SHA256_PATTERN.test(record.manifestSha256) ||
    typeof record.datapack !== 'string' ||
    typeof record.resourcepack !== 'string' ||
    typeof record.compiledArtifactId !== 'string' ||
    !SHA256_PATTERN.test(record.compiledArtifactId) ||
    !Array.isArray(record.files)
  ) {
    throw new PackwrightError('invalid_content', 'Visual commit proposal is malformed.');
  }
  const files: ProposalFile[] = record.files.map((entryValue) => {
    if (entryValue === null || typeof entryValue !== 'object' || Array.isArray(entryValue)) {
      throw new PackwrightError('invalid_content', 'Visual proposal file entry is malformed.');
    }
    const entry = entryValue as Record<string, unknown>;
    if (
      (entry.pack !== 'datapack' && entry.pack !== 'resourcepack') ||
      typeof entry.path !== 'string' ||
      entry.path.length === 0 ||
      entry.path.includes('\\') ||
      path.posix.isAbsolute(entry.path) ||
      path.posix.normalize(entry.path) !== entry.path ||
      entry.path === '..' ||
      entry.path.startsWith('../') ||
      (entry.expectedSha256 !== null &&
        (typeof entry.expectedSha256 !== 'string' || !SHA256_PATTERN.test(entry.expectedSha256))) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      typeof entry.mediaType !== 'string' ||
      typeof entry.role !== 'string'
    ) {
      throw new PackwrightError('invalid_content', 'Visual proposal file entry is malformed.');
    }
    return entry as unknown as ProposalFile;
  });
  const fileKeys = files.map((file) => `${file.pack}/${file.path}`);
  if (new Set(fileKeys).size !== fileKeys.length) {
    throw new PackwrightError('invalid_content', 'Visual proposal contains duplicate file paths.');
  }
  const binding = record.binding as Record<string, unknown> | undefined;
  const connection = record.connection as Record<string, unknown> | undefined;
  const parsedConnection = VisualConnectInputSchema.safeParse({
    projectId: record.projectId,
    runId: record.runId,
    revisionId: record.revisionId,
    carrierItem: binding?.carrierItem,
    generateGiveFunction: connection?.generateGiveFunction,
    generateRecipe: connection?.generateRecipe,
    ...(connection?.recipe === undefined ? {} : { recipe: connection.recipe }),
  });
  if (!parsedConnection.success) {
    throw new PackwrightError('invalid_content', 'Visual proposal connection is malformed.');
  }
  return {
    schemaVersion: 1,
    compiler: 'packwright-visual-v1',
    minecraftVersion: '26.2',
    dataPackFormat: [107, 1],
    resourcePackFormat: [88, 0],
    projectId: record.projectId,
    runId: record.runId,
    revisionId: record.revisionId,
    manifestSha256: record.manifestSha256,
    datapack: record.datapack,
    resourcepack: record.resourcepack,
    compiledArtifactId: record.compiledArtifactId,
    binding: record.binding as ItemBindingProposal,
    connection: {
      generateGiveFunction: parsedConnection.data.generateGiveFunction,
      generateRecipe: parsedConnection.data.generateRecipe,
      ...(parsedConnection.data.recipe === undefined
        ? {}
        : { recipe: parsedConnection.data.recipe }),
    },
    files,
  };
}

async function destinationSha256(workspace: Workspace, filename: string): Promise<string | null> {
  const absolute = await workspace.resolve(filename, { rejectSymlinks: true });
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PackwrightError('invalid_argument', 'Visual output target is not a regular file.', {
        path: filename,
      });
    }
    return (
      await snapshotStableFile(absolute, {
        maxBytes: Math.max(1, info.size),
        pathLabel: filename,
      })
    ).sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function packDestination(
  manifest: VisualProjectManifest,
  pack: ProposalFile['pack'],
  relative: string,
): string {
  return `${pack === 'datapack' ? manifest.datapack : manifest.resourcepack}/${relative}`;
}

function visualCommitReceiptPath(proposalSha256: string): string {
  if (!SHA256_PATTERN.test(proposalSha256)) {
    throw new PackwrightError('invalid_argument', 'Visual proposal SHA-256 is invalid.');
  }
  return `.packwright/visual-commits/${proposalSha256}.json`;
}

function createVisualCommitReceipt(
  workspaceId: string,
  project: VisualProjectInspection,
  proposalSha256: string,
  proposal: CommitProposal,
  clientCapture?: VisualRevisionState['clientCapture'],
): VisualCommitReceipt {
  return {
    schemaVersion: 1,
    kind: 'packwright.visual-commit',
    workspaceId,
    projectId: proposal.projectId,
    runId: proposal.runId,
    revisionId: proposal.revisionId,
    proposalSha256,
    manifestSha256: project.manifestSha256,
    transactionId: `visual-${proposalSha256}`,
    ...(clientCapture === undefined
      ? {}
      : {
          clientCapture: {
            authority: clientCapture.authority,
            evidenceSha256: clientCapture.reportSha256,
            sourceReportSha256: clientCapture.sourceReportSha256,
            planSha256: clientCapture.planSha256,
            clientJarSha256: clientCapture.clientJarSha256,
            captureModSha256: clientCapture.captureModSha256,
            datapackContentSha256: clientCapture.datapackContentSha256,
            resourcepackContentSha256: clientCapture.resourcepackContentSha256,
            runtimeManifestSha256: clientCapture.runtimeManifestSha256,
          },
        }),
    files: proposal.files.map((file) => ({
      path: packDestination(project.manifest, file.pack, file.path),
      sha256: file.sha256,
      size: file.size,
    })),
  };
}

async function visualCommitReceiptExists(
  workspace: Workspace,
  proposalSha256: string,
): Promise<boolean> {
  const filename = visualCommitReceiptPath(proposalSha256);
  const absolute = await workspace.resolve(filename, { rejectSymlinks: true });
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PackwrightError('invalid_content', 'Visual commit receipt is not a regular file.', {
        path: filename,
      });
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyVisualCommitReceipt(
  workspace: Workspace,
  receipt: VisualCommitReceipt,
  expectedReceiptSha256?: string,
): Promise<{ readonly receipt: VisualCommitReceipt; readonly sha256: string } | undefined> {
  const filename = visualCommitReceiptPath(receipt.proposalSha256);
  const absolute = await workspace.resolve(filename, { rejectSymlinks: true });
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new PackwrightError('invalid_content', 'Visual commit receipt is not a regular file.', {
      path: filename,
    });
  }
  const expectedBytes = canonicalJsonBytes(receipt);
  const stored = await readStableFile(absolute, {
    maxBytes: 1024 * 1024,
    collect: true,
    pathLabel: filename,
  });
  if (!stored.data?.equals(expectedBytes)) {
    throw new PackwrightError(
      'precondition_failed',
      'Visual commit receipt does not match the accepted proposal.',
      { path: filename },
    );
  }
  const journalDirectory = await workspace.resolve('.packwright/transactions', {
    rejectSymlinks: true,
  });
  let journalNames: string[] = [];
  try {
    const journalInfo = await lstat(journalDirectory);
    if (!journalInfo.isDirectory() || journalInfo.isSymbolicLink()) {
      throw new PackwrightError(
        'transaction_recovery_required',
        'Visual transaction journal storage is not a safe directory.',
      );
    }
    journalNames = await readdir(journalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (journalNames.length > 1024) {
    throw new PackwrightError(
      'transaction_recovery_required',
      'Too many retained transaction journals exist to reconcile a visual commit safely.',
    );
  }
  for (const journalName of journalNames) {
    if (!/^[0-9a-f-]{36}\.json$/u.test(journalName)) continue;
    const journalPath = `.packwright/transactions/${journalName}`;
    const journalAbsolute = await workspace.resolve(journalPath, {
      mustExist: true,
      rejectSymlinks: true,
    });
    const journal = await readStableFile(journalAbsolute, {
      maxBytes: 1024 * 1024,
      collect: true,
      pathLabel: journalPath,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(journal.data?.toString('utf8') ?? '');
    } catch {
      throw new PackwrightError(
        'transaction_recovery_required',
        'A retained transaction journal is malformed; visual commit reconciliation is unsafe.',
        { journal: journalPath },
      );
    }
    const files =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).files
        : undefined;
    if (!Array.isArray(files)) {
      throw new PackwrightError(
        'transaction_recovery_required',
        'A retained transaction journal is invalid; visual commit reconciliation is unsafe.',
        { journal: journalPath },
      );
    }
    if (
      files.some(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).path === filename,
      )
    ) {
      throw new PackwrightError(
        'transaction_recovery_required',
        'The visual commit has a retained transaction journal and requires recovery.',
        { journal: journalPath },
      );
    }
  }
  const receiptSha256 = sha256Buffer(expectedBytes);
  if (expectedReceiptSha256 !== undefined && receiptSha256 !== expectedReceiptSha256) {
    throw new PackwrightError(
      'precondition_failed',
      'Visual commit receipt hash does not match workflow state.',
      { path: filename, expectedSha256: expectedReceiptSha256, actualSha256: receiptSha256 },
    );
  }
  for (const file of receipt.files) {
    if ((await destinationSha256(workspace, file.path)) !== file.sha256) {
      throw new PackwrightError(
        'precondition_failed',
        `Committed visual output changed or is missing: ${file.path}`,
      );
    }
  }
  return { receipt, sha256: receiptSha256 };
}

function visualCommitResult(
  project: VisualProjectInspection,
  proposal: CommitProposal,
  receipt: VisualCommitReceipt,
): VisualCommitResult {
  return {
    ok: true,
    operation: 'visual_commit',
    projectId: proposal.projectId,
    runId: proposal.runId,
    revisionId: proposal.revisionId,
    transactionId: receipt.transactionId,
    ...(receipt.clientCapture === undefined
      ? {}
      : { clientCaptureReportSha256: receipt.clientCapture.evidenceSha256 }),
    files: proposal.files.map((file) => ({
      path: packDestination(project.manifest, file.pack, file.path),
      sha256: file.sha256,
      size: file.size,
      mediaType: file.mediaType,
      role: file.role,
    })),
    diagnostics: [],
  };
}

function createProposedContents(
  spec: ModelSpec,
  resourceFiles: Readonly<Record<string, Buffer | string>>,
  binding: ItemBindingProposal,
  connection: CommitProposal['connection'],
): ProposedContent[] {
  const { namespace, path: resourcePath } = parseResourceId(spec.id);
  const proposed: ProposedContent[] = Object.entries(resourceFiles).map(([filename, content]) => ({
    pack: 'resourcepack',
    path: filename,
    content,
    role: roleForCompiled(filename),
    mediaType: mediaType(filename),
  }));
  if (connection.generateGiveFunction) {
    proposed.push({
      pack: 'datapack',
      path: `data/${namespace}/function/packwright/give/${resourcePath}.mcfunction`,
      content: `${binding.giveCommand}\n`,
      role: 'binding',
      mediaType: 'text/x-mcfunction',
    });
  }
  if (connection.generateRecipe) {
    if (connection.recipe === undefined) {
      throw new PackwrightError(
        'invalid_content',
        'A generated recipe proposal has no canonical recipe input.',
      );
    }
    proposed.push({
      pack: 'datapack',
      path: `data/${namespace}/recipe/packwright/${resourcePath}.json`,
      content: serializeVisualJson({
        type: 'minecraft:crafting_shaped',
        category: 'misc',
        pattern: connection.recipe.pattern,
        key: connection.recipe.key,
        result: {
          id: binding.carrierItem,
          count: connection.recipe.count,
          components: { 'minecraft:item_model': spec.id },
        },
      }),
      role: 'binding',
      mediaType: 'application/json',
    });
  }
  return proposed.sort((left, right) =>
    compareVisualStrings(`${left.pack}/${left.path}`, `${right.pack}/${right.path}`),
  );
}

function outputFiles(
  project: VisualProjectInspection,
  files: readonly { path: string; content: Uint8Array | string }[],
): VisualFile[] {
  return files.map((file) =>
    asVisualFile(
      `${project.manifest.resourcepack}/${file.path}`,
      file.content,
      mediaType(file.path),
      roleForCompiled(file.path),
    ),
  );
}

export class VisualWorkflow {
  readonly workspace: Workspace;
  readonly config: RuntimeConfig;
  readonly runs: VisualRunStore;
  readonly states: VisualWorkflowStateStore;
  readonly operationLockRoot: string;
  readonly requireAuthoritativeClientCapture: boolean;

  constructor(workspace: Workspace, config: RuntimeConfig | string) {
    this.workspace = workspace;
    this.config =
      typeof config === 'string'
        ? {
            workspaceRoot: workspace.root,
            javaCommand: 'java',
            cacheDir: config,
            readOnly: false,
            offline: true,
          }
        : config;
    // The string overload is retained for the isolated, offline workflow unit
    // harness. Real application instances always receive RuntimeConfig and use
    // Minecraft client evidence as the acceptance authority where supported.
    this.requireAuthoritativeClientCapture = typeof config !== 'string';
    const cacheDir = this.config.cacheDir;
    this.runs = new VisualRunStore(cacheDir);
    this.states = new VisualWorkflowStateStore(cacheDir, workspace.root);
    this.operationLockRoot = path.join(
      path.resolve(cacheDir),
      'visual-project-operations',
      this.states.workspaceId,
    );
  }

  private withProjectMutationLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    if (!isVisualProjectId(projectId)) {
      throw new PackwrightError('invalid_argument', 'Visual project ID is invalid.');
    }
    return withPathLock(path.join(this.operationLockRoot, projectId), task);
  }

  runProjectOperation<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    return this.withProjectMutationLock(projectId, task);
  }

  private async reconcileCommitReceipt(
    project: VisualProjectInspection,
    state: VisualProjectWorkflowState,
    record: VisualRevisionState,
  ): Promise<{ readonly state: VisualProjectWorkflowState; readonly record: VisualRevisionState }> {
    const proposalSha256 = record.proposalArtifactId;
    if (proposalSha256 === undefined) return { state, record };
    const receiptExists = await visualCommitReceiptExists(this.workspace, proposalSha256);
    if (!receiptExists && record.committedReceiptSha256 === undefined) {
      return { state, record };
    }
    const artifact = await this.runs.readCompiled(record.runId, proposalSha256);
    const proposalBytes = artifact.contents['proposal.json'];
    if (proposalBytes === undefined) {
      throw new PackwrightError('invalid_content', 'Visual proposal artifact has no manifest.');
    }
    const proposal = proposalValue(JSON.parse(proposalBytes.toString('utf8')));
    if (
      proposal.projectId !== project.manifest.id ||
      proposal.runId !== record.runId ||
      proposal.revisionId !== record.revisionId ||
      proposal.manifestSha256 !== project.manifestSha256 ||
      proposal.datapack !== project.manifest.datapack ||
      proposal.resourcepack !== project.manifest.resourcepack ||
      proposal.compiledArtifactId !== record.compiledArtifactId
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Visual commit receipt is not bound to the current revision and paired-pack manifest.',
      );
    }
    const expected = createVisualCommitReceipt(
      this.states.workspaceId,
      project,
      proposalSha256,
      proposal,
      record.clientCapture,
    );
    const verified = await verifyVisualCommitReceipt(
      this.workspace,
      expected,
      record.committedReceiptSha256,
    );
    if (verified === undefined) {
      throw new PackwrightError(
        'precondition_failed',
        'The recorded visual commit receipt is missing.',
      );
    }
    const reconciled: VisualRevisionState = {
      ...record,
      committedTransactionId: verified.receipt.transactionId,
      committedReceiptSha256: verified.sha256,
    };
    return { state: replaceRevisionRecord(state, reconciled), record: reconciled };
  }

  private async persistCommitReceipt(
    projectId: string,
    runId: string,
    revisionId: string,
    proposalSha256: string,
    transactionId: string,
    receiptSha256: string,
  ): Promise<void> {
    try {
      await this.states.update(projectId, (current) => {
        const active = currentRevision(current, runId, revisionId);
        if (active.proposalArtifactId !== proposalSha256) {
          throw new PackwrightError(
            'precondition_failed',
            'A newer binding proposal replaced the committed proposal.',
          );
        }
        return replaceRevisionRecord(current, {
          ...active,
          committedTransactionId: transactionId,
          committedReceiptSha256: receiptSha256,
        });
      });
    } catch {
      // The workspace receipt is part of the same file transaction as every
      // generated output. Once it and all proposal hashes verify, a cache-state
      // write failure cannot make the workspace commit ambiguous; a retry or
      // state load will reconcile from the durable receipt.
    }
  }

  private async loadRevision(
    projectId: string,
    runId: string,
    revisionId?: string,
  ): Promise<LoadedRevision> {
    const [project, state] = await Promise.all([
      inspectVisualProject(this.workspace, projectId),
      this.states.read(projectId),
    ]);
    const record = currentRevision(state, runId, revisionId);
    const run = await this.runs.readRun(runId);
    if (
      run.request === null ||
      typeof run.request !== 'object' ||
      Array.isArray(run.request) ||
      (run.request as Record<string, unknown>).projectId !== projectId
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Visual run identity does not match the selected project.',
      );
    }
    const snapshot = await this.runs.readRevision(runId, record.revisionId);
    if (snapshot.modelSpecSha256 !== record.specSha256) {
      throw new PackwrightError(
        'precondition_failed',
        'Visual revision state failed its hash check.',
      );
    }
    const reconciled = await this.reconcileCommitReceipt(project, state, record);
    return {
      project,
      state: reconciled.state,
      record: reconciled.record,
      spec: parseModelSpec(snapshot.modelSpec),
    };
  }

  private async verifyRenderProfileEvidence(
    loaded: LoadedRevision,
    record: VisualRevisionState = loaded.record,
    signal?: AbortSignal,
  ): Promise<StoredRenderProfileReport> {
    const render = record.render;
    const compiledArtifactId = record.compiledArtifactId;
    if (render === undefined || compiledArtifactId === undefined) {
      throw new Error('Render-profile evidence is not available for this revision.');
    }
    if (render.compiledArtifactId !== compiledArtifactId) {
      throw new Error('Render was produced from a different compiled artifact.');
    }
    const reference = render.review;
    if (reference === undefined) {
      throw new Error('Render predates scene-profile reports and must be regenerated.');
    }
    const plan = resolveReviewProfile(loaded.spec, reference.viewSize);
    if (
      reference.rendererVersion !== REVIEW_PROFILE_RENDERER_VERSION ||
      reference.profileId !== loaded.spec.reviewProfile ||
      reference.profileId !== plan.profileId ||
      reference.profileVersion !== plan.profileVersion ||
      reference.specSha256 !== record.specSha256
    ) {
      throw new Error('Render profile identity is stale.');
    }
    if (
      reference.planSha256 !== plan.planSha256 ||
      !canonicalJsonBytes(reference.requiredViewIds).equals(
        canonicalJsonBytes(plan.requiredViewIds),
      )
    ) {
      throw new Error('Render profile plan no longer matches the current implementation.');
    }
    const expectedViewIds = plan.scenes.map((scene) => scene.id).sort(compareVisualStrings);
    const indexedViewIds = Object.keys(render.views).sort(compareVisualStrings);
    if (!canonicalJsonBytes(indexedViewIds).equals(canonicalJsonBytes(expectedViewIds))) {
      throw new Error('Render profile view index is incomplete or contains unexpected scenes.');
    }

    // A report is an index over derived evidence, not an authority for its own
    // measurements. Recreate the exact render from the immutable specification
    // and current texture inputs so a forged status/value/message cannot turn a
    // failing visual review into an accepted commit.
    abortIfNeeded(signal);
    const compiled = compileItemAsset(loaded.spec);
    const textureImages: Record<string, PixelImage> = {};
    for (const requirement of compiled.textures) {
      let image: PixelImage;
      if (requirement.external) {
        image = decodePng(
          await this.readExternalResource(loaded, requirement.path, 8 * 1024 * 1024, signal),
        );
      } else {
        const texture = record.textures[requirement.materialId];
        if (texture === undefined) {
          throw new Error(`Render-profile texture input is missing: ${requirement.materialId}`);
        }
        const storedTexture = await this.runs.readPng(
          record.runId,
          'texture',
          texture.label,
          texture.sha256,
        );
        if (
          storedTexture.width !== texture.width ||
          storedTexture.height !== texture.height ||
          storedTexture.bytes !== texture.bytes
        ) {
          throw new Error(`Render-profile texture metadata is stale: ${requirement.materialId}`);
        }
        image = decodePng(storedTexture.data);
      }
      if (image.width !== requirement.width || image.height !== requirement.height) {
        throw new Error(`Render-profile texture dimensions are stale: ${requirement.materialId}`);
      }
      textureImages[requirement.materialId] = image;
    }
    const canonicalRender = renderCompiledItemAsset(compiled, {
      textures: textureImages,
      viewSize: reference.viewSize,
      signal,
    });
    const canonicalPlan = canonicalRender.reviewProfile;
    const canonicalEvaluation = canonicalRender.evaluation;
    if (
      canonicalPlan === undefined ||
      canonicalEvaluation === undefined ||
      canonicalPlan.profileId !== plan.profileId ||
      canonicalPlan.profileVersion !== plan.profileVersion ||
      canonicalPlan.planSha256 !== plan.planSha256
    ) {
      throw new Error('Canonical render-profile evaluation is unavailable or stale.');
    }

    const stored = await this.runs.readReview(record.runId, reference.reportSha256);
    const report = parseRenderProfileReport(stored.value);
    if (
      report.projectId !== loaded.project.manifest.id ||
      report.runId !== record.runId ||
      report.revisionId !== record.revisionId ||
      report.specSha256 !== record.specSha256 ||
      report.compiledArtifactId !== compiledArtifactId ||
      report.profileId !== plan.profileId ||
      report.profileVersion !== plan.profileVersion ||
      report.planSha256 !== plan.planSha256 ||
      report.viewSize !== reference.viewSize ||
      report.reviewReady !== reference.reviewReady ||
      !canonicalJsonBytes(report.requiredViewIds).equals(
        canonicalJsonBytes(plan.requiredViewIds),
      ) ||
      report.views.length !== plan.scenes.length
    ) {
      throw new Error('Render profile report is not bound to this revision.');
    }

    const reportViews = new Map(report.views.map((view) => [view.id, view] as const));
    const canonicalViews = new Map(canonicalRender.views.map((view) => [view.id, view] as const));
    for (const scene of plan.scenes) {
      const indexed = render.views[scene.id];
      const reported = reportViews.get(scene.id);
      const canonical = canonicalViews.get(scene.id);
      if (
        indexed === undefined ||
        canonical === undefined ||
        reported?.required !== scene.required ||
        reported.sha256 !== indexed.sha256 ||
        reported.width !== indexed.width ||
        reported.height !== indexed.height ||
        canonical.sha256 !== indexed.sha256 ||
        canonical.width !== indexed.width ||
        canonical.height !== indexed.height
      ) {
        throw new Error(`Required render-profile view is missing or stale: ${scene.id}`);
      }
      const png = await this.runs.readPng(record.runId, 'render', indexed.label, indexed.sha256);
      if (
        png.width !== indexed.width ||
        png.height !== indexed.height ||
        png.bytes !== indexed.bytes
      ) {
        throw new Error(`Render-profile view metadata is stale: ${scene.id}`);
      }
    }

    const contact = await this.runs.readPng(
      record.runId,
      'render',
      render.contactSheet.label,
      render.contactSheet.sha256,
    );
    if (
      contact.width !== render.contactSheet.width ||
      contact.height !== render.contactSheet.height ||
      contact.bytes !== render.contactSheet.bytes ||
      canonicalRender.contactSheet.sha256 !== render.contactSheet.sha256 ||
      canonicalRender.contactSheet.width !== render.contactSheet.width ||
      canonicalRender.contactSheet.height !== render.contactSheet.height ||
      sha256Buffer(decodePng(contact.data).data) !== render.pixelSha256
    ) {
      throw new Error('Contact-sheet metadata or pixel hash does not match.');
    }

    if (
      report.reviewReady !== canonicalEvaluation.reviewReady ||
      reference.reviewReady !== canonicalEvaluation.reviewReady ||
      !canonicalJsonBytes(report.measurements).equals(
        canonicalJsonBytes(canonicalEvaluation.measurements),
      )
    ) {
      throw new Error('Render-profile measurements do not match canonical render evidence.');
    }

    const measuredKinds = new Set(report.measurements.map((measurement) => measurement.metric));
    const rules = new Map(plan.measurements.map((rule) => [rule.id, rule] as const));
    const sceneIds = new Set(plan.scenes.map((scene) => scene.id));
    for (const measurement of report.measurements) {
      const rule = rules.get(measurement.metric);
      if (
        rule?.unit !== measurement.unit ||
        (measurement.view !== undefined && !sceneIds.has(measurement.view))
      ) {
        throw new Error(`Render-profile measurement is not valid for ${plan.profileId}.`);
      }
    }
    for (const rule of plan.measurements) {
      if (!measuredKinds.has(rule.id)) {
        throw new Error(`Render-profile measurement is missing: ${rule.id}`);
      }
    }
    const derivedReady = !report.measurements.some(
      (measurement) => measurement.status === 'failed',
    );
    if (derivedReady !== report.reviewReady) {
      throw new Error('Render-profile readiness does not match its measurements.');
    }
    return report;
  }

  private async verifyClientCaptureEvidence(
    loaded: LoadedRevision,
    record: VisualRevisionState = loaded.record,
    signal?: AbortSignal,
  ): Promise<StoredClientCaptureEvidence> {
    const reference = record.clientCapture;
    if (
      reference === undefined ||
      record.compiledArtifactId === undefined ||
      record.proposalArtifactId === undefined
    ) {
      throw new Error('Minecraft client-capture evidence is not available for this revision.');
    }
    const reviewProfile = resolveReviewProfile(loaded.spec, 128);
    if (
      clientCaptureReviewSupport(reviewProfile.profileId) === 'unsupported' ||
      reference.profileId !== reviewProfile.profileId ||
      reference.profileVersion !== reviewProfile.profileVersion ||
      reference.specSha256 !== record.specSha256 ||
      reference.compiledArtifactId !== record.compiledArtifactId ||
      reference.proposalArtifactId !== record.proposalArtifactId ||
      reference.manifestSha256 !== loaded.project.manifestSha256
    ) {
      throw new Error('Minecraft client-capture identity is stale.');
    }

    abortIfNeeded(signal);
    const storedArtifact = await this.runs.readReview(record.runId, reference.reportSha256);
    const stored = parseStoredClientCaptureEvidence(storedArtifact.value);
    const plan = stored.plan;
    const report = stored.report;
    if (
      plan.planSha256 !== reference.planSha256 ||
      report.runtime.rendererBackend !== MINECRAFT_26_2.clientCapture.graphicsBackend ||
      stored.sourceReportSha256 !== reference.sourceReportSha256 ||
      stored.sourceReport.sha256 !== stored.sourceReportSha256 ||
      stored.completion.sha256 !== stored.completionSha256
    ) {
      throw new Error('Minecraft client-capture protocol identity is stale.');
    }

    const provenance = plan.provenance;
    if (
      provenance.projectId !== loaded.project.manifest.id ||
      provenance.runId !== record.runId ||
      provenance.revisionId !== record.revisionId ||
      provenance.specSha256 !== record.specSha256 ||
      provenance.compiledArtifactId !== record.compiledArtifactId ||
      provenance.proposalArtifactId !== record.proposalArtifactId ||
      provenance.projectManifestSha256 !== loaded.project.manifestSha256 ||
      provenance.datapackContentSha256 !== reference.datapackContentSha256 ||
      provenance.resourcepackContentSha256 !== reference.resourcepackContentSha256 ||
      provenance.runtimeManifestSha256 !== reference.runtimeManifestSha256 ||
      provenance.client.jarSha1 !== reference.clientJarSha1 ||
      provenance.client.jarSha256 !== reference.clientJarSha256 ||
      provenance.captureMod.id !== MINECRAFT_26_2.clientCapture.captureMod.id ||
      provenance.captureMod.version !== MINECRAFT_26_2.clientCapture.captureMod.version ||
      provenance.captureMod.sha256 !== MINECRAFT_26_2.clientCapture.captureMod.sha256 ||
      reference.captureModSha256 !== MINECRAFT_26_2.clientCapture.captureMod.sha256
    ) {
      throw new Error('Minecraft client-capture provenance does not match this revision.');
    }

    const proposalArtifact = await this.runs.readCompiled(record.runId, record.proposalArtifactId);
    const proposalBytes = proposalArtifact.contents['proposal.json'];
    if (proposalBytes === undefined) throw new Error('Client-capture proposal is unavailable.');
    const proposal = proposalValue(JSON.parse(proposalBytes.toString('utf8')));
    if (
      proposal.projectId !== loaded.project.manifest.id ||
      proposal.runId !== record.runId ||
      proposal.revisionId !== record.revisionId ||
      proposal.compiledArtifactId !== record.compiledArtifactId ||
      proposal.manifestSha256 !== loaded.project.manifestSha256 ||
      provenance.itemStack.itemId !== proposal.binding.itemStack.id ||
      provenance.itemStack.count !== proposal.binding.itemStack.count ||
      provenance.itemStack.command !== proposal.binding.giveCommand ||
      !canonicalJsonBytes(provenance.itemStack.components).equals(
        canonicalJsonBytes(clientCaptureComponentLiterals(proposal.binding)),
      )
    ) {
      throw new Error('Minecraft client-capture item stack or proposal is stale.');
    }

    const overlay = await this.readProposalOverlay(
      loaded.project.manifest.id,
      record.runId,
      record.revisionId,
    );
    const [datapackSource, resourcepackSource] = await Promise.all([
      readConfinedPackSnapshot(this.workspace, loaded.project.manifest.datapack, signal),
      readConfinedPackSnapshot(this.workspace, loaded.project.manifest.resourcepack, signal),
    ]);
    const datapack = applyPackSnapshotOverlay(
      datapackSource,
      overlay.files
        .filter((file) => file.pack === 'datapack')
        .map((file) => ({ path: file.path, data: file.data })),
    );
    const resourcepack = applyPackSnapshotOverlay(
      resourcepackSource,
      overlay.files
        .filter((file) => file.pack === 'resourcepack')
        .map((file) => ({ path: file.path, data: file.data })),
    );
    const [datapackArchive, resourcepackArchive] = await Promise.all([
      createDeterministicZipArchive(datapack.entries),
      createDeterministicZipArchive(resourcepack.entries),
    ]);
    if (
      datapackArchive.sha256 !== provenance.datapackContentSha256 ||
      resourcepackArchive.sha256 !== provenance.resourcepackContentSha256
    ) {
      throw new Error('Paired-pack content changed after the Minecraft client capture.');
    }

    const firstScene = plan.scenes[0];
    if (firstScene === undefined) throw new Error('Minecraft client-capture plan has no scenes.');
    const expectedPlan = createVisualClientCapturePlan({
      spec: loaded.spec,
      width: firstScene.resolution.width,
      height: firstScene.resolution.height,
      guiScale: firstScene.guiScale,
      provenance,
      execution: plan.execution,
    });
    if (
      expectedPlan.planSha256 !== plan.planSha256 ||
      !canonicalJsonBytes(expectedPlan.scenes).equals(canonicalJsonBytes(plan.scenes)) ||
      !canonicalJsonBytes(reference.requiredViewIds).equals(
        canonicalJsonBytes(plan.scenes.map((scene) => scene.id)),
      )
    ) {
      throw new Error('Minecraft client-capture scene plan is stale.');
    }

    const [sourceReport, completion, log] = await Promise.all([
      this.runs.readCaptureBlob(
        record.runId,
        stored.sourceReport.label,
        'json',
        stored.sourceReport.sha256,
      ),
      this.runs.readCaptureBlob(
        record.runId,
        stored.completion.label,
        'json',
        stored.completion.sha256,
      ),
      this.runs.readCaptureBlob(record.runId, stored.log.label, 'log', stored.log.sha256),
    ]);
    if (
      sourceReport.bytes !== stored.sourceReport.bytes ||
      completion.bytes !== stored.completion.bytes ||
      log.bytes !== stored.log.bytes ||
      stored.log.sha256 !== reference.log.sha256 ||
      stored.log.label !== reference.log.label ||
      stored.log.bytes !== reference.log.bytes
    ) {
      throw new Error('Minecraft client-capture source artifact metadata is stale.');
    }
    const parsedSourceReport = parseClientCaptureReportBytes(sourceReport.data, plan);
    const sentinel = parseClientCaptureCompletionSentinelBytes(completion.data, plan);
    if (
      parsedSourceReport.status !== 'complete' ||
      !canonicalJsonBytes(parsedSourceReport).equals(canonicalJsonBytes(report)) ||
      sentinel.report.sha256 !== stored.sourceReportSha256 ||
      sentinel.report.bytes !== sourceReport.bytes ||
      sha256Buffer(sourceReport.data) !== stored.sourceReportSha256 ||
      sha256Buffer(log.data) !== report.log.sha256 ||
      log.bytes !== report.log.bytes
    ) {
      throw new Error('Minecraft client-capture report, sentinel, or log failed verification.');
    }

    const storedViewMap = new Map(stored.views.map((view) => [view.id, view] as const));
    const reportViewMap = new Map(report.views.map((view) => [view.sceneId, view] as const));
    const renderedViews: RenderedView[] = [];
    if (
      storedViewMap.size !== plan.scenes.length ||
      reportViewMap.size !== plan.scenes.length ||
      Object.keys(reference.views).length !== plan.scenes.length
    ) {
      throw new Error('Minecraft client-capture view index is incomplete.');
    }
    for (const scene of plan.scenes) {
      abortIfNeeded(signal);
      const indexed = reference.views[scene.id];
      const storedView = storedViewMap.get(scene.id);
      const reported = reportViewMap.get(scene.id);
      if (
        indexed === undefined ||
        storedView === undefined ||
        reported === undefined ||
        indexed.source !== 'captured' ||
        indexed.sourceSha256 !== storedView.sourceSha256 ||
        indexed.sha256 !== storedView.normalizedSha256 ||
        indexed.label !== storedView.label ||
        indexed.width !== storedView.width ||
        indexed.height !== storedView.height ||
        indexed.bytes !== storedView.bytes ||
        reported.pngSha256 !== storedView.sourceSha256
      ) {
        throw new Error(`Minecraft client-capture view is stale: ${scene.id}`);
      }
      const [raw, normalized] = await Promise.all([
        this.runs.readCaptureBlob(record.runId, storedView.label, 'png', storedView.sourceSha256),
        this.runs.readPng(record.runId, 'capture', storedView.label, storedView.normalizedSha256),
      ]);
      const canonical = normalizePng(raw.data);
      if (
        raw.bytes !== reported.bytes ||
        canonical.sourceSha256 !== reported.pngSha256 ||
        canonical.sha256 !== normalized.sha256 ||
        canonical.png.length !== normalized.bytes ||
        canonical.image.width !== reported.width ||
        canonical.image.height !== reported.height ||
        normalized.width !== storedView.width ||
        normalized.height !== storedView.height ||
        normalized.bytes !== storedView.bytes
      ) {
        throw new Error(`Minecraft framebuffer PNG failed verification: ${scene.id}`);
      }
      renderedViews.push({
        id: scene.id,
        width: canonical.image.width,
        height: canonical.image.height,
        image: canonical.image,
        png: raw.data,
        sha256: canonical.sourceSha256,
      });
    }

    const contact = await this.runs.readPng(
      record.runId,
      'capture',
      stored.contactSheet.label,
      stored.contactSheet.sha256,
    );
    const canonicalContact = createContactSheet(renderedViews);
    if (
      stored.contactSheet.label !== reference.contactSheet.label ||
      stored.contactSheet.sha256 !== reference.contactSheet.sha256 ||
      stored.contactSheet.width !== reference.contactSheet.width ||
      stored.contactSheet.height !== reference.contactSheet.height ||
      stored.contactSheet.bytes !== reference.contactSheet.bytes ||
      contact.sha256 !== canonicalContact.sha256 ||
      contact.width !== canonicalContact.width ||
      contact.height !== canonicalContact.height ||
      contact.bytes !== canonicalContact.png.length
    ) {
      throw new Error('Minecraft client-capture contact sheet failed verification.');
    }
    return stored;
  }

  private async readExternalResource(
    loaded: LoadedRevision,
    relativePath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const workspacePath = `${loaded.project.manifest.resourcepack}/${relativePath}`;
    let absolute: string;
    try {
      absolute = await this.workspace.resolve(workspacePath, {
        mustExist: true,
        rejectSymlinks: true,
      });
    } catch (error) {
      throw new PackwrightError(
        'validation_failed',
        `External visual dependency is missing: ${relativePath}`,
        { path: workspacePath, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new PackwrightError(
        'validation_failed',
        `External visual dependency is not a regular file: ${relativePath}`,
        { path: workspacePath },
      );
    }
    const stable = await readStableFile(absolute, {
      maxBytes: Math.min(maxBytes, Math.max(1, info.size)),
      collect: true,
      signal,
      pathLabel: workspacePath,
    });
    if (stable.data === undefined) {
      throw new PackwrightError(
        'precondition_failed',
        `External visual dependency changed while it was read: ${relativePath}`,
      );
    }
    return stable.data;
  }

  async attachProject(input: VisualProjectAttachInput): Promise<VisualProjectAttachResult> {
    return this.withProjectMutationLock(input.id, () => this.attachProjectUnlocked(input));
  }

  private async attachProjectUnlocked(
    input: VisualProjectAttachInput,
  ): Promise<VisualProjectAttachResult> {
    abortIfNeeded();
    if (!isVisualProjectId(input.id)) {
      throw new PackwrightError('invalid_argument', 'Visual project ID is invalid.');
    }
    const manifest = parseVisualProjectManifest(this.workspace, {
      schemaVersion: 1,
      id: input.id,
      minecraftVersion: input.minecraftVersion,
      datapack: input.datapack,
      resourcepack: input.resourcepack,
      target: 'vanilla',
    });
    const datapack = await inspectDatapack(this.workspace, manifest.datapack);
    if (!datapack.compatible) {
      throw new PackwrightError(
        'validation_failed',
        'The associated datapack is not compatible with Minecraft 26.2.',
      );
    }
    const resourceRoot = await this.workspace.resolve(manifest.resourcepack, {
      rejectSymlinks: true,
    });
    let resourceExists = false;
    try {
      const info = await lstat(resourceRoot);
      resourceExists = info.isDirectory() && !info.isSymbolicLink();
      if (!resourceExists) {
        throw new PackwrightError('invalid_argument', 'Resource-pack target is not a directory.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!resourceExists && !input.createResourcepack) {
      throw new PackwrightError(
        'not_found',
        'The resource pack does not exist and creation is disabled.',
      );
    }

    const metadataContent = serializeVisualJson(createResourcePackMetadata(input.description));
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = visualProjectManifestPath(input.id);
    const files: VisualFile[] = [];
    let inspection: VisualProjectInspection;
    let changed = false;
    const resourcepackCreated = !resourceExists;

    if (!resourceExists) {
      const metadataPath = `${manifest.resourcepack}/pack.mcmeta`;
      const manifestExpected = input.expectedManifestSha256 ?? null;
      files.push(
        asVisualFile(metadataPath, metadataContent, 'application/json', 'pack_metadata'),
        asVisualFile(manifestPath, manifestContent, 'application/json', 'manifest'),
      );
      changed = true;
      if (!input.dryRun) {
        await commitFileTransaction(this.workspace, [
          { path: metadataPath, content: metadataContent, expectedSha256: null },
          { path: manifestPath, content: manifestContent, expectedSha256: manifestExpected },
        ]);
        inspection = await inspectVisualProject(this.workspace, input.id);
      } else {
        inspection = {
          manifest,
          manifestPath,
          manifestSha256: sha256Buffer(manifestContent),
          datapack: {
            kind: 'datapack',
            path: manifest.datapack,
            present: true,
            compatible: true,
            expectedFormat: [107, 1],
            actualFormat: [107, 1],
            issues: [],
          },
          resourcepack: {
            kind: 'resourcepack',
            path: manifest.resourcepack,
            present: false,
            compatible: true,
            expectedFormat: [88, 0],
            actualFormat: [88, 0],
            issues: [],
          },
          ready: true,
        };
      }
    } else {
      const attached = await attachVisualProjectManifest(this.workspace, {
        id: input.id,
        datapack: input.datapack,
        resourcepack: input.resourcepack,
        minecraftVersion: input.minecraftVersion,
        overwrite: input.expectedManifestSha256 !== undefined,
        ...(input.expectedManifestSha256 === undefined
          ? {}
          : { expectedSha256: input.expectedManifestSha256 }),
        dryRun: input.dryRun,
      });
      if (attached.value === undefined)
        throw new Error('Visual project attachment returned no inspection.');
      inspection = attached.value;
      changed = attached.changed;
      files.push(asVisualFile(manifestPath, manifestContent, 'application/json', 'manifest'));
    }

    return {
      ok: true,
      operation: 'visual_project_attach',
      changed,
      dryRun: input.dryRun,
      project: inspection.manifest,
      manifestPath,
      manifestSha256: inspection.manifestSha256,
      resourcepackCreated,
      files,
      diagnostics: [],
    };
  }

  async upsertSpec(input: VisualSpecUpsertInput, signal?: AbortSignal): Promise<VisualDraftResult> {
    return this.withProjectMutationLock(input.projectId, () =>
      this.upsertSpecUnlocked(input, signal),
    );
  }

  private async upsertSpecUnlocked(
    input: VisualSpecUpsertInput,
    signal?: AbortSignal,
  ): Promise<VisualDraftResult> {
    abortIfNeeded(signal);
    await inspectVisualProject(this.workspace, input.projectId);
    const spec = parseModelSpec(input.spec);
    const provenance = { ...input.provenance, action: 'visual_spec_upsert' };
    const run = await this.runs.createRun({
      request: { schemaVersion: 1, projectId: input.projectId, description: input.request },
      modelSpec: spec,
      provenance,
      signal,
    });
    const revision = await this.runs.createRevision(run.runId, {
      modelSpec: spec,
      provenance,
      signal,
    });
    const record: VisualRevisionState = {
      runId: run.runId,
      revisionId: revision.revisionId,
      specSha256: revision.modelSpecSha256,
      textures: {},
    };
    await this.states.update(input.projectId, (current) => {
      if (input.parentRunId !== undefined && current.latest?.runId !== input.parentRunId) {
        throw new PackwrightError(
          'precondition_failed',
          'The selected parent run is no longer latest.',
        );
      }
      if (input.expectedSpecSha256 !== undefined) {
        const currentSpec =
          current.latest === undefined
            ? undefined
            : current.revisions[current.latest.revisionId]?.specSha256;
        if (currentSpec !== input.expectedSpecSha256) {
          throw new PackwrightError(
            'precondition_failed',
            'The visual specification changed since it was read.',
          );
        }
      }
      return recordWithRevision(current, record, {
        advanceLatest: true,
        replaceTextures: true,
      });
    });
    const content = canonicalJsonBytes(spec);
    return {
      ok: true,
      operation: 'visual_spec_upsert',
      projectId: input.projectId,
      runId: run.runId,
      revisionId: revision.revisionId,
      specSha256: revision.modelSpecSha256,
      files: [
        asVisualFile(
          `visual-runs/${run.runId}/revisions/${revision.revisionId}/model-spec.json`,
          content,
          'application/json',
          'model_spec',
        ),
      ],
      diagnostics: [],
    };
  }

  async importTexture(input: TextureImportInput, signal?: AbortSignal): Promise<VisualDraftResult> {
    return this.withProjectMutationLock(input.projectId, () =>
      this.importTextureUnlocked(input, signal),
    );
  }

  private async importTextureUnlocked(
    input: TextureImportInput,
    signal?: AbortSignal,
  ): Promise<VisualDraftResult> {
    const loaded = await this.loadRevision(input.projectId, input.runId, input.revisionId);
    abortIfNeeded(signal);
    const requirement = compileItemAsset(loaded.spec).textures.find(
      (entry) => entry.materialId === input.material && !entry.external,
    );
    if (requirement === undefined) {
      throw new PackwrightError(
        'invalid_argument',
        `Material '${input.material}' is not an importable generated texture in this specification.`,
      );
    }
    let png: Buffer;
    if (input.source.kind === 'png_base64') {
      png = Buffer.from(input.source.data, 'base64');
    } else {
      const absolute = await this.workspace.resolve(input.source.path, {
        mustExist: true,
        rejectSymlinks: true,
      });
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new PackwrightError('invalid_argument', 'Texture source must be a regular PNG file.');
      }
      const stable = await readStableFile(absolute, {
        maxBytes: 8 * 1024 * 1024,
        collect: true,
        signal,
        pathLabel: input.source.path,
      });
      if (stable.snapshot.sha256 !== input.source.expectedSha256 || stable.data === undefined) {
        throw new PackwrightError(
          'precondition_failed',
          'Texture source changed since it was read.',
        );
      }
      png = stable.data;
    }
    const artifact = await this.runs.putTexture(input.runId, png, { signal });
    const parentSnapshot = await this.runs.readRevision(input.runId, loaded.record.revisionId);
    const provenance = {
      ...(parentSnapshot.provenance as Record<string, unknown>),
      action: 'texture_import',
      material: input.material,
      textureSha256: artifact.sha256,
      textureSourceSha256: artifact.sourceSha256,
      strippedMetadata: artifact.strippedMetadata,
      sourceKind: input.source.kind,
    };
    const revision = await this.runs.createRevision(input.runId, {
      modelSpec: loaded.spec,
      provenance,
      parentRevisionId: loaded.record.revisionId,
      signal,
    });
    const reference: VisualPngReference = {
      label: 'texture',
      sha256: artifact.sha256,
      width: artifact.width,
      height: artifact.height,
      bytes: artifact.bytes,
      source: 'imported',
      sourceSha256: artifact.sourceSha256,
      strippedMetadata: artifact.strippedMetadata,
    };
    const record: VisualRevisionState = {
      runId: input.runId,
      revisionId: revision.revisionId,
      specSha256: revision.modelSpecSha256,
      textures: { ...loaded.record.textures, [input.material]: reference },
    };
    await this.states.update(input.projectId, (current) => {
      if (
        current.latest?.runId !== loaded.record.runId ||
        current.latest.revisionId !== loaded.record.revisionId
      ) {
        throw new PackwrightError(
          'precondition_failed',
          'The texture import parent is no longer the latest visual revision.',
        );
      }
      return recordWithRevision(current, record, { advanceLatest: true });
    });
    const stored = await this.runs.readPng(input.runId, 'texture', 'texture', artifact.sha256);
    return {
      ok: true,
      operation: 'texture_import',
      projectId: input.projectId,
      runId: input.runId,
      revisionId: revision.revisionId,
      parentRevisionId: loaded.record.revisionId,
      specSha256: revision.modelSpecSha256,
      files: [
        asVisualFile(
          `visual-runs/${input.runId}/textures/texture-${artifact.sha256}.png`,
          stored.data,
          'image/png',
          'texture',
        ),
      ],
      diagnostics: [],
    };
  }

  private async ensureCompiled(
    loaded: LoadedRevision,
    signal?: AbortSignal,
  ): Promise<{
    readonly compiled: CompiledItemAsset;
    readonly graph: VisualAssetGraph;
    readonly binding: ItemBindingProposal;
    readonly validation: VisualValidationResult;
    readonly record: VisualRevisionState;
    readonly resourceFiles: Readonly<Record<string, Buffer | string>>;
    readonly textureImages: Readonly<Record<string, PixelImage>>;
  }> {
    abortIfNeeded(signal);
    const compiled = compileItemAsset(loaded.spec);
    const binding = createItemBindingProposal(loaded.spec, compiled);
    const graph = createItemAssetGraph(compiled, binding, loaded.project.manifest.id);
    const references: Record<string, VisualPngReference> = { ...loaded.record.textures };
    const resourceFiles: Record<string, Buffer | string> = {};
    const textureImages: Record<string, PixelImage> = {};
    for (const file of compiled.files) resourceFiles[file.path] = file.content;

    for (const requirement of compiled.textures) {
      if (requirement.external) {
        const external = await this.readExternalResource(
          loaded,
          requirement.path,
          8 * 1024 * 1024,
          signal,
        );
        const image = decodePng(external);
        if (image.width !== requirement.width || image.height !== requirement.height) {
          throw new PackwrightError(
            'validation_failed',
            `External texture for material '${requirement.materialId}' must be ${String(requirement.width)}x${String(requirement.height)} pixels.`,
            { path: requirement.path },
          );
        }
        resourceFiles[requirement.path] = external;
        textureImages[requirement.materialId] = image;
        continue;
      }
      let reference = references[requirement.materialId];
      if (reference === undefined) {
        const material = loaded.spec.materials[requirement.materialId];
        const image = solidTexture(
          requirement.width,
          requirement.height,
          parseHexColor(material?.color, `${loaded.spec.id}:${requirement.materialId}`),
        );
        const generated = await this.runs.putTexture(loaded.record.runId, encodePng(image), {
          signal,
        });
        reference = {
          label: 'texture',
          sha256: generated.sha256,
          width: generated.width,
          height: generated.height,
          bytes: generated.bytes,
          source: 'generated',
          sourceSha256: generated.sourceSha256,
          strippedMetadata: generated.strippedMetadata,
        };
        references[requirement.materialId] = reference;
      }
      const stored = await this.runs.readPng(
        loaded.record.runId,
        'texture',
        reference.label,
        reference.sha256,
      );
      if (stored.width !== requirement.width || stored.height !== requirement.height) {
        throw new PackwrightError(
          'validation_failed',
          `Texture for material '${requirement.materialId}' must be ${String(requirement.width)}x${String(requirement.height)} pixels.`,
        );
      }
      resourceFiles[requirement.path] = stored.data;
      textureImages[requirement.materialId] = decodePng(stored.data);
    }

    for (const resourceId of compiled.externalModelReferences) {
      const { namespace, path: modelPath } = parseResourceId(resourceId);
      const filename = `assets/${namespace}/models/${modelPath}.json`;
      const content = await this.readExternalResource(loaded, filename, 4 * 1024 * 1024, signal);
      try {
        JSON.parse(content.toString('utf8'));
      } catch {
        throw new PackwrightError(
          'validation_failed',
          `External item-state model '${resourceId}' is not valid JSON.`,
          { path: filename },
        );
      }
      resourceFiles[filename] = content;
    }

    const validation = validateVisualAsset(loaded.spec, compiled, graph, {
      availableTextureResourceIds: new Set(
        compiled.textures.filter((entry) => !entry.external).map((entry) => entry.resourceId),
      ),
      availableModelResourceIds: new Set(compiled.externalModelReferences),
    });
    const storedCompiled = await this.runs.putCompiled(
      loaded.record.runId,
      Object.fromEntries(
        Object.entries(resourceFiles).map(([filename, content]) => [
          `resourcepack/${filename}`,
          content,
        ]),
      ),
      signal,
    );
    const nextState = await this.states.update(loaded.project.manifest.id, (current) => {
      const active = currentRevision(current, loaded.record.runId, loaded.record.revisionId);
      const sameArtifact = active.compiledArtifactId === storedCompiled.artifactId;
      return replaceRevisionRecord(current, {
        ...(sameArtifact ? active : withoutCompiledDerivatives(active)),
        textures: { ...active.textures, ...references },
        compiledArtifactId: storedCompiled.artifactId,
      });
    });
    const record = currentRevision(nextState, loaded.record.runId, loaded.record.revisionId);
    return { compiled, graph, binding, validation, record, resourceFiles, textureImages };
  }

  async compile(
    projectId: string,
    runId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<VisualDraftResult> {
    return this.withProjectMutationLock(projectId, () =>
      this.compileUnlocked(projectId, runId, revisionId, signal),
    );
  }

  private async compileUnlocked(
    projectId: string,
    runId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<VisualDraftResult> {
    const loaded = await this.loadRevision(projectId, runId, revisionId);
    const prepared = await this.ensureCompiled(loaded, signal);
    const files = outputFiles(
      loaded.project,
      Object.entries(prepared.resourceFiles).map(([path, content]) => ({ path, content })),
    );
    return {
      ok: prepared.validation.ok,
      operation: 'visual_compile',
      projectId,
      runId,
      revisionId: prepared.record.revisionId,
      specSha256: prepared.record.specSha256,
      files,
      diagnostics: prepared.validation.diagnostics.map(visualDiagnostic),
    };
  }

  async connect(input: VisualConnectInput, signal?: AbortSignal): Promise<VisualDraftResult> {
    return this.withProjectMutationLock(input.projectId, () => this.connectUnlocked(input, signal));
  }

  private async connectUnlocked(
    input: VisualConnectInput,
    signal?: AbortSignal,
  ): Promise<VisualDraftResult> {
    const loaded = await this.loadRevision(input.projectId, input.runId, input.revisionId);
    if (!loaded.project.ready) {
      throw new PackwrightError(
        'validation_failed',
        'Both paired packs must be present and compatible before creating a binding proposal.',
      );
    }
    const prepared = await this.ensureCompiled(loaded, signal);
    const binding = createItemBindingProposal(loaded.spec, prepared.compiled, input.carrierItem);
    const graph = createItemAssetGraph(prepared.compiled, binding, input.projectId);
    const validation = validateVisualAsset(loaded.spec, prepared.compiled, graph, {
      availableTextureResourceIds: new Set(
        prepared.compiled.textures
          .filter((entry) => !entry.external)
          .map((entry) => entry.resourceId),
      ),
    });
    if (!validation.ok) {
      throw new PackwrightError(
        'validation_failed',
        'The visual draft has structural errors and cannot be connected.',
        { diagnostics: validation.diagnostics },
      );
    }
    const connection: CommitProposal['connection'] = {
      generateGiveFunction: input.generateGiveFunction,
      generateRecipe: input.generateRecipe,
      ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
    };
    const proposed = createProposedContents(
      loaded.spec,
      prepared.resourceFiles,
      binding,
      connection,
    );
    const proposalFiles: ProposalFile[] = [];
    for (const entry of proposed) {
      const destination = packDestination(loaded.project.manifest, entry.pack, entry.path);
      const bytes =
        typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
      proposalFiles.push({
        pack: entry.pack,
        path: entry.path,
        expectedSha256: await destinationSha256(this.workspace, destination),
        sha256: sha256Buffer(bytes),
        size: bytes.length,
        mediaType: entry.mediaType,
        role: entry.role,
      });
    }
    const compiledArtifactId = prepared.record.compiledArtifactId;
    if (compiledArtifactId === undefined) {
      throw new Error('Compiled visual artifact was not indexed.');
    }
    const proposal: CommitProposal = {
      schemaVersion: 1,
      compiler: 'packwright-visual-v1',
      minecraftVersion: '26.2',
      dataPackFormat: [107, 1],
      resourcePackFormat: [88, 0],
      projectId: input.projectId,
      runId: input.runId,
      revisionId: prepared.record.revisionId,
      manifestSha256: loaded.project.manifestSha256,
      datapack: loaded.project.manifest.datapack,
      resourcepack: loaded.project.manifest.resourcepack,
      compiledArtifactId,
      binding,
      connection,
      files: proposalFiles,
    };
    const artifactFiles: Record<string, Buffer | string> = {
      'proposal.json': canonicalJsonBytes(proposal),
      'binding.json': canonicalJsonBytes(binding),
      'graph.json': canonicalJsonBytes(graph),
    };
    for (const entry of proposed) artifactFiles[`${entry.pack}/${entry.path}`] = entry.content;
    const artifact = await this.runs.putCompiled(input.runId, artifactFiles, signal);
    const nextState = await this.states.update(input.projectId, (current) => {
      const active = currentRevision(current, input.runId, prepared.record.revisionId);
      const sameProposal = active.proposalArtifactId === artifact.artifactId;
      return replaceRevisionRecord(current, {
        ...(sameProposal ? active : withoutCommittedTransaction(active)),
        proposalArtifactId: artifact.artifactId,
      });
    });
    const record = currentRevision(nextState, input.runId, prepared.record.revisionId);
    return {
      ok: true,
      operation: 'visual_connect',
      projectId: input.projectId,
      runId: input.runId,
      revisionId: record.revisionId,
      specSha256: record.specSha256,
      proposalSha256: artifact.artifactId,
      files: proposed.map((entry) =>
        asVisualFile(
          packDestination(loaded.project.manifest, entry.pack, entry.path),
          entry.content,
          entry.mediaType,
          entry.role,
        ),
      ),
      diagnostics: validation.diagnostics.map(visualDiagnostic),
    };
  }

  async render(input: VisualRenderInput, signal?: AbortSignal): Promise<VisualRenderResult> {
    return this.withProjectMutationLock(input.projectId, () => this.renderUnlocked(input, signal));
  }

  private async renderUnlocked(
    input: VisualRenderInput,
    signal?: AbortSignal,
  ): Promise<VisualRenderResult> {
    const loaded = await this.loadRevision(input.projectId, input.runId, input.revisionId);
    const prepared = await this.ensureCompiled(loaded, signal);
    const bundle = renderCompiledItemAsset(prepared.compiled, {
      textures: prepared.textureImages,
      viewSize: input.viewSize,
      includeContexts: input.includeContexts,
      signal,
    });
    const profile = bundle.reviewProfile;
    const evaluation = bundle.evaluation;
    if (profile === undefined || evaluation === undefined) {
      throw new Error('Visual renderer omitted its scene-profile report.');
    }
    const prefix = `r${prepared.record.revisionId.slice(0, 12)}`;
    const views: Record<string, VisualPngReference> = {};
    for (const view of bundle.views) {
      const label = `${prefix}-${view.id}`;
      const stored = await this.runs.putRender(input.runId, label, view.png, { signal });
      views[view.id] = {
        label,
        sha256: stored.sha256,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
      };
    }
    const contactLabel = `${prefix}-contact-sheet`;
    const contact = await this.runs.putRender(input.runId, contactLabel, bundle.contactSheet.png, {
      signal,
    });
    const contactReference: VisualPngReference = {
      label: contactLabel,
      sha256: contact.sha256,
      width: contact.width,
      height: contact.height,
      bytes: contact.bytes,
    };
    const pixelSha256 = sha256Buffer(bundle.contactSheet.image.data);
    const compiledArtifactId = prepared.record.compiledArtifactId;
    if (compiledArtifactId === undefined) {
      throw new Error('Rendered visual has no compiled artifact identity.');
    }
    const report: StoredRenderProfileReport = {
      schemaVersion: 1,
      kind: 'packwright.render-profile-report',
      projectId: input.projectId,
      runId: input.runId,
      revisionId: prepared.record.revisionId,
      specSha256: prepared.record.specSha256,
      compiledArtifactId,
      rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      viewSize: input.viewSize,
      planSha256: profile.planSha256,
      requiredViewIds: profile.requiredViewIds,
      reviewReady: evaluation.reviewReady,
      views: profile.scenes.map((scene) => {
        const rendered = views[scene.id];
        if (rendered === undefined) throw new Error(`Render view '${scene.id}' was not stored.`);
        return {
          id: scene.id,
          required: scene.required,
          width: rendered.width,
          height: rendered.height,
          sha256: rendered.sha256,
        };
      }),
      measurements: [...evaluation.measurements],
    };
    const storedReport = await this.runs.putReview(input.runId, report, signal);
    const nextState = await this.states.update(input.projectId, (current) => {
      const active = currentRevision(current, input.runId, prepared.record.revisionId);
      return replaceRevisionRecord(current, {
        ...active,
        render: {
          contactSheet: contactReference,
          views,
          pixelSha256,
          compiledArtifactId,
          review: {
            rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
            profileId: profile.profileId,
            profileVersion: profile.profileVersion,
            viewSize: input.viewSize,
            planSha256: profile.planSha256,
            reportSha256: storedReport.sha256,
            specSha256: prepared.record.specSha256,
            requiredViewIds: profile.requiredViewIds,
            reviewReady: evaluation.reviewReady,
          },
        },
      });
    });
    const record = currentRevision(nextState, input.runId, prepared.record.revisionId);
    const contactPath = `visual-runs/${input.runId}/renders/${contactLabel}-${contact.sha256}.png`;
    return {
      ok: prepared.validation.ok && evaluation.reviewReady,
      projectId: input.projectId,
      runId: input.runId,
      revisionId: record.revisionId,
      reviewProfile: profile.profileId,
      profileVersion: profile.profileVersion,
      reviewReady: evaluation.reviewReady,
      reportUri: visualRunRenderReportUri(input.runId, record.revisionId),
      contactSheet: asVisualFile(contactPath, bundle.contactSheet.png, 'image/png', 'render'),
      contactSheetUri: visualRunContactSheetUri(input.runId, record.revisionId),
      views: bundle.views.map((view) => {
        const scene = profile.scenes.find((candidate) => candidate.id === view.id);
        if (scene === undefined) throw new Error(`Render profile omitted view '${view.id}'.`);
        return {
          name: view.id,
          required: scene.required,
          category: scene.category,
          width: view.width,
          height: view.height,
          file: asVisualFile(
            `visual-runs/${input.runId}/renders/${views[view.id]?.label ?? view.id}-${view.sha256}.png`,
            view.png,
            'image/png',
            'render',
          ),
          uri: visualRunViewUri(input.runId, record.revisionId, view.id),
        };
      }),
      measurements: [...evaluation.measurements],
      pixelSha256,
      diagnostics: [
        ...prepared.validation.diagnostics,
        ...reviewMeasurementDiagnostics(loaded.spec.id, profile.profileId, evaluation.measurements),
      ].map(visualDiagnostic),
    };
  }

  async capture(
    input: VisualClientCaptureInput,
    signal?: AbortSignal,
  ): Promise<VisualClientCaptureResult> {
    return this.withProjectMutationLock(input.projectId, () => this.captureUnlocked(input, signal));
  }

  private async captureUnlocked(
    input: VisualClientCaptureInput,
    signal?: AbortSignal,
  ): Promise<VisualClientCaptureResult> {
    const loaded = await this.loadRevision(input.projectId, input.runId, input.revisionId);
    if (loaded.record.committedTransactionId !== undefined) {
      throw new PackwrightError(
        'precondition_failed',
        'A committed immutable revision cannot be recaptured; create a child revision first.',
      );
    }
    const prepared = await this.ensureCompiled(loaded, signal);
    const profile = resolveReviewProfile(loaded.spec, 128);
    const captureSupport = clientCaptureReviewSupport(profile.profileId);
    const base = {
      authority: 'authoritative_environment_capture' as const,
      projectId: input.projectId,
      runId: input.runId,
      revisionId: prepared.record.revisionId,
      reviewProfile: profile.profileId,
      profileVersion: profile.profileVersion,
      clientCaptureSupport: captureSupport,
    };
    if (captureSupport === 'unsupported') {
      return {
        ...base,
        ok: false,
        status: 'failed',
        captureReady: false,
        views: [],
        diagnostics: [
          {
            engine: 'minecraft-client',
            authority: 'authoritative',
            severity: 'error',
            code: 'minecraft.client_capture.profile_unsupported',
            message: `Review profile '${profile.profileId}' has no truthful official-client capture implementation for the current custom-item compiler.`,
          },
        ],
      };
    }
    if (prepared.record.proposalArtifactId !== input.proposalSha256) {
      throw new PackwrightError(
        'precondition_failed',
        'The selected proposal is not current for this visual revision.',
      );
    }
    const overlay = await this.readProposalOverlay(
      input.projectId,
      input.runId,
      prepared.record.revisionId,
    );
    if (overlay.proposalSha256 !== input.proposalSha256) {
      throw new PackwrightError(
        'precondition_failed',
        'The proposal changed during capture setup.',
      );
    }
    const proposalArtifact = await this.runs.readCompiled(input.runId, input.proposalSha256);
    const proposalBytes = proposalArtifact.contents['proposal.json'];
    if (proposalBytes === undefined) {
      throw new PackwrightError('invalid_content', 'Visual proposal artifact has no manifest.');
    }
    const proposal = proposalValue(JSON.parse(proposalBytes.toString('utf8')));
    if (
      proposal.projectId !== input.projectId ||
      proposal.runId !== input.runId ||
      proposal.revisionId !== prepared.record.revisionId ||
      proposal.compiledArtifactId !== prepared.record.compiledArtifactId ||
      proposal.manifestSha256 !== loaded.project.manifestSha256
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'The client-capture proposal does not match the selected immutable revision.',
      );
    }

    const capturePreflight = await preflightMinecraftClientCapture(this.config, signal);
    if (!capturePreflight.ready || capturePreflight.prepared === undefined) {
      return {
        ...base,
        ok: false,
        status: 'setup_required',
        captureReady: false,
        views: [],
        diagnostics: capturePreflight.messages.map((message) => ({
          engine: 'minecraft-client',
          authority: 'authoritative' as const,
          severity: 'error' as const,
          code: 'minecraft.client_capture.setup_required',
          message,
        })),
      };
    }

    const [datapackSource, resourcepackSource] = await Promise.all([
      readConfinedPackSnapshot(this.workspace, loaded.project.manifest.datapack, signal),
      readConfinedPackSnapshot(this.workspace, loaded.project.manifest.resourcepack, signal),
    ]);
    const datapack = applyPackSnapshotOverlay(
      datapackSource,
      overlay.files
        .filter((file) => file.pack === 'datapack')
        .map((file) => ({ path: file.path, data: file.data })),
    );
    const resourcepack = applyPackSnapshotOverlay(
      resourcepackSource,
      overlay.files
        .filter((file) => file.pack === 'resourcepack')
        .map((file) => ({ path: file.path, data: file.data })),
    );
    const [datapackArchive, resourcepackArchive] = await Promise.all([
      createDeterministicZipArchive(datapack.entries),
      createDeterministicZipArchive(resourcepack.entries),
    ]);
    const compiledArtifactId = prepared.record.compiledArtifactId;
    const captureRuntime = capturePreflight.prepared;
    let executed: Awaited<ReturnType<typeof executeMinecraftClientCapture>>;
    try {
      executed = await executeMinecraftClientCapture({
        config: this.config,
        prepared: captureRuntime,
        datapack,
        resourcepack,
        timeoutMs: input.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
        createPlan: (execution) =>
          createVisualClientCapturePlan({
            spec: loaded.spec,
            width: input.resolution.width,
            height: input.resolution.height,
            guiScale: input.guiScale,
            execution,
            provenance: {
              projectId: input.projectId,
              runId: input.runId,
              revisionId: prepared.record.revisionId,
              specSha256: prepared.record.specSha256,
              compiledArtifactId,
              proposalArtifactId: input.proposalSha256,
              projectManifestSha256: loaded.project.manifestSha256,
              datapackContentSha256: datapackArchive.sha256,
              resourcepackContentSha256: resourcepackArchive.sha256,
              runtimeManifestSha256: captureRuntime.runtime.sha256,
              itemStack: {
                itemId: proposal.binding.itemStack.id,
                count: proposal.binding.itemStack.count,
                command: proposal.binding.giveCommand,
                components: clientCaptureComponentLiterals(proposal.binding),
              },
              client: captureRuntime.client,
              captureMod: {
                id: captureRuntime.captureMod.id,
                version: captureRuntime.captureMod.version,
                sha256: captureRuntime.captureMod.sha256,
              },
            },
          }),
      });
    } catch (error) {
      const status =
        error instanceof PackwrightError && error.code === 'cancelled'
          ? 'cancelled'
          : error instanceof PackwrightError && error.details?.status === 'timeout'
            ? 'timeout'
            : 'failed';
      return {
        ...base,
        ok: false,
        status,
        captureReady: false,
        views: [],
        diagnostics: [
          {
            engine: 'minecraft-client',
            authority: 'authoritative',
            severity: 'error',
            code: `minecraft.client_capture.${status}`,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }

    const prefix = `c${prepared.record.revisionId.slice(0, 6)}`;
    const views: Record<string, VisualPngReference> = {};
    const renderedViews: RenderedView[] = [];
    const storedViews: StoredClientCaptureEvidence['views'][number][] = [];
    for (const view of executed.evidence.views) {
      const raw = executed.artifacts[view.path];
      if (raw === undefined) throw new Error(`Verified client view is unavailable: ${view.path}`);
      const label = `${prefix}-${view.sceneId}`.slice(0, 64).replace(/-$/u, '0');
      const [source, stored] = await Promise.all([
        this.runs.putCaptureBlob(input.runId, label, 'png', raw, signal),
        this.runs.putCapture(input.runId, label, raw, { signal }),
      ]);
      if (source.sha256 !== view.pngSha256 || stored.sourceSha256 !== view.pngSha256) {
        throw new Error(`Stored client framebuffer hash changed: ${view.sceneId}`);
      }
      const reference: VisualPngReference = {
        label,
        sha256: stored.sha256,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        source: 'captured',
        sourceSha256: source.sha256,
        strippedMetadata: stored.strippedMetadata,
      };
      views[view.sceneId] = reference;
      const image = decodePng(raw);
      renderedViews.push({
        id: view.sceneId,
        width: image.width,
        height: image.height,
        image,
        png: raw,
        sha256: view.pngSha256,
      });
      storedViews.push({
        id: view.sceneId,
        label,
        sourceSha256: source.sha256,
        normalizedSha256: stored.sha256,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
      });
    }
    const contactSheet = createContactSheet(renderedViews);
    const contactLabel = `${prefix}-contact`;
    const storedContact = await this.runs.putCapture(input.runId, contactLabel, contactSheet.png, {
      signal,
    });
    const contactReference: VisualPngReference = {
      label: contactLabel,
      sha256: storedContact.sha256,
      width: storedContact.width,
      height: storedContact.height,
      bytes: storedContact.bytes,
      source: 'generated',
      sourceSha256: storedContact.sourceSha256,
      strippedMetadata: storedContact.strippedMetadata,
    };
    const logBytes = executed.artifacts[executed.evidence.log.path];
    if (logBytes === undefined) throw new Error('Verified Minecraft client log is unavailable.');
    const logLabel = `${prefix}-minecraft-log`;
    const storedLog = await this.runs.putCaptureBlob(
      input.runId,
      logLabel,
      'log',
      logBytes,
      signal,
    );
    if (storedLog.sha256 !== executed.evidence.log.sha256) {
      throw new Error('Stored Minecraft client log hash changed.');
    }
    const sourceReportBytes = executed.artifacts[executed.evidence.reportArtifact.path];
    const completionBytes = executed.artifacts[executed.evidence.completion.path];
    if (sourceReportBytes === undefined || completionBytes === undefined) {
      throw new Error('Verified Minecraft capture protocol artifacts are unavailable.');
    }
    const [storedSourceReport, storedCompletion] = await Promise.all([
      this.runs.putCaptureBlob(input.runId, `${prefix}-report`, 'json', sourceReportBytes, signal),
      this.runs.putCaptureBlob(input.runId, `${prefix}-complete`, 'json', completionBytes, signal),
    ]);
    if (
      storedSourceReport.sha256 !== executed.evidence.reportArtifact.sha256 ||
      storedCompletion.sha256 !== executed.evidence.completion.sha256
    ) {
      throw new Error('Stored Minecraft capture protocol hash changed.');
    }
    const storedEvidenceValue: StoredClientCaptureEvidence = {
      schemaVersion: 1,
      kind: 'packwright.minecraft-client-capture-evidence',
      authority: 'authoritative_environment_capture',
      plan: executed.plan,
      report: executed.evidence.report,
      sourceReportSha256: executed.evidence.reportArtifact.sha256,
      completionSha256: executed.evidence.completion.sha256,
      sourceReport: {
        label: storedSourceReport.label,
        sha256: storedSourceReport.sha256,
        bytes: storedSourceReport.bytes,
      },
      completion: {
        label: storedCompletion.label,
        sha256: storedCompletion.sha256,
        bytes: storedCompletion.bytes,
      },
      log: { label: logLabel, sha256: storedLog.sha256, bytes: storedLog.bytes },
      views: storedViews,
      contactSheet: {
        label: contactLabel,
        sha256: storedContact.sha256,
        width: storedContact.width,
        height: storedContact.height,
        bytes: storedContact.bytes,
      },
    };
    const storedEvidence = await this.runs.putReview(input.runId, storedEvidenceValue, signal);
    const nextState = await this.states.update(input.projectId, (current) => {
      const active = currentRevision(current, input.runId, prepared.record.revisionId);
      if (
        active.specSha256 !== prepared.record.specSha256 ||
        active.compiledArtifactId !== compiledArtifactId ||
        active.proposalArtifactId !== input.proposalSha256
      ) {
        throw new PackwrightError(
          'precondition_failed',
          'Visual inputs changed while Minecraft was capturing the proposal.',
        );
      }
      return replaceRevisionRecord(current, {
        ...active,
        clientCapture: {
          authority: 'authoritative_environment_capture',
          rendererVersion: 'minecraft-client-26.2',
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
          planSha256: executed.plan.planSha256,
          reportSha256: storedEvidence.sha256,
          sourceReportSha256: executed.evidence.reportArtifact.sha256,
          specSha256: prepared.record.specSha256,
          compiledArtifactId,
          proposalArtifactId: input.proposalSha256,
          manifestSha256: loaded.project.manifestSha256,
          datapackContentSha256: datapackArchive.sha256,
          resourcepackContentSha256: resourcepackArchive.sha256,
          runtimeManifestSha256: captureRuntime.runtime.sha256,
          clientJarSha1: captureRuntime.client.jarSha1,
          clientJarSha256: captureRuntime.client.jarSha256,
          captureModSha256: captureRuntime.captureMod.sha256,
          log: { label: logLabel, sha256: storedLog.sha256, bytes: storedLog.bytes },
          contactSheet: contactReference,
          views,
          requiredViewIds: executed.plan.scenes.map((scene) => scene.id),
        },
      });
    });
    const record = currentRevision(nextState, input.runId, prepared.record.revisionId);
    await this.verifyClientCaptureEvidence(
      { project: loaded.project, state: nextState, record, spec: loaded.spec },
      record,
      signal,
    );
    const contactPath = `visual-runs/${input.runId}/captures/${contactLabel}-${storedContact.sha256}.png`;
    return {
      ...base,
      ok: true,
      status: 'passed',
      captureReady: true,
      planSha256: executed.plan.planSha256,
      reportSha256: storedEvidence.sha256,
      reportUri: visualRunClientCaptureReportUri(input.runId, record.revisionId),
      contactSheet: asVisualFile(contactPath, contactSheet.png, 'image/png', 'render'),
      contactSheetUri: visualRunClientCaptureContactSheetUri(input.runId, record.revisionId),
      views: executed.evidence.views.map((view) => {
        const reference = views[view.sceneId];
        const raw = executed.artifacts[view.path];
        if (reference === undefined || raw === undefined) {
          throw new Error(`Stored capture view is unavailable: ${view.sceneId}`);
        }
        return {
          name: view.sceneId,
          width: view.width,
          height: view.height,
          sourceSha256: view.pngSha256,
          normalizedSha256: reference.sha256,
          bytes: reference.bytes,
          uri: visualRunClientCaptureViewUri(input.runId, record.revisionId, view.sceneId),
        };
      }),
      environment: executed.evidence.report.runtime,
      diagnostics: [],
    };
  }

  async revise(input: VisualRevisionCreateInput, signal?: AbortSignal): Promise<VisualDraftResult> {
    return this.withProjectMutationLock(input.projectId, () => this.reviseUnlocked(input, signal));
  }

  private async reviseUnlocked(
    input: VisualRevisionCreateInput,
    signal?: AbortSignal,
  ): Promise<VisualDraftResult> {
    const loaded = await this.loadRevision(input.projectId, input.runId, input.parentRevisionId);
    if (loaded.record.specSha256 !== input.expectedSpecSha256) {
      throw new PackwrightError(
        'precondition_failed',
        'The visual specification changed since review.',
      );
    }
    const draft = structuredClone(loaded.spec) as {
      parts: {
        id: string;
        from: readonly [number, number, number];
        to: readonly [number, number, number];
        rotation?: unknown;
        material: string;
      }[];
      materials: Record<string, unknown>;
      display: Record<string, unknown>;
      heldItem?: Record<string, unknown> | undefined;
      blockReview?: unknown;
      placeableReview?: unknown;
      armorReview?: unknown;
      headWearableReview?: unknown;
      projectileReview?: unknown;
      guiItemReview?: unknown;
      entityModelReview?: unknown;
    };
    for (const repair of input.repairs) {
      if (repair.kind === 'part') {
        const part = draft.parts.find((candidate) => candidate.id === repair.partId);
        if (part === undefined) {
          throw new PackwrightError('not_found', `Model part '${repair.partId}' does not exist.`);
        }
        if (repair.from !== undefined) part.from = repair.from;
        if (repair.to !== undefined) part.to = repair.to;
        if (repair.material !== undefined) part.material = repair.material;
        if (repair.rotation === null) delete part.rotation;
        else if (repair.rotation !== undefined) part.rotation = repair.rotation;
      } else if (repair.kind === 'material') {
        draft.materials[repair.material] = repair.value;
      } else if (repair.kind === 'display') {
        draft.display[repair.context] = repair.transform;
      } else if (repair.kind === 'held_item') {
        const heldItem = draft.heldItem ?? {
          primaryGrip: [8, 5.5, 11],
          handedness: 'either',
          twoHanded: false,
          itemKind: 'generic',
          usePose: 'none',
        };
        if (repair.primaryGrip !== undefined) heldItem.primaryGrip = repair.primaryGrip;
        if (repair.secondaryGrip === null) delete heldItem.secondaryGrip;
        else if (repair.secondaryGrip !== undefined) heldItem.secondaryGrip = repair.secondaryGrip;
        if (repair.muzzle === null) delete heldItem.muzzle;
        else if (repair.muzzle !== undefined) heldItem.muzzle = repair.muzzle;
        if (repair.forwardAxis === null) delete heldItem.forwardAxis;
        else if (repair.forwardAxis !== undefined) heldItem.forwardAxis = repair.forwardAxis;
        if (repair.handedness !== undefined) heldItem.handedness = repair.handedness;
        if (repair.twoHanded !== undefined) heldItem.twoHanded = repair.twoHanded;
        if (repair.itemKind !== undefined) heldItem.itemKind = repair.itemKind;
        if (repair.usePose !== undefined) heldItem.usePose = repair.usePose;
        draft.heldItem = heldItem;
      } else if (repair.kind === 'block_review') {
        draft.blockReview = repair.value;
      } else if (repair.kind === 'placeable_review') {
        draft.placeableReview = repair.value;
      } else if (repair.kind === 'armor_review') {
        draft.armorReview = repair.value;
      } else if (repair.kind === 'head_wearable_review') {
        draft.headWearableReview = repair.value;
      } else if (repair.kind === 'projectile_review') {
        draft.projectileReview = repair.value;
      } else if (repair.kind === 'gui_item_review') {
        draft.guiItemReview = repair.value;
      } else {
        draft.entityModelReview = repair.value;
      }
    }
    const spec = parseModelSpec(draft);
    const repairedMaterials = new Set(
      input.repairs.filter((repair) => repair.kind === 'material').map((repair) => repair.material),
    );
    const inheritedTextures = Object.fromEntries(
      Object.entries(loaded.record.textures).filter(
        ([material, reference]) =>
          !repairedMaterials.has(material) || reference.source !== 'generated',
      ),
    );
    const parent = await this.runs.readRevision(input.runId, input.parentRevisionId);
    const provenance = {
      ...(parent.provenance as Record<string, unknown>),
      action: 'visual_revision_create',
      instructions: input.instructions,
      repairs: input.repairs,
    };
    const revision = await this.runs.createRevision(input.runId, {
      modelSpec: spec,
      provenance,
      parentRevisionId: input.parentRevisionId,
      signal,
    });
    const review = await this.runs.putReview(
      input.runId,
      {
        schemaVersion: 1,
        projectId: input.projectId,
        runId: input.runId,
        parentRevisionId: input.parentRevisionId,
        revisionId: revision.revisionId,
        instructions: input.instructions,
        repairs: input.repairs,
      },
      signal,
    );
    const record: VisualRevisionState = {
      runId: input.runId,
      revisionId: revision.revisionId,
      specSha256: revision.modelSpecSha256,
      textures: inheritedTextures,
      reviewSha256: review.sha256,
    };
    await this.states.update(input.projectId, (current) => {
      if (
        current.latest?.runId !== loaded.record.runId ||
        current.latest.revisionId !== loaded.record.revisionId
      ) {
        throw new PackwrightError(
          'precondition_failed',
          'The repair parent is no longer the latest visual revision.',
        );
      }
      return recordWithRevision(current, record, {
        advanceLatest: true,
        replaceTextures: true,
      });
    });
    return {
      ok: true,
      operation: 'visual_revision_create',
      projectId: input.projectId,
      runId: input.runId,
      revisionId: revision.revisionId,
      parentRevisionId: input.parentRevisionId,
      specSha256: revision.modelSpecSha256,
      files: [
        asVisualFile(
          `visual-runs/${input.runId}/revisions/${revision.revisionId}/model-spec.json`,
          canonicalJsonBytes(spec),
          'application/json',
          'model_spec',
        ),
      ],
      diagnostics: [],
    };
  }

  async commit(
    projectId: string,
    runId: string,
    revisionId: string | undefined,
    proposalSha256: string,
    expectedClientCaptureReportSha256?: string,
    signal?: AbortSignal,
  ): Promise<VisualCommitResult> {
    return this.withProjectMutationLock(projectId, () =>
      this.commitUnlocked(
        projectId,
        runId,
        revisionId,
        proposalSha256,
        expectedClientCaptureReportSha256,
        signal,
      ),
    );
  }

  private async commitUnlocked(
    projectId: string,
    runId: string,
    revisionId: string | undefined,
    proposalSha256: string,
    expectedClientCaptureReportSha256?: string,
    signal?: AbortSignal,
  ): Promise<VisualCommitResult> {
    const loaded = await this.loadRevision(projectId, runId, revisionId);
    abortIfNeeded(signal);
    if (!loaded.project.ready) {
      throw new PackwrightError(
        'validation_failed',
        'Both paired packs must be present and compatible before committing a visual asset.',
      );
    }
    if (loaded.record.proposalArtifactId !== proposalSha256) {
      throw new PackwrightError(
        'precondition_failed',
        'The accepted proposal is not the current proposal for this revision.',
      );
    }
    const captureSupport = clientCaptureReviewSupport(loaded.spec.reviewProfile);
    let acceptedClientCapture: VisualRevisionState['clientCapture'];
    if (this.requireAuthoritativeClientCapture && captureSupport !== 'unsupported') {
      if (expectedClientCaptureReportSha256 === undefined) {
        throw new PackwrightError(
          'precondition_required',
          'The exact Minecraft client-capture report SHA-256 is required before committing this supported review profile.',
        );
      }
      if (loaded.record.clientCapture?.reportSha256 !== expectedClientCaptureReportSha256) {
        throw new PackwrightError(
          'precondition_failed',
          'The accepted Minecraft client-capture report is missing or is not current for this revision.',
          {
            expectedClientCaptureReportSha256,
            actualClientCaptureReportSha256: loaded.record.clientCapture?.reportSha256,
          },
        );
      }
      try {
        await this.verifyClientCaptureEvidence(loaded, loaded.record, signal);
      } catch (error) {
        throw new PackwrightError(
          'precondition_failed',
          `The accepted Minecraft client-capture evidence failed verification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      acceptedClientCapture = loaded.record.clientCapture;
    } else if (expectedClientCaptureReportSha256 !== undefined) {
      if (loaded.record.clientCapture?.reportSha256 !== expectedClientCaptureReportSha256) {
        throw new PackwrightError(
          'precondition_failed',
          'The supplied Minecraft client-capture report is not current for this revision.',
        );
      }
      await this.verifyClientCaptureEvidence(loaded, loaded.record, signal);
      acceptedClientCapture = loaded.record.clientCapture;
    } else if (loaded.record.clientCapture !== undefined) {
      // Advisory/test-harness callers may omit the explicit acceptance hash,
      // but an existing verified capture must still be bound into the receipt.
      await this.verifyClientCaptureEvidence(loaded, loaded.record, signal);
      acceptedClientCapture = loaded.record.clientCapture;
    }
    const artifact = await this.runs.readCompiled(runId, proposalSha256);
    const proposalBytes = artifact.contents['proposal.json'];
    if (proposalBytes === undefined) {
      throw new PackwrightError('invalid_content', 'Visual proposal artifact has no manifest.');
    }
    const proposal = proposalValue(JSON.parse(proposalBytes.toString('utf8')));
    if (
      proposal.projectId !== projectId ||
      proposal.runId !== runId ||
      proposal.revisionId !== loaded.record.revisionId ||
      proposal.manifestSha256 !== loaded.project.manifestSha256 ||
      proposal.datapack !== loaded.project.manifest.datapack ||
      proposal.resourcepack !== loaded.project.manifest.resourcepack
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Visual proposal identity or paired-pack manifest changed after review.',
      );
    }
    const receipt = createVisualCommitReceipt(
      this.states.workspaceId,
      loaded.project,
      proposalSha256,
      proposal,
      acceptedClientCapture,
    );
    const receiptBytes = canonicalJsonBytes(receipt);
    const receiptSha256 = sha256Buffer(receiptBytes);
    if (
      loaded.record.committedTransactionId === receipt.transactionId &&
      loaded.record.committedReceiptSha256 === receiptSha256
    ) {
      await this.persistCommitReceipt(
        projectId,
        runId,
        loaded.record.revisionId,
        proposalSha256,
        receipt.transactionId,
        receiptSha256,
      );
      return visualCommitResult(loaded.project, proposal, receipt);
    }
    const prepared = await this.ensureCompiled(loaded, signal);
    const compiled = prepared.compiled;
    if (
      prepared.record.compiledArtifactId !== proposal.compiledArtifactId ||
      prepared.record.proposalArtifactId !== proposalSha256
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Compiled visual inputs changed after the proposal was reviewed.',
      );
    }
    const expectedBinding = createItemBindingProposal(
      loaded.spec,
      compiled,
      proposal.binding.carrierItem,
    );
    if (!canonicalJsonBytes(expectedBinding).equals(canonicalJsonBytes(proposal.binding))) {
      throw new PackwrightError('invalid_content', 'Visual binding proposal failed verification.');
    }
    const availableTextureResourceIds = new Set<string>();
    for (const requirement of compiled.textures) {
      if (requirement.external) continue;
      const reference = prepared.record.textures[requirement.materialId];
      if (reference === undefined) {
        throw new PackwrightError(
          'validation_failed',
          `Required texture '${requirement.materialId}' is unavailable.`,
        );
      }
      const texture = await this.runs.readPng(runId, 'texture', reference.label, reference.sha256);
      if (texture.width !== requirement.width || texture.height !== requirement.height) {
        throw new PackwrightError(
          'validation_failed',
          `Texture '${requirement.materialId}' no longer matches its required dimensions.`,
        );
      }
      availableTextureResourceIds.add(requirement.resourceId);
    }
    const graph = createItemAssetGraph(compiled, expectedBinding, projectId);
    const validation = validateVisualAsset(loaded.spec, compiled, graph, {
      availableTextureResourceIds,
      availableModelResourceIds: new Set(compiled.externalModelReferences),
    });
    if (!validation.ok) {
      throw new PackwrightError(
        'validation_failed',
        'The visual asset failed revalidation and cannot be committed.',
        { diagnostics: validation.diagnostics },
      );
    }
    if (prepared.record.render === undefined) {
      throw new PackwrightError(
        'precondition_required',
        'Render and visually review the selected revision before committing it.',
      );
    }
    if (prepared.record.render.compiledArtifactId !== proposal.compiledArtifactId) {
      throw new PackwrightError(
        'precondition_failed',
        'The accepted proposal was not rendered from the same compiled artifact.',
      );
    }
    let profileReport: StoredRenderProfileReport;
    try {
      profileReport = await this.verifyRenderProfileEvidence(
        { ...loaded, record: prepared.record },
        prepared.record,
        signal,
      );
    } catch (error) {
      throw new PackwrightError(
        'precondition_failed',
        `The accepted render-profile report is stale or failed verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!profileReport.reviewReady) {
      throw new PackwrightError(
        'validation_failed',
        'The selected review profile must pass before committing.',
      );
    }
    const expectedContents = createProposedContents(
      loaded.spec,
      prepared.resourceFiles,
      expectedBinding,
      proposal.connection,
    );
    if (expectedContents.length !== proposal.files.length) {
      throw new PackwrightError(
        'invalid_content',
        'Visual proposal file set does not match the canonical compiler output.',
      );
    }
    const writes = proposal.files.map((file, index) => {
      const expected = expectedContents[index];
      const key = `${file.pack}/${file.path}`;
      const content = artifact.contents[key];
      if (expected === undefined) {
        throw new PackwrightError(
          'invalid_content',
          'Visual proposal contains more files than the canonical compiler output.',
        );
      }
      const expectedBytes =
        typeof expected.content === 'string'
          ? Buffer.from(expected.content, 'utf8')
          : expected.content;
      if (
        expected.pack !== file.pack ||
        expected.path !== file.path ||
        expected.role !== file.role ||
        expected.mediaType !== file.mediaType ||
        expectedBytes.length !== file.size ||
        sha256Buffer(expectedBytes) !== file.sha256 ||
        !content?.equals(expectedBytes)
      ) {
        throw new PackwrightError(
          'invalid_content',
          `Proposal content failed verification: ${key}`,
        );
      }
      return {
        path: packDestination(loaded.project.manifest, file.pack, file.path),
        content,
        expectedSha256: file.expectedSha256,
      };
    });
    const acceptingState = await this.states.read(projectId);
    if (
      currentRevision(acceptingState, runId, loaded.record.revisionId).proposalArtifactId !==
      proposalSha256
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'A newer binding proposal replaced the accepted proposal before commit.',
      );
    }
    await commitFileTransaction(
      this.workspace,
      [
        ...writes,
        {
          path: visualCommitReceiptPath(proposalSha256),
          content: receiptBytes,
          expectedSha256: null,
        },
      ],
      signal,
    );
    const installedReceipt = await verifyVisualCommitReceipt(this.workspace, receipt);
    if (installedReceipt === undefined) {
      throw new PackwrightError(
        'transaction_recovery_required',
        'The visual commit completed without its durable receipt.',
        { proposalSha256 },
      );
    }
    await this.persistCommitReceipt(
      projectId,
      runId,
      loaded.record.revisionId,
      proposalSha256,
      receipt.transactionId,
      installedReceipt.sha256,
    );
    return visualCommitResult(loaded.project, proposal, receipt);
  }

  private async verifyRevisionArtifacts(
    loaded: LoadedRevision,
    compiled: CompiledItemAsset,
  ): Promise<VerifiedVisualArtifacts> {
    const diagnostics: VisualDiagnostic[] = [];
    const availableTextureResourceIds = new Set<string>();
    const availableModelResourceIds = new Set<string>();
    let textures = true;
    for (const requirement of compiled.textures) {
      if (requirement.external) {
        try {
          const content = await this.readExternalResource(
            loaded,
            requirement.path,
            8 * 1024 * 1024,
          );
          const image = decodePng(content);
          if (image.width !== requirement.width || image.height !== requirement.height) {
            throw new Error(
              `expected ${String(requirement.width)}x${String(requirement.height)}, received ${String(image.width)}x${String(image.height)}`,
            );
          }
          availableTextureResourceIds.add(requirement.resourceId);
        } catch (error) {
          textures = false;
          diagnostics.push(
            artifactDiagnostic(
              'visual.texture.external_missing',
              `External texture '${requirement.resourceId}' failed verification: ${error instanceof Error ? error.message : String(error)}`,
              loaded.spec.id,
            ),
          );
        }
        continue;
      }
      const reference = loaded.record.textures[requirement.materialId];
      if (reference === undefined) {
        textures = false;
        diagnostics.push(
          artifactDiagnostic(
            'visual.texture.missing',
            `Texture artifact for material '${requirement.materialId}' is missing.`,
            loaded.spec.id,
          ),
        );
        continue;
      }
      try {
        const artifact = await this.runs.readPng(
          loaded.record.runId,
          'texture',
          reference.label,
          reference.sha256,
        );
        if (
          artifact.width !== requirement.width ||
          artifact.height !== requirement.height ||
          artifact.bytes !== reference.bytes
        ) {
          throw new Error('Texture dimensions or size no longer match the indexed artifact.');
        }
        availableTextureResourceIds.add(requirement.resourceId);
      } catch (error) {
        textures = false;
        diagnostics.push(
          artifactDiagnostic(
            'visual.texture.unreadable',
            `Texture artifact for material '${requirement.materialId}' failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
    }

    for (const resourceId of compiled.externalModelReferences) {
      const { namespace, path: modelPath } = parseResourceId(resourceId);
      const filename = `assets/${namespace}/models/${modelPath}.json`;
      try {
        const content = await this.readExternalResource(loaded, filename, 4 * 1024 * 1024);
        JSON.parse(content.toString('utf8'));
        availableModelResourceIds.add(resourceId);
      } catch (error) {
        diagnostics.push(
          artifactDiagnostic(
            'visual.model.external_missing',
            `External item-state model '${resourceId}' failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
    }

    let compiledReady = false;
    if (loaded.record.compiledArtifactId !== undefined) {
      try {
        await this.runs.readCompiled(loaded.record.runId, loaded.record.compiledArtifactId);
        compiledReady = true;
      } catch (error) {
        diagnostics.push(
          artifactDiagnostic(
            'visual.compiled.unreadable',
            `Compiled draft artifact failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
    }

    let rendered = false;
    let reviewProfileReady = false;
    if (loaded.record.render !== undefined) {
      try {
        if (loaded.record.render.compiledArtifactId !== loaded.record.compiledArtifactId) {
          throw new Error('Render was produced from a different compiled artifact.');
        }
        const contact = await this.runs.readPng(
          loaded.record.runId,
          'render',
          loaded.record.render.contactSheet.label,
          loaded.record.render.contactSheet.sha256,
        );
        if (sha256Buffer(decodePng(contact.data).data) !== loaded.record.render.pixelSha256) {
          throw new Error('Contact-sheet pixel hash does not match.');
        }
        for (const reference of Object.values(loaded.record.render.views)) {
          await this.runs.readPng(loaded.record.runId, 'render', reference.label, reference.sha256);
        }
        rendered = true;
      } catch (error) {
        diagnostics.push(
          artifactDiagnostic(
            'visual.render.unreadable',
            `Render artifact failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
      if (rendered) {
        try {
          const report = await this.verifyRenderProfileEvidence(loaded);
          diagnostics.push(
            ...reviewMeasurementDiagnostics(loaded.spec.id, report.profileId, report.measurements),
          );
          reviewProfileReady = report.reviewReady;
        } catch (error) {
          diagnostics.push(
            artifactDiagnostic(
              'visual.review_profile.unreadable',
              `Render-profile evidence failed verification: ${error instanceof Error ? error.message : String(error)}`,
              loaded.spec.id,
            ),
          );
        }
      }
    }

    let binding: ItemBindingProposal | undefined;
    let proposal: CommitProposal | undefined;
    let bindingReady = false;
    if (loaded.record.proposalArtifactId !== undefined) {
      try {
        const artifact = await this.runs.readCompiled(
          loaded.record.runId,
          loaded.record.proposalArtifactId,
        );
        const bytes = artifact.contents['proposal.json'];
        if (bytes === undefined) throw new Error('Proposal manifest is missing.');
        proposal = proposalValue(JSON.parse(bytes.toString('utf8')));
        if (
          proposal.projectId !== loaded.project.manifest.id ||
          proposal.runId !== loaded.record.runId ||
          proposal.revisionId !== loaded.record.revisionId ||
          proposal.manifestSha256 !== loaded.project.manifestSha256 ||
          proposal.datapack !== loaded.project.manifest.datapack ||
          proposal.resourcepack !== loaded.project.manifest.resourcepack ||
          proposal.compiledArtifactId !== loaded.record.compiledArtifactId
        ) {
          throw new Error('Proposal is not bound to the current paired-pack manifest.');
        }
        const expected = createItemBindingProposal(
          loaded.spec,
          compiled,
          proposal.binding.carrierItem,
        );
        if (!canonicalJsonBytes(expected).equals(canonicalJsonBytes(proposal.binding))) {
          throw new Error('Binding content does not match the selected specification.');
        }
        binding = expected;
        bindingReady = true;
      } catch (error) {
        proposal = undefined;
        diagnostics.push(
          artifactDiagnostic(
            'visual.binding.unreadable',
            `Binding proposal failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
    }

    let clientCaptured = false;
    if (loaded.record.clientCapture !== undefined) {
      try {
        await this.verifyClientCaptureEvidence(loaded);
        clientCaptured = true;
      } catch (error) {
        diagnostics.push(
          artifactDiagnostic(
            'visual.client_capture.unreadable',
            `Minecraft client-capture evidence failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
    }

    let committed = false;
    if (
      bindingReady &&
      proposal !== undefined &&
      loaded.record.committedTransactionId !== undefined
    ) {
      try {
        for (const file of proposal.files) {
          const destination = packDestination(loaded.project.manifest, file.pack, file.path);
          if ((await destinationSha256(this.workspace, destination)) !== file.sha256) {
            throw new Error(`Committed file changed or is missing: ${destination}`);
          }
        }
        committed = true;
      } catch (error) {
        diagnostics.push(
          artifactDiagnostic(
            'visual.commit.stale',
            `Committed output failed verification: ${error instanceof Error ? error.message : String(error)}`,
            loaded.spec.id,
          ),
        );
      }
    }

    if (!loaded.project.ready) {
      diagnostics.push(
        artifactDiagnostic(
          'visual.project.not_ready',
          'The paired datapack and resource pack are not both present and compatible.',
          loaded.spec.id,
        ),
      );
    }
    return {
      readiness: {
        spec: true,
        textures,
        compiled: compiledReady,
        rendered,
        reviewProfile: rendered && reviewProfileReady,
        binding: bindingReady,
        committed,
        clientCaptured,
      },
      diagnostics,
      availableTextureResourceIds,
      availableModelResourceIds,
      ...(binding === undefined ? {} : { binding }),
      ...(proposal === undefined ? {} : { proposal }),
    };
  }

  async inspect(projectId: string, assetId?: string): Promise<VisualAssetInspectResult> {
    const project = await inspectVisualProject(this.workspace, projectId);
    const state = await this.states.read(projectId);
    const latest = state.latest;
    if (latest === undefined) {
      const diagnostics = project.ready
        ? []
        : [
            visualDiagnostic(
              artifactDiagnostic(
                'visual.project.not_ready',
                'The paired datapack and resource pack are not both present and compatible.',
              ),
            ),
          ];
      return {
        ok: project.ready,
        project: project.manifest,
        nodes: [],
        edges: [],
        readiness: {
          spec: false,
          textures: false,
          compiled: false,
          rendered: false,
          reviewProfile: false,
          binding: false,
          committed: false,
          clientCaptured: false,
        },
        diagnostics,
        truncated: false,
      };
    }
    const loaded = await this.loadRevision(projectId, latest.runId, latest.revisionId);
    const compiled = compileItemAsset(loaded.spec);
    const verified = await this.verifyRevisionArtifacts(loaded, compiled);
    const binding = verified.binding ?? createItemBindingProposal(loaded.spec, compiled);
    const graph = createItemAssetGraph(compiled, binding, projectId);
    const matchedIds = new Set(
      assetId === undefined
        ? graph.nodes.map((node) => node.id)
        : graph.nodes
            .filter((node) => node.id === assetId || node.resourceId === assetId)
            .map((node) => node.id),
    );
    if (assetId !== undefined) {
      for (const edge of graph.edges) {
        if (matchedIds.has(edge.from)) matchedIds.add(edge.to);
        if (matchedIds.has(edge.to)) matchedIds.add(edge.from);
      }
    }
    const includedNodes = graph.nodes.filter((node) => matchedIds.has(node.id));
    const edges = graph.edges.filter(
      (edge) => matchedIds.has(edge.from) && matchedIds.has(edge.to),
    );
    const validation = validateVisualAsset(loaded.spec, compiled, graph, {
      availableTextureResourceIds: verified.availableTextureResourceIds,
      availableModelResourceIds: verified.availableModelResourceIds,
    });
    const diagnostics = [...validation.diagnostics, ...verified.diagnostics];
    return {
      ok: project.ready && !diagnostics.some((entry) => entry.severity === 'error'),
      project: project.manifest,
      nodes: includedNodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        ...(node.path === undefined ? {} : { path: node.path }),
      })),
      edges: edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.kind })),
      latestRunId: latest.runId,
      readiness: verified.readiness,
      diagnostics: diagnostics.map(visualDiagnostic),
      truncated: false,
    };
  }

  async validateDraft(
    projectId: string,
    runId?: string,
    revisionId?: string,
  ): Promise<{
    readonly project: VisualProjectInspection;
    readonly runId?: string;
    readonly revisionId?: string;
    readonly result?: VisualValidationResult;
    readonly readiness?: VisualArtifactReadiness;
    readonly clientCaptureSupport?: ReturnType<typeof clientCaptureReviewSupport>;
  }> {
    const project = await inspectVisualProject(this.workspace, projectId);
    let selectedRunId = runId;
    let selectedRevisionId = revisionId;
    if (selectedRunId === undefined) {
      const state = await this.states.read(projectId);
      selectedRunId = state.latest?.runId;
      selectedRevisionId = state.latest?.revisionId;
    }
    if (selectedRunId === undefined) return { project };
    const loaded = await this.loadRevision(projectId, selectedRunId, selectedRevisionId);
    const compiled = compileItemAsset(loaded.spec);
    const verified = await this.verifyRevisionArtifacts(loaded, compiled);
    const binding = verified.binding ?? createItemBindingProposal(loaded.spec, compiled);
    const graph = createItemAssetGraph(compiled, binding, projectId);
    const validation = validateVisualAsset(loaded.spec, compiled, graph, {
      availableTextureResourceIds: verified.availableTextureResourceIds,
      availableModelResourceIds: verified.availableModelResourceIds,
    });
    const diagnostics = [...validation.diagnostics, ...verified.diagnostics];
    return {
      project,
      runId: selectedRunId,
      revisionId: loaded.record.revisionId,
      readiness: verified.readiness,
      clientCaptureSupport: clientCaptureReviewSupport(loaded.spec.reviewProfile),
      result: {
        ...validation,
        ok: project.ready && !diagnostics.some((entry) => entry.severity === 'error'),
        diagnostics,
      },
    };
  }

  async readProposalOverlay(
    projectId: string,
    runId: string,
    revisionId: string,
  ): Promise<VisualProposalOverlay> {
    const loaded = await this.loadRevision(projectId, runId, revisionId);
    const proposalSha256 = loaded.record.proposalArtifactId;
    if (proposalSha256 === undefined) {
      throw new PackwrightError(
        'precondition_required',
        'Connect the selected visual revision before validating its proposal overlay.',
      );
    }
    const artifact = await this.runs.readCompiled(runId, proposalSha256);
    const manifestBytes = artifact.contents['proposal.json'];
    if (manifestBytes === undefined) {
      throw new PackwrightError('invalid_content', 'Visual proposal artifact has no manifest.');
    }
    const proposal = proposalValue(JSON.parse(manifestBytes.toString('utf8')));
    if (
      proposal.projectId !== projectId ||
      proposal.runId !== runId ||
      proposal.revisionId !== revisionId ||
      proposal.manifestSha256 !== loaded.project.manifestSha256 ||
      proposal.datapack !== loaded.project.manifest.datapack ||
      proposal.resourcepack !== loaded.project.manifest.resourcepack ||
      proposal.compiledArtifactId !== loaded.record.compiledArtifactId
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Visual proposal does not match the selected revision and paired-pack manifest.',
      );
    }
    const files = await Promise.all(
      proposal.files.map(async (file) => {
        const key = `${file.pack}/${file.path}`;
        const data = artifact.contents[key];
        if (data?.length !== file.size || sha256Buffer(data) !== file.sha256) {
          throw new PackwrightError(
            'invalid_content',
            `Proposal content failed verification: ${key}`,
          );
        }
        const destination = packDestination(loaded.project.manifest, file.pack, file.path);
        const actual = await destinationSha256(this.workspace, destination);
        if (actual !== file.expectedSha256 && actual !== file.sha256) {
          throw new PackwrightError(
            'precondition_failed',
            `Proposal destination changed after connection: ${destination}`,
            { expectedSha256: file.expectedSha256, actualSha256: actual },
          );
        }
        return { pack: file.pack, path: file.path, data, sha256: file.sha256 };
      }),
    );
    return {
      project: loaded.project,
      runId,
      revisionId,
      proposalSha256,
      files,
    };
  }

  async assertCurrentSelection(
    projectId: string,
    runId: string,
    revisionId: string,
    manifestSha256: string,
  ): Promise<void> {
    const [project, state] = await Promise.all([
      inspectVisualProject(this.workspace, projectId),
      this.states.read(projectId),
    ]);
    if (
      project.manifestSha256 !== manifestSha256 ||
      state.latest?.runId !== runId ||
      state.latest.revisionId !== revisionId
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'The paired project or latest visual revision changed during the operation.',
      );
    }
  }

  async readResource(
    input:
      | { readonly kind: 'project_manifest' | 'project_graph'; readonly projectId: string }
      | {
          readonly kind:
            | 'spec'
            | 'contact_sheet'
            | 'render_report'
            | 'review'
            | 'binding'
            | 'client_capture_report'
            | 'client_contact_sheet';
          readonly runId: string;
          readonly revisionId: string;
        }
      | {
          readonly kind: 'view' | 'client_view';
          readonly runId: string;
          readonly revisionId: string;
          readonly view: string;
        },
  ): Promise<{ readonly mimeType: 'application/json' | 'image/png'; readonly data: Buffer }> {
    if ('projectId' in input) {
      if (input.kind === 'project_manifest') {
        return {
          mimeType: 'application/json',
          data: canonicalJsonBytes(
            (await inspectVisualProject(this.workspace, input.projectId)).manifest,
          ),
        };
      }
      return {
        mimeType: 'application/json',
        data: canonicalJsonBytes(await this.inspect(input.projectId)),
      };
    }
    const states = await this.findStateForRevision(input.runId, input.revisionId);
    const loaded = await this.loadRevision(states.projectId, input.runId, input.revisionId);
    if (input.kind === 'spec') {
      const revision = await this.runs.readRevision(input.runId, input.revisionId);
      return { mimeType: 'application/json', data: canonicalJsonBytes(revision.modelSpec) };
    }
    if (
      input.kind === 'client_capture_report' ||
      input.kind === 'client_contact_sheet' ||
      input.kind === 'client_view'
    ) {
      let evidence: StoredClientCaptureEvidence;
      try {
        evidence = await this.verifyClientCaptureEvidence(loaded, states.record);
      } catch (error) {
        throw new PackwrightError(
          'precondition_failed',
          `Minecraft client-capture evidence failed verification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (input.kind === 'client_capture_report') {
        return { mimeType: 'application/json', data: canonicalJsonBytes(evidence) };
      }
      const reference =
        input.kind === 'client_contact_sheet'
          ? states.record.clientCapture?.contactSheet
          : states.record.clientCapture?.views['view' in input ? input.view : ''];
      if (reference === undefined) {
        throw new PackwrightError(
          'not_found',
          'Requested Minecraft client framebuffer capture is not available.',
        );
      }
      const png = await this.runs.readPng(
        input.runId,
        'capture',
        reference.label,
        reference.sha256,
      );
      if (input.kind === 'client_view') {
        const image = decodePng(png.data);
        const preview = createBoundedClientPreview({
          id: input.view,
          width: image.width,
          height: image.height,
          image,
          png: png.data,
          sha256: reference.sha256,
        });
        return { mimeType: 'image/png', data: preview.png };
      }
      return { mimeType: 'image/png', data: png.data };
    }
    if (input.kind === 'contact_sheet' || input.kind === 'view') {
      const render = loaded.record.render;
      const reference =
        input.kind === 'contact_sheet'
          ? render?.contactSheet
          : render?.views['view' in input ? input.view : ''];
      if (reference === undefined || render === undefined) {
        throw new PackwrightError('not_found', 'Requested visual render is not available.');
      }
      if (render.compiledArtifactId !== loaded.record.compiledArtifactId) {
        throw new PackwrightError(
          'precondition_failed',
          'Requested render is not bound to the current compiled visual artifact.',
        );
      }
      const png = await this.runs.readPng(input.runId, 'render', reference.label, reference.sha256);
      if (
        input.kind === 'contact_sheet' &&
        sha256Buffer(decodePng(png.data).data) !== render.pixelSha256
      ) {
        throw new PackwrightError(
          'invalid_content',
          'Contact-sheet pixel hash failed verification.',
        );
      }
      return { mimeType: 'image/png', data: png.data };
    }
    if (input.kind === 'render_report') {
      if (states.record.render?.review === undefined) {
        throw new PackwrightError(
          'not_found',
          'No render-profile report is recorded for this revision.',
        );
      }
      try {
        const report = await this.verifyRenderProfileEvidence(loaded, states.record);
        return { mimeType: 'application/json', data: canonicalJsonBytes(report) };
      } catch (error) {
        throw new PackwrightError(
          'precondition_failed',
          `Render-profile report failed verification: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (input.kind === 'review') {
      if (states.record.reviewSha256 === undefined) {
        throw new PackwrightError('not_found', 'No visual review is recorded for this revision.');
      }
      const review = await this.runs.readReview(input.runId, states.record.reviewSha256);
      if (
        review.value === null ||
        typeof review.value !== 'object' ||
        Array.isArray(review.value) ||
        (review.value as Record<string, unknown>).projectId !== states.projectId ||
        (review.value as Record<string, unknown>).runId !== input.runId ||
        (review.value as Record<string, unknown>).revisionId !== input.revisionId
      ) {
        throw new PackwrightError('invalid_content', 'Visual review identity failed verification.');
      }
      return { mimeType: 'application/json', data: canonicalJsonBytes(review.value) };
    }
    if (states.record.proposalArtifactId === undefined) {
      throw new PackwrightError('not_found', 'No binding proposal is recorded for this revision.');
    }
    const artifact = await this.runs.readCompiled(input.runId, states.record.proposalArtifactId);
    const proposalBytes = artifact.contents['proposal.json'];
    if (proposalBytes === undefined) {
      throw new PackwrightError('invalid_content', 'Binding proposal manifest is missing.');
    }
    const proposal = proposalValue(JSON.parse(proposalBytes.toString('utf8')));
    if (
      proposal.projectId !== states.projectId ||
      proposal.runId !== input.runId ||
      proposal.revisionId !== input.revisionId ||
      proposal.manifestSha256 !== loaded.project.manifestSha256 ||
      proposal.compiledArtifactId !== loaded.record.compiledArtifactId
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Binding proposal identity failed verification.',
      );
    }
    const compiled = compileItemAsset(loaded.spec);
    const expected = createItemBindingProposal(loaded.spec, compiled, proposal.binding.carrierItem);
    if (!canonicalJsonBytes(expected).equals(canonicalJsonBytes(proposal.binding))) {
      throw new PackwrightError('invalid_content', 'Binding proposal content failed verification.');
    }
    return { mimeType: 'application/json', data: canonicalJsonBytes(expected) };
  }

  private async findStateForRevision(
    runId: string,
    revisionId: string,
  ): Promise<{ readonly projectId: string; readonly record: VisualRevisionState }> {
    const run = await this.runs.readRun(runId);
    if (run.request === null || typeof run.request !== 'object' || Array.isArray(run.request)) {
      throw new PackwrightError('invalid_content', 'Visual run request is malformed.');
    }
    const projectId = (run.request as Record<string, unknown>).projectId;
    if (typeof projectId !== 'string' || !isVisualProjectId(projectId)) {
      throw new PackwrightError('invalid_content', 'Visual run has no valid project identity.');
    }
    const state = await this.states.read(projectId);
    const record = state.revisions[revisionId];
    if (record?.runId !== runId) {
      throw new PackwrightError('not_found', 'Visual revision is not indexed for this project.');
    }
    return { projectId, record };
  }
}
