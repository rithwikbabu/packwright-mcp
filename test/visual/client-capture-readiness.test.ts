import { describe, expect, it } from 'vitest';

import {
  assertClientCaptureProposalBindingCanAuthorizeCommit,
  clientCaptureDisplaySettlingTicksForVerification,
  summarizeClientCaptureAuthorityMeasurements,
} from '../../src/visual/workflow.js';

describe('client capture authority measurement readiness', () => {
  const plan = {
    scenes: [
      {
        id: 'required_primary',
        requiredForAuthority: true,
        comparisonSceneIds: ['required_reference'],
        measurementIntents: [
          { id: 'required_pixels', requiredForReadiness: true },
          { id: 'required_uncalibrated', requiredForReadiness: false },
        ],
      },
      {
        id: 'required_reference',
        requiredForAuthority: true,
        comparisonSceneIds: [],
        measurementIntents: [],
      },
      {
        id: 'supplemental',
        requiredForAuthority: false,
        comparisonSceneIds: ['required_primary'],
        measurementIntents: [{ id: 'supplemental_hitbox', requiredForReadiness: false }],
      },
    ],
  };

  it('blocks failed required measurements without greenwashing warnings or skips', () => {
    expect(
      summarizeClientCaptureAuthorityMeasurements(plan, [
        { id: 'required_pixels', status: 'failed' },
        { id: 'required_uncalibrated', status: 'skipped' },
        { id: 'supplemental_hitbox', status: 'warning' },
      ]),
    ).toEqual({
      ready: false,
      failed: ['required_pixels'],
      warnings: [],
      skipped: [],
    });
  });

  it('keeps critical warnings and best-effort skips evidence-ready, and ignores supplemental failures', () => {
    expect(
      summarizeClientCaptureAuthorityMeasurements(plan, [
        { id: 'required_pixels', status: 'warning' },
        { id: 'required_uncalibrated', status: 'skipped' },
        { id: 'supplemental_hitbox', status: 'failed' },
      ]),
    ).toEqual({
      ready: true,
      failed: [],
      warnings: ['required_pixels'],
      skipped: [],
    });
  });

  it('fails closed when a readiness-critical measurement is skipped', () => {
    expect(
      summarizeClientCaptureAuthorityMeasurements(plan, [
        { id: 'required_pixels', status: 'skipped' },
        { id: 'required_uncalibrated', status: 'skipped' },
        { id: 'supplemental_hitbox', status: 'failed' },
      ]),
    ).toEqual({
      ready: false,
      failed: [],
      warnings: [],
      skipped: ['required_pixels'],
    });
  });

  it('keeps measurements calibrated by supplemental controls advisory', () => {
    const controlledPlan = {
      scenes: [
        {
          id: 'hero',
          requiredForAuthority: true,
          comparisonSceneIds: ['measurement_control--hero'],
          measurementIntents: [{ id: 'calibrated_foreground', requiredForReadiness: false }],
        },
        {
          id: 'measurement_control--hero',
          requiredForAuthority: false,
          comparisonSceneIds: ['hero'],
          measurementIntents: [{ id: 'supplemental_delta', requiredForReadiness: false }],
        },
      ],
    };
    expect(
      summarizeClientCaptureAuthorityMeasurements(controlledPlan, [
        { id: 'calibrated_foreground', status: 'failed' },
        { id: 'supplemental_delta', status: 'failed' },
      ]),
    ).toEqual({ ready: true, failed: [], warnings: [], skipped: [] });
  });

  it('uses per-intent sources so a supplemental mask control does not contaminate pairwise authority', () => {
    const controlledPlan = {
      scenes: [
        {
          id: 'mid',
          requiredForAuthority: true,
          comparisonSceneIds: ['control', 'near'],
          measurementIntents: [
            {
              id: 'range_delta',
              requiredForReadiness: true,
              sourceSceneIds: ['mid', 'near'],
            },
            {
              id: 'subject_mask',
              requiredForReadiness: false,
              sourceSceneIds: ['control', 'mid'],
            },
          ],
        },
        { id: 'near', requiredForAuthority: true, comparisonSceneIds: [], measurementIntents: [] },
        {
          id: 'control',
          requiredForAuthority: false,
          comparisonSceneIds: ['mid'],
          measurementIntents: [],
        },
      ],
    };
    expect(
      summarizeClientCaptureAuthorityMeasurements(controlledPlan, [
        { id: 'range_delta', status: 'failed' },
        { id: 'subject_mask', status: 'failed' },
      ]),
    ).toEqual({
      ready: false,
      failed: ['range_delta'],
      warnings: [],
      skipped: [],
    });
  });
});

describe('client capture proposal scope', () => {
  it('allows exact implemented item evidence and rejects capture-only target QA before commit', () => {
    expect(() => assertClientCaptureProposalBindingCanAuthorizeCommit('implemented')).not.toThrow();
    expect(() => assertClientCaptureProposalBindingCanAuthorizeCommit('capture_only')).toThrow(
      /representation QA only/u,
    );
  });
});

describe('client capture display settling verification', () => {
  it('uses an authoritative display scene when a zero-tick supplemental control sorts first', () => {
    expect(
      clientCaptureDisplaySettlingTicksForVerification('display_rig', [
        { requiredForAuthority: false, settlingTicks: 0 },
        { requiredForAuthority: true, settlingTicks: 4 },
      ]),
    ).toBe(4);
  });

  it('fails closed when a display plan has no settled authoritative scene', () => {
    expect(() =>
      clientCaptureDisplaySettlingTicksForVerification('block_display', [
        { requiredForAuthority: false, settlingTicks: 0 },
      ]),
    ).toThrow(/no authoritative settled scene/u);
  });

  it('rejects mixed authoritative display settling intervals', () => {
    expect(() =>
      clientCaptureDisplaySettlingTicksForVerification('display_rig', [
        { requiredForAuthority: true, settlingTicks: 2 },
        { requiredForAuthority: true, settlingTicks: 4 },
      ]),
    ).toThrow(/must share one settling interval/u);
  });

  it('does not impose display settling on native representations', () => {
    expect(
      clientCaptureDisplaySettlingTicksForVerification('native_placeable_block', [
        { requiredForAuthority: true, settlingTicks: 0 },
      ]),
    ).toBeUndefined();
  });
});
