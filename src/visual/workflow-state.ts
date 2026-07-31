import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Buffer } from '../core/hash.js';
import { withPathLock } from '../core/locks.js';
import { isVisualProjectId } from './project.js';
import { canonicalJsonBytes } from './run-store.js';
import { isReviewProfileId, type ReviewProfileId } from './review-profile.js';

const CONTENT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const MATERIAL_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const VIEW_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export interface VisualPngReference {
  readonly label: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly source?: 'captured' | 'generated' | 'imported' | undefined;
  readonly sourceSha256?: string | undefined;
  readonly strippedMetadata?: boolean | undefined;
}

export interface VisualRenderReferences {
  readonly contactSheet: VisualPngReference;
  readonly views: Readonly<Record<string, VisualPngReference>>;
  readonly pixelSha256: string;
  readonly compiledArtifactId: string;
  readonly review?: VisualRenderReviewReference | undefined;
}

export interface VisualRenderReviewReference {
  readonly rendererVersion: string;
  readonly profileId: ReviewProfileId;
  readonly profileVersion: number;
  readonly viewSize: number;
  readonly planSha256: string;
  readonly reportSha256: string;
  readonly specSha256: string;
  readonly requiredViewIds: readonly string[];
  readonly reviewReady: boolean;
}

export interface VisualClientCaptureReferences {
  readonly protocolVersion: 2 | 3;
  readonly authority: 'authoritative_environment_capture';
  readonly authorityScope: 'required_views_only';
  readonly proposalBindingStatus?: 'implemented' | 'capture_only' | undefined;
  readonly rendererVersion: 'minecraft-client-26.2';
  readonly profileId: ReviewProfileId;
  readonly profileVersion: number;
  readonly targetKind?:
    'held_item' | 'gui_item' | 'block' | 'headwear' | 'entity' | 'placeable' | undefined;
  readonly representationSha256?: string | undefined;
  readonly studioSha256?: string | undefined;
  readonly planSha256: string;
  readonly reportSha256: string;
  readonly sourceReportSha256: string;
  readonly specSha256: string;
  readonly compiledArtifactId: string;
  readonly proposalArtifactId: string;
  readonly manifestSha256: string;
  readonly datapackContentSha256: string;
  readonly resourcepackContentSha256: string;
  readonly runtimeManifestSha256: string;
  readonly clientJarSha1: string;
  readonly clientJarSha256: string;
  readonly captureModSha256: string;
  readonly log: Readonly<{ label: string; sha256: string; bytes: number }>;
  readonly contactSheet: VisualPngReference;
  readonly supplementalContactSheet?: VisualPngReference | undefined;
  /** @deprecated Protocol-v2 compatibility field. */
  readonly scaleReferenceContactSheet?: VisualPngReference | undefined;
  readonly views: Readonly<Record<string, VisualPngReference>>;
  readonly requiredViewIds: readonly string[];
  readonly supplementalViewIds: readonly string[];
}

export interface VisualRevisionState {
  readonly runId: string;
  readonly revisionId: string;
  readonly specSha256: string;
  readonly textures: Readonly<Record<string, VisualPngReference>>;
  readonly compiledArtifactId?: string | undefined;
  readonly proposalArtifactId?: string | undefined;
  readonly render?: VisualRenderReferences | undefined;
  readonly clientCapture?: VisualClientCaptureReferences | undefined;
  readonly reviewSha256?: string | undefined;
  readonly committedTransactionId?: string | undefined;
  readonly committedReceiptSha256?: string | undefined;
}

