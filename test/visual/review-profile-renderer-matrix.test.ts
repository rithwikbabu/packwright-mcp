import { describe, expect, it } from 'vitest';

import { parseModelSpec, type ModelSpec } from '../../src/visual/model-spec.js';
import { renderModelSpec } from '../../src/visual/renderer.js';
import { resolveReviewProfile, type ReviewProfileId } from '../../src/visual/review-profile.js';

const COLOR = '#ff6600';

function profileSpec(profile: ReviewProfileId): ModelSpec {
  const bounds: Readonly<Record<ReviewProfileId, readonly [number[], number[]]>> = {
    held_item: [
      [7, 0, 7],
      [9, 16, 9],
    ],
    block: [
      [0, 0, 0],
      [16, 16, 16],
    ],
    placeable: [
      [0, 0, 0],
      [16, 16, 16],
    ],
    armor: [
      [0, 0, 0],
      [16, 16, 16],
    ],
    head_wearable: [
      [6.5, 6.5, 6.5],
      [9.5, 9.5, 9.5],
    ],
    projectile: [
      [2, 7, 7],
      [14, 9, 9],
    ],
    gui_item: [
      [0, 0, 0],
      [16, 16, 16],
    ],
    entity_model: [
      [0, 0, 0],
      [16, 16, 16],
    ],
  };
  const [from, to] = bounds[profile];
  const parts =
    profile === 'head_wearable'
      ? [
          {
            id: 'subject',
            shape: 'cuboid',
            from: [4.5, 4.5, 4.5],
            to: [11.5, 11.5, 5],
            material: 'subject',
          },
          {
            id: 'shell_rear',
            shape: 'cuboid',
            from: [4.5, 4.5, 11],
            to: [11.5, 11.5, 11.5],
            material: 'subject',
          },
          {
            id: 'shell_left',
            shape: 'cuboid',
            from: [4.5, 4.5, 5],
            to: [5, 11.5, 11],
            material: 'subject',
          },
          {
            id: 'shell_right',
            shape: 'cuboid',
            from: [11, 4.5, 5],
            to: [11.5, 11.5, 11],
            material: 'subject',
          },
        ]
      : [{ id: 'subject', shape: 'cuboid', from, to, material: 'subject' }];
  const metadata =
    profile === 'held_item'
      ? {
          heldItem: {
            primaryGrip: [8, 5.5, 11],
            forwardAxis: [0, 0, -1],
            handedness: 'either',
          },
        }
      : profile === 'placeable'
        ? { placeableReview: { footprint: [16, 16] } }
        : profile === 'head_wearable'
          ? {
              headWearableReview: {
                bodyVariants: ['steve', 'alex'],
                firstPersonObstruction: false,
                armorStand: true,
              },
            }
          : profile === 'entity_model'
            ? {
                entityModelReview: {
                  hitbox: [16, 16, 16],
                  playerScaleReference: false,
                },
              }
            : {};
  return parseModelSpec({
    id: `matrix:${profile}`,
    targetKind: 'item',
    reviewProfile: profile,
    parts,
    materials: { subject: { color: COLOR } },
    ...metadata,
  });
}

const NEW_PROFILES = [
  'block',
  'placeable',
  'armor',
  'head_wearable',
  'projectile',
  'gui_item',
  'entity_model',
] as const satisfies readonly ReviewProfileId[];

