import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Buffer } from '../core/hash.js';
import { withPathLock } from '../core/locks.js';
import { isVisualProjectId } from './project.js';
import { canonicalJsonBytes } from './run-store.js';

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
  readonly source?: 'generated' | 'imported' | undefined;
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
  readonly profileId: 'held_item';
  readonly profileVersion: number;
  readonly viewSize: number;
  readonly planSha256: string;
  readonly reportSha256: string;
  readonly specSha256: string;
  readonly requiredViewIds: readonly string[];
  readonly reviewReady: boolean;
}

export interface VisualRevisionState {
  readonly runId: string;
  readonly revisionId: string;
  readonly specSha256: string;
  readonly textures: Readonly<Record<string, VisualPngReference>>;
  readonly compiledArtifactId?: string | undefined;
  readonly proposalArtifactId?: string | undefined;
  readonly render?: VisualRenderReferences | undefined;
  readonly reviewSha256?: string | undefined;
  readonly committedTransactionId?: string | undefined;
  readonly committedReceiptSha256?: string | undefined;
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
  if (source !== undefined && source !== 'generated' && source !== 'imported') {
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
        reviewRecord.profileId !== 'held_item' ||
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