function clientCaptureReference(value: unknown): VisualClientCaptureReferences {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Visual workflow client capture is invalid.');
  }
  const record = value as Record<string, unknown>;
  const protocolVersion = record.protocolVersion === undefined ? 2 : record.protocolVersion;
  if (
    (protocolVersion !== 2 && protocolVersion !== 3) ||
    record.authority !== 'authoritative_environment_capture' ||
    record.authorityScope !== 'required_views_only' ||
    record.rendererVersion !== 'minecraft-client-26.2' ||
    !isReviewProfileId(record.profileId) ||
    !Array.isArray(record.requiredViewIds) ||
    typeof record.clientJarSha1 !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(record.clientJarSha1)
  ) {
    throw new Error('Visual workflow client-capture identity is invalid.');
  }
  const targetKind = record.targetKind;
  const validTargetKind =
    targetKind === 'held_item' ||
    targetKind === 'gui_item' ||
    targetKind === 'block' ||
    targetKind === 'headwear' ||
    targetKind === 'entity' ||
    targetKind === 'placeable';
  const representationSha256 =
    record.representationSha256 === undefined
      ? undefined
      : contentId(record.representationSha256, 'client-capture representation hash');
  const studioSha256 =
    record.studioSha256 === undefined
      ? undefined
      : contentId(record.studioSha256, 'client-capture studio hash');
  const expectedTargetKind =
    record.profileId === 'held_item' || record.profileId === 'gui_item'
      ? record.profileId
      : record.profileId === 'block'
        ? 'block'
        : record.profileId === 'head_wearable'
          ? 'headwear'
          : record.profileId === 'entity_model'
            ? 'entity'
            : record.profileId === 'placeable'
              ? 'placeable'
              : undefined;
  const proposalBindingStatus = record.proposalBindingStatus;
  const expectedProposalBindingStatus =
    targetKind === 'held_item' || targetKind === 'gui_item' ? 'implemented' : 'capture_only';
  if (
    protocolVersion === 3 &&
    (!validTargetKind ||
      targetKind !== expectedTargetKind ||
      representationSha256 === undefined ||
      studioSha256 === undefined ||
      proposalBindingStatus !== expectedProposalBindingStatus ||
      record.scaleReferenceContactSheet !== undefined)
  ) {
    throw new Error('Visual workflow protocol-v3 representation identity is invalid.');
  }
  const viewsValue = record.views;
  if (viewsValue === null || typeof viewsValue !== 'object' || Array.isArray(viewsValue)) {
    throw new Error('Visual workflow client-capture views are invalid.');
  }
  const views: Record<string, VisualPngReference> = {};
  for (const [view, reference] of Object.entries(viewsValue)) {
    if (!VIEW_PATTERN.test(view))
      throw new Error('Visual workflow client-capture view is invalid.');
    views[view] = pngReference(reference);
    if (views[view].sourceSha256 === undefined) {
      throw new Error('Visual workflow client-capture view has no source framebuffer hash.');
    }
  }
  const requiredViewIds = record.requiredViewIds.map((view) => {
    if (typeof view !== 'string' || !VIEW_PATTERN.test(view) || views[view] === undefined) {
      throw new Error('Visual workflow required client-capture view is invalid or missing.');
    }
    return view;
  });
  if (new Set(requiredViewIds).size !== requiredViewIds.length) {
    throw new Error('Visual workflow required client-capture views are duplicated.');
  }
  const scaleReferenceValue =
    record.supplementalViewIds === undefined ? [] : record.supplementalViewIds;
  if (!Array.isArray(scaleReferenceValue)) {
    throw new Error('Visual workflow supplemental client-capture views are invalid.');
  }
  const supplementalViewIds = scaleReferenceValue.map((view) => {
    if (typeof view !== 'string' || !VIEW_PATTERN.test(view) || views[view] === undefined) {
      throw new Error('Visual workflow supplemental client-capture view is invalid or missing.');
    }
    return view;
  });
  if (
    new Set(supplementalViewIds).size !== supplementalViewIds.length ||
    supplementalViewIds.some((view) => requiredViewIds.includes(view))
  ) {
    throw new Error('Visual workflow supplemental client-capture views are duplicated.');
  }
  const classifiedViewIds = new Set([...requiredViewIds, ...supplementalViewIds]);
  if (
    classifiedViewIds.size !== Object.keys(views).length ||
    Object.keys(views).some((view) => !classifiedViewIds.has(view))
  ) {
    throw new Error('Visual workflow client-capture views are not completely classified.');
  }
  const supplementalContactSheetValue =
    protocolVersion === 3 ? record.supplementalContactSheet : record.scaleReferenceContactSheet;
  const supplementalContactSheet =
    supplementalContactSheetValue === undefined
      ? undefined
      : pngReference(supplementalContactSheetValue);
  if (supplementalViewIds.length > 0 !== (supplementalContactSheet !== undefined)) {
    throw new Error(
      'Visual workflow supplemental contact sheet does not match its supplemental views.',
    );
  }
  return {
    protocolVersion,
    authority: record.authority,
    authorityScope: record.authorityScope,
    rendererVersion: record.rendererVersion,
    profileId: record.profileId,
    profileVersion: positiveInteger(record.profileVersion, 'client-capture profile version'),
    ...(protocolVersion === 3
      ? {
          targetKind: targetKind as NonNullable<VisualClientCaptureReferences['targetKind']>,
          representationSha256,
          studioSha256,
          proposalBindingStatus: proposalBindingStatus as 'implemented' | 'capture_only',
        }
      : {}),
    planSha256: contentId(record.planSha256, 'client-capture plan hash'),
    reportSha256: contentId(record.reportSha256, 'client-capture report hash'),
    specSha256: contentId(record.specSha256, 'client-capture spec hash'),
    compiledArtifactId: contentId(record.compiledArtifactId, 'client-capture compiled artifact ID'),
    proposalArtifactId: contentId(record.proposalArtifactId, 'client-capture proposal artifact ID'),
    manifestSha256: contentId(record.manifestSha256, 'client-capture manifest hash'),
    datapackContentSha256: contentId(record.datapackContentSha256, 'client-capture datapack hash'),
    resourcepackContentSha256: contentId(
      record.resourcepackContentSha256,
      'client-capture resource-pack hash',
    ),
    runtimeManifestSha256: contentId(
      record.runtimeManifestSha256,
      'client-capture runtime-manifest hash',
    ),
    clientJarSha1: record.clientJarSha1,
    clientJarSha256: contentId(record.clientJarSha256, 'client-capture client JAR hash'),
    captureModSha256: contentId(record.captureModSha256, 'client-capture mod hash'),
    sourceReportSha256: contentId(record.sourceReportSha256, 'client-capture source report hash'),
    log: (() => {
      const value = record.log;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Visual workflow client-capture log reference is invalid.');
      }
      const log = value as Record<string, unknown>;
      if (typeof log.label !== 'string' || !VIEW_PATTERN.test(log.label)) {
        throw new Error('Visual workflow client-capture log label is invalid.');
      }
      return {
        label: log.label,
        sha256: contentId(log.sha256, 'client-capture log hash'),
        bytes: positiveInteger(log.bytes, 'client-capture log byte count'),
      };
    })(),
    contactSheet: pngReference(record.contactSheet),
    ...(supplementalContactSheet === undefined
      ? {}
      : protocolVersion === 3
        ? { supplementalContactSheet }
        : { scaleReferenceContactSheet: supplementalContactSheet }),
    views,
    requiredViewIds,
    supplementalViewIds,
  };
}

