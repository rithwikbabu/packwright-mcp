import { describe, expect, it } from 'vitest';

import { visualClientCaptureSummaryText } from '../src/cli-output.js';

const SHA256 = 'a'.repeat(64);

function captureSummary(
  overrides: Partial<Parameters<typeof visualClientCaptureSummaryText>[0]> = {},
): Parameters<typeof visualClientCaptureSummaryText>[0] {
  return {
    status: 'passed',
    views: [{}] as Parameters<typeof visualClientCaptureSummaryText>[0]['views'],
    targetKind: 'placeable',
    representationStrategy: 'display_rig',
    representationCapability: 'simulated',
    representationDisclosure:
      'This is a simulated display-entity rig, not a new native Minecraft placeable.',
    proposalBindingStatus: 'capture_only',
    proposalBindingReason:
      'This evidence reviews the declared representation; the current proposal does not implement it.',
    representationSha256: SHA256,
    requiredViewIds: ['place_north_eye'],
    supplementalViewIds: [],
    measurements: [],
    reportSha256: SHA256,
    reportUri: 'packwright://visual-runs/report',
    contactSheetUri: 'packwright://visual-runs/contact-sheet',
    ...overrides,
  };
}

describe('official-client capture CLI summary', () => {
  it('puts simulated and capture-only truth before evidence details', () => {
    const lines = visualClientCaptureSummaryText(captureSummary());

    expect(lines.slice(0, 7)).toEqual([
      'PASSED: 1 Minecraft framebuffer views',
      'Target: placeable',
      'Representation strategy: display_rig',
      'Representation capability: SIMULATED',
      'Representation disclosure: This is a simulated display-entity rig, not a new native Minecraft placeable.',
      'Proposal binding status: CAPTURE_ONLY',
      'Proposal binding reason: This evidence reviews the declared representation; the current proposal does not implement it.',
    ]);
    expect(lines.indexOf('Representation capability: SIMULATED')).toBeLessThan(
      lines.indexOf(`Representation SHA-256: ${SHA256}`),
    );
  });

  it('labels a replacement representation without implying native identity', () => {
    const lines = visualClientCaptureSummaryText(
      captureSummary({
        targetKind: 'block',
        representationStrategy: 'native_block_state',
        representationCapability: 'replacement',
        representationDisclosure:
          'This replaces the appearance of an existing vanilla block state; it is not a new block identity.',
      }),
    );

    expect(lines).toContain('Representation strategy: native_block_state');
    expect(lines).toContain('Representation capability: REPLACEMENT');
    expect(lines).toContain(
      'Representation disclosure: This replaces the appearance of an existing vanilla block state; it is not a new block identity.',
    );
    expect(lines).toContain('Proposal binding status: CAPTURE_ONLY');
  });

  it('does not silently omit representation truth from an early failure', () => {
    const lines = visualClientCaptureSummaryText(
      captureSummary({
        status: 'setup_required',
        views: [],
        targetKind: undefined,
        representationStrategy: undefined,
        representationCapability: undefined,
        representationDisclosure: undefined,
        proposalBindingStatus: undefined,
        proposalBindingReason: undefined,
        representationSha256: undefined,
        reportSha256: undefined,
        reportUri: undefined,
        contactSheetUri: undefined,
      }),
    );

    expect(lines.slice(1, 7)).toEqual([
      'Target: unavailable',
      'Representation strategy: unavailable',
      'Representation capability: UNAVAILABLE',
      'Representation disclosure: unavailable',
      'Proposal binding status: UNAVAILABLE',
      'Proposal binding reason: unavailable',
    ]);
  });
});