describe('review-profile renderer matrix', () => {
  for (const profile of NEW_PROFILES) {
    it(`renders ${profile} deterministically with complete advisory evidence`, () => {
      const spec = profileSpec(profile);
      const plan = resolveReviewProfile(spec, 64);
      const first = renderModelSpec(spec, { viewSize: 64 });
      const second = renderModelSpec(spec, { viewSize: 64 });

      expect(first.reviewProfile).toEqual(plan);
      expect(first.views.map((view) => view.id)).toEqual(plan.scenes.map((scene) => scene.id));
      expect(first.views.map((view) => view.sha256)).toEqual(
        second.views.map((view) => view.sha256),
      );
      expect(first.contactSheet.sha256).toBe(second.contactSheet.sha256);
      expect(first.contactSheet.png.byteLength).toBeLessThanOrEqual(720 * 1024);
      expect(new Set(first.views.map((view) => view.sha256)).size).toBeGreaterThan(1);
      expect(first.evaluation?.reviewReady).toBe(true);
      expect(new Set(first.evaluation?.measurements.map((entry) => entry.metric))).toEqual(
        new Set(plan.measurements.map((entry) => entry.id)),
      );
      expect(first.evaluation?.measurements.some((entry) => entry.status === 'failed')).toBe(false);
    });
  }

  it.each([
    {
      profile: 'block' as const,
      patch: { from: [-16, -16, -16], to: [32, 32, 32] },
      metric: 'adjacency_seam',
    },
    {
      profile: 'placeable' as const,
      metadata: { placeableReview: { footprint: [4, 4] } },
      metric: 'collision_footprint_delta',
    },
    {
      profile: 'armor' as const,
      patch: { from: [16, 0, 16], to: [32, 16, 32] },
      metric: 'armor_slot_alignment',
    },
    {
      profile: 'head_wearable' as const,
      patch: { from: [0, 0, 0], to: [16, 16, 16] },
      metadata: {
        headWearableReview: {
          bodyVariants: ['steve', 'alex'],
          firstPersonObstruction: true,
          armorStand: true,
        },
      },
      metric: 'head_first_person_obscuration',
    },
    {
      profile: 'projectile' as const,
      metadata: { projectileReview: { forwardAxis: [0, 0, 1] } },
      metric: 'trajectory_alignment',
    },
    {
      profile: 'gui_item' as const,
      patch: { from: [7.75, 7.75, 7.75], to: [8.25, 8.25, 8.25] },
      metric: 'icon_occupancy',
    },
    {
      profile: 'entity_model' as const,
      metadata: { entityModelReview: { hitbox: [4, 4, 4] } },
      metric: 'entity_hitbox_containment',
    },
  ])(
    'flags an intentional $profile defect through $metric',
    ({ profile, patch, metadata, metric }) => {
      const baseline = profileSpec(profile);
      const subject = baseline.parts[0];
      if (subject === undefined) throw new Error('Missing matrix subject.');
      const raw = structuredClone(baseline) as Record<string, unknown> & {
        parts: Record<string, unknown>[];
      };
      delete raw.placeableReview;
      delete raw.projectileReview;
      delete raw.entityModelReview;
      raw.parts[0] = { ...subject, ...patch };
      Object.assign(raw, metadata);
      const result = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });

      expect(result.evaluation?.reviewReady).toBe(false);
      expect(
        result.evaluation?.measurements.some(
          (entry) => entry.metric === metric && entry.status === 'failed',
        ),
      ).toBe(true);
    },
  );

  it.each([
    { axis: [0, 0, -1] as const, expected: [1, 1, 1], ready: true },
    { axis: [0, 0, 1] as const, expected: [-1, -1, -1], ready: false },
    { axis: [1, 0, 0] as const, expected: [0, 0, 0], ready: false },
  ])(
    'measures projectile axis $axis in every transformed flight scene',
    ({ axis, expected, ready }) => {
      const baseline = profileSpec('projectile');
      const raw = structuredClone(baseline) as Record<string, unknown>;
      raw.projectileReview = { forwardAxis: axis, stuckDepth: 2 };
      const result = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });
      const measurements = result.evaluation?.measurements.filter(
        (entry) => entry.metric === 'trajectory_alignment',
      );

      expect(measurements?.map((entry) => entry.view)).toEqual([
        'projectile_flight_side',
        'projectile_flight_front',
        'projectile_flight_rear',
      ]);
      expect(measurements?.map((entry) => entry.value)).toEqual(expected);
      expect(result.evaluation?.reviewReady).toBe(ready);
    },
  );

  it('stages and re-measures each declared projectile stuck depth', () => {
    const renders = [0, 2, 6].map((stuckDepth) => {
      const baseline = profileSpec('projectile');
      const raw = structuredClone(baseline) as Record<string, unknown>;
      raw.projectileReview = { forwardAxis: [0, 0, -1], stuckDepth };
      return { stuckDepth, result: renderModelSpec(parseModelSpec(raw), { viewSize: 64 }) };
    });

    expect(
      new Set(
        renders.map(
          ({ result }) => result.views.find((view) => view.id === 'projectile_stuck')?.sha256,
        ),
      ).size,
    ).toBe(3);
    expect(
      new Set(
        renders.map(
          ({ result }) => result.views.find((view) => view.id === 'projectile_impact')?.sha256,
        ),
      ).size,
    ).toBe(1);
    expect(
      renders.map(
        ({ result }) =>
          result.views.find((view) => view.id === 'projectile_stuck')?.analysis?.referenceBounds
            .surface?.maximum[2],
      ),
    ).toEqual([7, 9, 13]);
    expect(
      renders.map(
        ({ result }) =>
          result.evaluation?.measurements.find(
            (entry) => entry.metric === 'impact_depth_delta' && entry.view === 'projectile_stuck',
          )?.value,
      ),
    ).toEqual([0, 0, 0]);
    expect(
      renders.map(
        ({ result }) =>
          result.evaluation?.measurements.find(
            (entry) => entry.metric === 'impact_depth_delta' && entry.view === 'projectile_stuck',
          )?.message,
      ),
    ).toEqual([
      'Measured 0 model pixels of penetration against 0 requested; depth delta is 0.',
      'Measured 2 model pixels of penetration against 2 requested; depth delta is 0.',
      'Measured 6 model pixels of penetration against 6 requested; depth delta is 0.',
    ]);
  });

  it('fails impact depth when transformed geometry does not match the staged raw tip', () => {
    const baseline = profileSpec('projectile');
    const subject = baseline.parts[0];
    if (subject === undefined) throw new Error('Missing projectile subject.');
    const raw = structuredClone(baseline) as Record<string, unknown> & {
      parts: Record<string, unknown>[];
    };
    raw.projectileReview = { forwardAxis: [0, 0, -1], stuckDepth: 2 };
    raw.parts[0] = {
      ...subject,
      rotation: { axis: 'y', angle: 45, pivot: [8, 8, 8] },
    };
    const result = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });
    const depth = result.evaluation?.measurements.find(
      (entry) => entry.metric === 'impact_depth_delta' && entry.view === 'projectile_impact',
    );

    expect(depth?.status).toBe('failed');
    expect(depth?.value).toBeGreaterThan(2);
  });

  it('renders each requested GUI count as distinct deterministic evidence', () => {
    const baseline = profileSpec('gui_item');
    const raw = structuredClone(baseline) as Record<string, unknown>;
    raw.guiItemReview = { counts: [1, 16, 64], durability: false, glint: false };
    const first = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });
    const second = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });
    const countViews = first.views.filter((view) => view.id.startsWith('gui_count_'));

    expect(countViews.map((view) => view.id)).toEqual([
      'gui_count_1',
      'gui_count_16',
      'gui_count_64',
    ]);
    expect(new Set(countViews.map((view) => view.sha256)).size).toBe(3);
    expect(countViews.map((view) => view.sha256)).toEqual(
      second.views.filter((view) => view.id.startsWith('gui_count_')).map((view) => view.sha256),
    );
  });

  it.each([
    {
      profile: 'armor' as const,
      metadata: {
        armorReview: {
          slots: ['head'],
          bodyVariants: ['alex'],
          poses: ['neutral'],
        },
      },
      metric: 'armor_variant_fit',
    },
    {
      profile: 'head_wearable' as const,
      metadata: {
        headWearableReview: {
          bodyVariants: ['alex'],
          firstPersonObstruction: false,
          armorStand: false,
        },
      },
      metric: 'head_variant_fit',
    },
  ])('skips $metric when $profile selects one body variant', ({ profile, metadata, metric }) => {
    const baseline = profileSpec(profile);
    const raw = structuredClone(baseline) as Record<string, unknown>;
    Object.assign(raw, metadata);
    const result = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });
    const measurements = result.evaluation?.measurements.filter(
      (measurement) => measurement.metric === metric,
    );

    expect(measurements).toHaveLength(1);
    expect(measurements?.[0]?.status).toBe('skipped');
    expect(measurements?.[0]?.value).toBeUndefined();
  });

  it('stages head wearables at the armor-stand anchor and detects real head penetration', () => {
    const fitted = renderModelSpec(profileSpec('head_wearable'), { viewSize: 64 });
    const alignment = fitted.evaluation?.measurements.filter(
      (measurement) => measurement.metric === 'head_armor_stand_alignment',
    );
    const intersection = fitted.evaluation?.measurements.filter(
      (measurement) => measurement.metric === 'head_player_intersection',
    );

    expect(alignment?.every((measurement) => measurement.status === 'passed')).toBe(true);
    expect(alignment?.every((measurement) => measurement.value === 0)).toBe(true);
    expect(intersection?.every((measurement) => measurement.status === 'passed')).toBe(true);
    expect(intersection?.every((measurement) => measurement.value === 0)).toBe(true);

    const raw = structuredClone(profileSpec('head_wearable')) as Record<string, unknown>;
    raw.parts = [
      {
        id: 'subject',
        shape: 'cuboid',
        from: [6.5, 6.5, 6.5],
        to: [9.5, 9.5, 9.5],
        material: 'subject',
      },
    ];
    const penetrating = renderModelSpec(parseModelSpec(raw), { viewSize: 64 });
    expect(
      penetrating.evaluation?.measurements.some(
        (measurement) =>
          measurement.metric === 'head_player_intersection' &&
          measurement.status === 'failed' &&
          measurement.value === 100,
      ),
    ).toBe(true);
  });

  it('derives entity scale from the rendered player reference height', () => {
    const fullHeightRaw = structuredClone(profileSpec('entity_model')) as Record<string, unknown>;
    fullHeightRaw.entityModelReview = {
      hitbox: [16, 30, 16],
      playerScaleReference: true,
    };
    fullHeightRaw.parts = [
      {
        id: 'subject',
        shape: 'cuboid',
        from: [0, 0, 0],
        to: [16, 30, 16],
        material: 'subject',
      },
    ];
    const fullHeight = renderModelSpec(parseModelSpec(fullHeightRaw), { viewSize: 64 });
    const fullHeightScale = fullHeight.evaluation?.measurements.filter(
      (measurement) => measurement.metric === 'entity_player_scale',
    );
    expect(fullHeightScale?.every((measurement) => measurement.status === 'passed')).toBe(true);
    expect(fullHeightScale?.every((measurement) => measurement.value === 0)).toBe(true);

    const shortRaw = structuredClone(profileSpec('entity_model')) as Record<string, unknown>;
    shortRaw.entityModelReview = {
      hitbox: [16, 16, 16],
      playerScaleReference: true,
    };
    const short = renderModelSpec(parseModelSpec(shortRaw), { viewSize: 64 });
    expect(
      short.evaluation?.measurements.every(
        (measurement) =>
          measurement.metric !== 'entity_player_scale' || measurement.status === 'failed',
      ),
    ).toBe(true);
    expect(
      short.evaluation?.measurements
        .filter((measurement) => measurement.metric === 'entity_player_scale')
        .map((measurement) => measurement.value),
    ).toEqual([0.466667, 0.466667]);
  });
});