export interface VisualProjectWorkflowState {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly latest?: Readonly<{ runId: string; revisionId: string }> | undefined;
  readonly revisions: Readonly<Record<string, VisualRevisionState>>;
}

function contentId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !CONTENT_ID_PATTERN.test(value)) {
    throw new Error(`Visual workflow ${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Visual workflow ${label} is invalid.`);
  }
  return value as number;
}

function pngReference(value: unknown, expectedLabel?: string): VisualPngReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Visual workflow PNG reference is invalid.');
  }
  const record = value as Record<string, unknown>;
  const label = record.label;
  if (
    typeof label !== 'string' ||
    !VIEW_PATTERN.test(label) ||
    (expectedLabel !== undefined && label !== expectedLabel)
  ) {
    throw new Error('Visual workflow PNG label is invalid.');
  }
  const source = record.source;
  if (
    source !== undefined &&
    source !== 'captured' &&
    source !== 'generated' &&
    source !== 'imported'
  ) {
    throw new Error('Visual workflow PNG source is invalid.');
  }
  const sourceSha256 =
    record.sourceSha256 === undefined
      ? undefined
      : contentId(record.sourceSha256, 'PNG source hash');
  const strippedMetadata = record.strippedMetadata;
  if (strippedMetadata !== undefined && typeof strippedMetadata !== 'boolean') {
    throw new Error('Visual workflow PNG metadata flag is invalid.');
  }
  return {
    label,
    sha256: contentId(record.sha256, 'PNG hash'),
    width: positiveInteger(record.width, 'PNG width'),
    height: positiveInteger(record.height, 'PNG height'),
    bytes: positiveInteger(record.bytes, 'PNG byte count'),
    ...(source === undefined ? {} : { source }),
    ...(sourceSha256 === undefined ? {} : { sourceSha256 }),
    ...(strippedMetadata === undefined ? {} : { strippedMetadata }),
  };
}

