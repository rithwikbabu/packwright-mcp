import { describe, expect, it } from 'vitest';

import { compileItemAsset } from '../../src/visual/compiler.js';
import { parseModelSpec, safeParseModelSpec } from '../../src/visual/model-spec.js';
import {
  MAX_REVIEW_SCENES,
  REVIEW_PROFILE_RENDERER_VERSION,
  resolveReviewProfile,
} from '../../src/visual/review-profile.js';

const baseSpec = {
  id: 'arcana:review_fixture',
  targetKind: 'item',
  materials: { metal: { color: '#667788' } },
  parts: [
    {
      id: 'body',
      shape: 'cuboid',
      from: [6, 2, 6],
      to: [10, 14, 10],
      material: 'metal',
    },
  ],
} as const;

const REQUIRED_HELD_ITEM_VIEWS = [
  'fp_right_steve',
  'fp_right_alex',
  'fp_left_steve',
  'fp_left_alex',
  'fp_right_wide',
  'tp_rear_right_steve',
  'tp_rear_right_alex',
  'tp_front_right_steve',
  'tp_front_right_alex',
  'tp_rear_left_steve',
  'tp_rear_left_alex',
  'item_neutral',
] as const;

describe('held-item review profile', () => {
  it('resolves the twelve required views in a stable semantic order', () => {
    const spec = parseModelSpec(baseSpec);
    const first = resolveReviewProfile(spec, 96);
    const second = resolveReviewProfile(spec, 96);

    expect(first).toMatchObject({
      profileId: 'held_item',
      profileVersion: 1,
      rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
    });
    expect(first.scenes.map((scene) => scene.id)).toEqual(REQUIRED_HELD_ITEM_VIEWS);
    expect(first.requiredViewIds).toEqual(REQUIRED_HELD_ITEM_VIEWS);
    expect(first.scenes.every((scene) => scene.required)).toBe(true);
    expect(first.planSha256).toBe(second.planSha256);
    expect(first.planSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('appends only the conditional views requested by held-item semantics', () => {
    const cases = [
      {
        heldItem: { itemKind: 'weapon' as const },
        expected: 'swing_midpoint',
      },
      {
        heldItem: { usePose: 'bow' as const },
        expected: 'active_use',
      },
      {
        heldItem: {
          twoHanded: true,
          secondaryGrip: [8, 10.5, 11] as const,
        },
        expected: 'two_handed',
      },
      {
        heldItem: { forwardAxis: [0, 0, -1] as const },
        expected: 'aiming',
      },
    ];

    for (const { heldItem, expected } of cases) {
      const plan = resolveReviewProfile(parseModelSpec({ ...baseSpec, heldItem }), 64);
      expect(plan.scenes.map((scene) => scene.id)).toEqual([...REQUIRED_HELD_ITEM_VIEWS, expected]);
    }
  });

  it('uses the declared primary hand for conditional action scenes', () => {
    const plan = resolveReviewProfile(
      parseModelSpec({
        ...baseSpec,
        heldItem: {
          handedness: 'left',
          itemKind: 'weapon',
          usePose: 'aim',
          forwardAxis: [0, 0, -1],
        },
      }),
      64,
    );

    for (const id of ['swing_midpoint', 'active_use', 'aiming']) {
      expect(plan.scenes.find((scene) => scene.id === id)).toMatchObject({
        hand: 'left',
        displayContext: 'firstperson_lefthand',
      });
    }
  });

  it('fits every held-item conditional into the shared sixteen-scene limit', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      heldItem: {
        primaryGrip: [8, 5.5, 11],
        secondaryGrip: [8, 10.5, 11],
        muzzle: [8, 14, 8],
        forwardAxis: [0, 0, -1],
        handedness: 'either',
        twoHanded: true,
        itemKind: 'weapon',
        usePose: 'aim',
      },
    });
    const plan = resolveReviewProfile(spec, 128);

    expect(MAX_REVIEW_SCENES).toBe(16);
    expect(plan.scenes).toHaveLength(MAX_REVIEW_SCENES);
    expect(plan.scenes.map((scene) => scene.id)).toEqual([
      ...REQUIRED_HELD_ITEM_VIEWS,
      'swing_midpoint',
      'active_use',
      'two_handed',
      'aiming',
    ]);
    expect(new Set(plan.requiredViewIds).size).toBe(MAX_REVIEW_SCENES);
  });

  it('validates held-item anchors, directions, pose dependencies, and strict fields', () => {
    const defaulted = parseModelSpec(baseSpec);
    expect(defaulted.reviewProfile).toBe('held_item');
    expect(defaulted.heldItem).toBeUndefined();
    expect(
      parseModelSpec({
        ...baseSpec,
        heldItem: { forwardAxis: [0, 0, -1] },
      }).heldItem,
    ).toMatchObject({
      primaryGrip: [8, 5.5, 11],
      forwardAxis: [0, 0, -1],
      handedness: 'either',
      twoHanded: false,
      itemKind: 'generic',
      usePose: 'none',
    });

    const invalidHeldItems = [
      { forwardAxis: [0, 0, 0] },
      { twoHanded: true },
      { secondaryGrip: [8, 5.5, 11] },
      { muzzle: [8, 5.5, 11] },
      { usePose: 'aim' },
      { unknownReviewField: true },
    ];
    for (const heldItem of invalidHeldItems) {
      expect(safeParseModelSpec({ ...baseSpec, heldItem }).success).toBe(false);
    }
  });

  it('keeps review-only semantics out of compiled Minecraft assets', () => {
    const withoutReviewMetadata = compileItemAsset(parseModelSpec(baseSpec));
    const withReviewMetadata = compileItemAsset(
      parseModelSpec({
        ...baseSpec,
        reviewProfile: 'held_item',
        heldItem: {
          primaryGrip: [7.5, 6, 10],
          secondaryGrip: [8, 11, 10],
          muzzle: [8, 15, 8],
          forwardAxis: [0, 0, -1],
          handedness: 'either',
          twoHanded: true,
          itemKind: 'weapon',
          usePose: 'aim',
        },
      }),
    );

    expect(withReviewMetadata.files).toEqual(withoutReviewMetadata.files);
    expect(withReviewMetadata.geometry).toEqual(withoutReviewMetadata.geometry);
    expect(withReviewMetadata.uvLayout).toEqual(withoutReviewMetadata.uvLayout);
    expect(withReviewMetadata.textures).toEqual(withoutReviewMetadata.textures);
  });
});
