import type { VisualClientCaptureResult } from './mcp/visual-schemas.js';

type VisualClientCaptureSummaryValue = Pick<
  VisualClientCaptureResult,
  | 'status'
  | 'views'
  | 'targetKind'
  | 'representationStrategy'
  | 'representationCapability'
  | 'representationDisclosure'
  | 'proposalBindingStatus'
  | 'proposalBindingReason'
  | 'representationSha256'
  | 'requiredViewIds'
  | 'supplementalViewIds'
  | 'measurements'
  | 'reportSha256'
  | 'reportUri'
  | 'contactSheetUri'
  | 'supplementalContactSheetUri'
>;

function prominentValue(value: string | undefined): string {
  return value?.toUpperCase() ?? 'UNAVAILABLE';
}

export function visualClientCaptureSummaryText(result: VisualClientCaptureSummaryValue): string[] {
  return [
    `${result.status.toUpperCase()}: ${String(result.views.length)} Minecraft framebuffer views`,
    `Target: ${result.targetKind ?? 'unavailable'}`,
    `Representation strategy: ${result.representationStrategy ?? 'unavailable'}`,
    `Representation capability: ${prominentValue(result.representationCapability)}`,
    `Representation disclosure: ${result.representationDisclosure ?? 'unavailable'}`,
    `Proposal binding status: ${prominentValue(result.proposalBindingStatus)}`,
    `Proposal binding reason: ${result.proposalBindingReason ?? 'unavailable'}`,
    ...(result.representationSha256 === undefined
      ? []
      : [`Representation SHA-256: ${result.representationSha256}`]),
    `Authoritative gameplay/world views: ${String(result.requiredViewIds.length)}`,
    `Supplemental QA views: ${String(result.supplementalViewIds.length)}`,
    `Client-pixel measurements: ${
      result.measurements
        .map((measurement) => `${measurement.metric}=${measurement.status}`)
        .join(', ') || 'none'
    }`,
    ...(result.reportSha256 === undefined
      ? []
      : [`Accepted report SHA-256: ${result.reportSha256}`]),
    ...(result.reportUri === undefined ? [] : [`Report: ${result.reportUri}`]),
    ...(result.contactSheetUri === undefined
      ? []
      : [`Authoritative vanilla contact sheet: ${result.contactSheetUri}`]),
    ...(result.supplementalContactSheetUri === undefined
      ? []
      : [`Optional supplemental QA sheet: ${result.supplementalContactSheetUri}`]),
  ];
}