function revisionState(value: unknown, revisionId: string): VisualRevisionState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Visual workflow revision is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (contentId(record.revisionId, 'revision ID') !== revisionId) {
    throw new Error('Visual workflow revision key does not match its record.');
  }
  const texturesValue = record.textures;
  if (texturesValue === null || typeof texturesValue !== 'object' || Array.isArray(texturesValue)) {
    throw new Error('Visual workflow texture map is invalid.');
  }
  const textures: Record<string, VisualPngReference> = {};
  for (const [material, reference] of Object.entries(texturesValue)) {
    if (!MATERIAL_PATTERN.test(material))
      throw new Error('Visual workflow material ID is invalid.');
    textures[material] = pngReference(reference, 'texture');
  }

  let render: VisualRenderReferences | undefined;
  const renderValue = record.render;
  if (renderValue !== undefined) {
    if (renderValue === null || typeof renderValue !== 'object' || Array.isArray(renderValue)) {
      throw new Error('Visual workflow render map is invalid.');
    }
    const renderRecord = renderValue as Record<string, unknown>;
    const viewsValue = renderRecord.views;
    if (viewsValue === null || typeof viewsValue !== 'object' || Array.isArray(viewsValue)) {
      throw new Error('Visual workflow render views are invalid.');
    }
    const views: Record<string, VisualPngReference> = {};
    for (const [view, reference] of Object.entries(viewsValue)) {
      if (!VIEW_PATTERN.test(view)) throw new Error('Visual workflow view ID is invalid.');
      views[view] = pngReference(reference);
    }
    let review: VisualRenderReviewReference | undefined;
    const reviewValue = renderRecord.review;
    if (reviewValue !== undefined) {
      if (reviewValue === null || typeof reviewValue !== 'object' || Array.isArray(reviewValue)) {
        throw new Error('Visual workflow render review identity is invalid.');
      }
      const reviewRecord = reviewValue as Record<string, unknown>;
      if (
        reviewRecord.rendererVersion !== 'packwright-cpu-v2' ||
        !isReviewProfileId(reviewRecord.profileId) ||
        typeof reviewRecord.reviewReady !== 'boolean' ||
        !Array.isArray(reviewRecord.requiredViewIds)
      ) {
        throw new Error('Visual workflow render review identity is invalid.');
      }
      const requiredViewIds = reviewRecord.requiredViewIds.map((view) => {
        if (typeof view !== 'string' || !VIEW_PATTERN.test(view) || views[view] === undefined) {
          throw new Error('Visual workflow required review view is invalid or missing.');
        }
        return view;
      });
      if (new Set(requiredViewIds).size !== requiredViewIds.length) {
        throw new Error('Visual workflow required review views are duplicated.');
      }
      const viewSize = positiveInteger(reviewRecord.viewSize, 'review view size');
      if (viewSize < 32 || viewSize > 256) {
        throw new Error('Visual workflow review view size is invalid.');
      }
      review = {
        rendererVersion: reviewRecord.rendererVersion,
        profileId: reviewRecord.profileId,
        profileVersion: positiveInteger(reviewRecord.profileVersion, 'review profile version'),
        viewSize,
        planSha256: contentId(reviewRecord.planSha256, 'review plan hash'),
        reportSha256: contentId(reviewRecord.reportSha256, 'review report hash'),
        specSha256: contentId(reviewRecord.specSha256, 'review spec hash'),
        requiredViewIds,
        reviewReady: reviewRecord.reviewReady,
      };
    }
    render = {
      contactSheet: pngReference(renderRecord.contactSheet),
      views,
      pixelSha256: contentId(renderRecord.pixelSha256, 'pixel hash'),
      compiledArtifactId: contentId(renderRecord.compiledArtifactId, 'render compiled artifact ID'),
      ...(review === undefined ? {} : { review }),
    };
  }
  const clientCapture =
    record.clientCapture === undefined ? undefined : clientCaptureReference(record.clientCapture);

  const optionalId = (field: string): string | undefined => {
    const candidate = record[field];
    return candidate === undefined ? undefined : contentId(candidate, field);
  };
  const transaction = record.committedTransactionId;
  if (transaction !== undefined && (typeof transaction !== 'string' || transaction.length === 0)) {
    throw new Error('Visual workflow transaction ID is invalid.');
  }
  const committedReceiptSha256 = optionalId('committedReceiptSha256');
  if (transaction === undefined && committedReceiptSha256 !== undefined) {
    throw new Error('Visual workflow commit receipt is incomplete.');
  }
  return {
    runId: contentId(record.runId, 'run ID'),
    revisionId,
    specSha256: contentId(record.specSha256, 'spec hash'),
    textures,
    ...(optionalId('compiledArtifactId') === undefined
      ? {}
      : { compiledArtifactId: optionalId('compiledArtifactId') }),
    ...(optionalId('proposalArtifactId') === undefined
      ? {}
      : { proposalArtifactId: optionalId('proposalArtifactId') }),
    ...(render === undefined ? {} : { render }),
    ...(clientCapture === undefined ? {} : { clientCapture }),
    ...(optionalId('reviewSha256') === undefined
      ? {}
      : { reviewSha256: optionalId('reviewSha256') }),
    ...(transaction === undefined ? {} : { committedTransactionId: transaction }),
    ...(committedReceiptSha256 === undefined ? {} : { committedReceiptSha256 }),
  };
}

