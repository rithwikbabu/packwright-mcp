import { PackwrightError } from '../core/errors.js';
import { VisualDraftIdSchema, VisualProjectIdSchema } from './visual-schemas.js';

export const VISUAL_CAPABILITIES_URI = 'packwright://visual/capabilities/26.2';
export const VISUAL_PROJECT_MANIFEST_URI_TEMPLATE =
  'packwright://visual/projects/{projectId}/manifest';
export const VISUAL_PROJECT_GRAPH_URI_TEMPLATE = 'packwright://visual/projects/{projectId}/graph';
export const VISUAL_RUN_SPEC_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/spec';
export const VISUAL_RUN_CONTACT_SHEET_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/contact-sheet';
export const VISUAL_RUN_RENDER_REPORT_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/render-report';
export const VISUAL_RUN_VIEW_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/views/{view}';
export const VISUAL_RUN_CLIENT_CAPTURE_REPORT_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/client-capture/report';
export const VISUAL_RUN_CLIENT_CAPTURE_CONTACT_SHEET_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/client-capture/contact-sheet';
export const VISUAL_RUN_CLIENT_CAPTURE_SUPPLEMENTAL_SHEET_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/client-capture/supplemental-sheet';
/** @deprecated Protocol-v2 compatibility alias. Protocol v3 uses the generic supplemental sheet. */
export const VISUAL_RUN_CLIENT_CAPTURE_SCALE_REFERENCE_SHEET_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/client-capture/scale-reference-sheet';
export const VISUAL_RUN_CLIENT_CAPTURE_VIEW_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/client-capture/views/{view}';
export const VISUAL_RUN_REVIEW_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/review';
export const VISUAL_RUN_BINDING_URI_TEMPLATE =
  'packwright://visual/runs/{runId}/revisions/{revisionId}/binding';

const VIEW_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

function validatedProjectId(projectId: string): string {
  const parsed = VisualProjectIdSchema.safeParse(projectId);
  if (!parsed.success) {
    throw new PackwrightError('invalid_argument', `Invalid visual project ID: ${projectId}`);
  }
  return parsed.data;
}

function validatedDraftId(value: string, label: string): string {
  const parsed = VisualDraftIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new PackwrightError('invalid_argument', `Invalid ${label}: ${value}`);
  }
  return parsed.data;
}

function validatedView(view: string): string {
  if (view.length === 0 || view.length > 128 || !VIEW_PATTERN.test(view)) {
    throw new PackwrightError('invalid_argument', `Invalid visual render view: ${view}`);
  }
  return view;
}

export function visualProjectManifestUri(projectId: string): string {
  return `packwright://visual/projects/${validatedProjectId(projectId)}/manifest`;
}

export function visualProjectGraphUri(projectId: string): string {
  return `packwright://visual/projects/${validatedProjectId(projectId)}/graph`;
}

export function visualRunSpecUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/spec`;
}

export function visualRunContactSheetUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/contact-sheet`;
}

export function visualRunRenderReportUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/render-report`;
}

export function visualRunViewUri(runId: string, revisionId: string, view: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/views/${validatedView(view)}`;
}

export function visualRunClientCaptureReportUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/client-capture/report`;
}

export function visualRunClientCaptureContactSheetUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/client-capture/contact-sheet`;
}

export function visualRunClientCaptureSupplementalSheetUri(
  runId: string,
  revisionId: string,
): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/client-capture/supplemental-sheet`;
}

/** @deprecated Protocol-v2 compatibility alias. Protocol v3 uses the generic supplemental sheet. */
export function visualRunClientCaptureScaleReferenceSheetUri(
  runId: string,
  revisionId: string,
): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/client-capture/scale-reference-sheet`;
}

export function visualRunClientCaptureViewUri(
  runId: string,
  revisionId: string,
  view: string,
): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/client-capture/views/${validatedView(view)}`;
}

export function visualRunReviewUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/review`;
}

export function visualRunBindingUri(runId: string, revisionId: string): string {
  return `packwright://visual/runs/${validatedDraftId(runId, 'run ID')}/revisions/${validatedDraftId(revisionId, 'revision ID')}/binding`;
}

export function parseVisualView(value: string): string {
  return validatedView(value);
}