function parseState(
  value: unknown,
  projectId: string,
  workspaceId: string,
): VisualProjectWorkflowState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Visual workflow state must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.workspaceId !== workspaceId ||
    record.projectId !== projectId
  ) {
    throw new Error('Visual workflow state identity is invalid.');
  }
  const revisionsValue = record.revisions;
  if (
    revisionsValue === null ||
    typeof revisionsValue !== 'object' ||
    Array.isArray(revisionsValue)
  ) {
    throw new Error('Visual workflow revision index is invalid.');
  }
  const revisions: Record<string, VisualRevisionState> = {};
  for (const [revisionId, revision] of Object.entries(revisionsValue)) {
    contentId(revisionId, 'revision index key');
    revisions[revisionId] = revisionState(revision, revisionId);
  }
  let latest: { runId: string; revisionId: string } | undefined;
  const latestValue = record.latest;
  if (latestValue !== undefined) {
    if (latestValue === null || typeof latestValue !== 'object' || Array.isArray(latestValue)) {
      throw new Error('Visual workflow latest pointer is invalid.');
    }
    const pointer = latestValue as Record<string, unknown>;
    latest = {
      runId: contentId(pointer.runId, 'latest run ID'),
      revisionId: contentId(pointer.revisionId, 'latest revision ID'),
    };
    const target = revisions[latest.revisionId];
    if (target?.runId !== latest.runId) {
      throw new Error('Visual workflow latest pointer does not resolve.');
    }
  }
  return {
    schemaVersion: 1,
    workspaceId,
    projectId,
    ...(latest === undefined ? {} : { latest }),
    revisions,
  };
}

export function visualWorkspaceIdentity(canonicalWorkspaceRoot: string): string {
  if (!path.isAbsolute(canonicalWorkspaceRoot)) {
    throw new Error('Visual workflow workspace root must be absolute.');
  }
  return sha256Buffer(`packwright-workspace-v1\0${path.resolve(canonicalWorkspaceRoot)}`);
}

async function optionalRegularFile(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Visual workflow state is not a regular file.');
    }
    if (info.size > MAX_STATE_BYTES) throw new Error('Visual workflow state is too large.');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function optionalRealDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Visual workflow state root is not a real directory.');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export class VisualWorkflowStateStore {
  readonly cacheRoot: string;
  readonly stateRoot: string;
  readonly root: string;
  readonly workspaceId: string;

  constructor(cacheRoot: string, canonicalWorkspaceRoot: string) {
    if (!path.isAbsolute(cacheRoot))
      throw new Error('Visual workflow cache root must be absolute.');
    this.cacheRoot = path.resolve(cacheRoot);
    this.workspaceId = visualWorkspaceIdentity(canonicalWorkspaceRoot);
    this.stateRoot = path.join(this.cacheRoot, 'visual-project-state');
    this.root = path.join(this.stateRoot, this.workspaceId);
  }

  private async ensureSafeRoot(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
    } else if (!(await optionalRealDirectory(this.cacheRoot))) {
      return false;
    }
    await optionalRealDirectory(this.cacheRoot);

    if (create) {
      await mkdir(this.stateRoot, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    } else if (!(await optionalRealDirectory(this.stateRoot))) {
      return false;
    }
    await optionalRealDirectory(this.stateRoot);

    if (create) {
      await mkdir(this.root, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    } else if (!(await optionalRealDirectory(this.root))) {
      return false;
    }
    await optionalRealDirectory(this.root);
    return true;
  }

  private statePath(projectId: string): string {
    if (!isVisualProjectId(projectId)) throw new Error('Visual project ID is invalid.');
    return path.join(this.root, `${projectId}.json`);
  }

  async read(projectId: string): Promise<VisualProjectWorkflowState> {
    const filename = this.statePath(projectId);
    if (!(await this.ensureSafeRoot(false))) {
      return { schemaVersion: 1, workspaceId: this.workspaceId, projectId, revisions: {} };
    }
    if (!(await optionalRegularFile(filename))) {
      return { schemaVersion: 1, workspaceId: this.workspaceId, projectId, revisions: {} };
    }
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_STATE_BYTES) {
        throw new Error('Visual workflow state is invalid.');
      }
      const bytes = await handle.readFile();
      return parseState(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        projectId,
        this.workspaceId,
      );
    } finally {
      await handle.close();
    }
  }

  async update(
    projectId: string,
    mutate: (state: VisualProjectWorkflowState) => VisualProjectWorkflowState,
  ): Promise<VisualProjectWorkflowState> {
    const filename = this.statePath(projectId);
    return withPathLock(filename, async () => {
      await this.ensureSafeRoot(true);
      const current = await this.read(projectId);
      const next = parseState(mutate(current), projectId, this.workspaceId);
      const bytes = canonicalJsonBytes(next);
      if (bytes.length > MAX_STATE_BYTES) throw new Error('Visual workflow state is too large.');
      await this.ensureSafeRoot(true);
      const temporary = path.join(this.root, `.${projectId}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, filename);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return next;
    });
  }
}
