import { describe, expect, it } from 'vitest';

import { compileItemAsset } from '../../src/visual/compiler.js';
import {
  REVIEW_PROFILE_IDS,
  parseModelSpec,
  safeParseModelSpec,
} from '../../src/visual/model-spec.js';
import {
  MAX_REVIEW_SCENES,
  REVIEW_PROFILES,
  REVIEW_PROFILE_RENDERER_VERSION,
  resolveReviewProfile,
  type ReviewProfileId,
} from '../../src/visual/review-profile.js';

const baseSpec = {
  id: 'arcana:review_profile_matrix',
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

const EXPECTED_SCENES = {
  block: [
    'block_inventory',
    'block_world',
    'block_north',
    'block_south',
    'block_east',
    'block_west',
    'block_up',
    'block_down',
    'block_adjacent',
    'block_lighting',
    'block_culling',
  ],
  placeable: [
    'placeable_neutral',
    'placeable_north',
    'placeable_east',
    'placeable_south',
    'placeable_west',
    'placeable_floor',
    'placeable_collision',
    'placeable_wall',
    'placeable_ceiling',
  ],
  armor: [
    'armor_steve_front',
    'armor_steve_rear',
    'armor_steve_right',
    'armor_steve_left',
    'armor_alex_front',
    'armor_alex_rear',
    'armor_alex_right',
    'armor_alex_left',
    'armor_slot_head',
    'armor_slot_chest',
    'armor_slot_legs',
    'armor_slot_feet',
    'armor_steve_walking',
    'armor_steve_crouching',
    'armor_alex_walking',
    'armor_alex_crouching',
  ],
  head_wearable: [
    'head_steve_front',
    'head_steve_rear',
    'head_steve_right',
    'head_steve_left',
    'head_alex_front',
    'head_alex_rear',
    'head_alex_right',
    'head_alex_left',
    'head_fp_standard',
    'head_fp_wide',
    'head_stand_front',
    'head_stand_rear',
    'head_stand_right',
    'head_stand_left',
    'head_neutral',
  ],
  projectile: [
    'projectile_in_hand',
    'projectile_flight_side',
    'projectile_flight_front',
    'projectile_flight_rear',
    'projectile_impact',
    'projectile_stuck',
  ],
  gui_item: [
    'gui_inventory_64',
    'gui_inventory_32',
    'gui_hotbar',
    'gui_count_1',
    'gui_count_64',
    'gui_durability',
    'gui_glint',
    'gui_tooltip',
    'gui_hotbar_selected',
  ],
  entity_model: [
    'entity_front',
    'entity_front_right',
    'entity_right',
    'entity_rear_right',
    'entity_rear',
    'entity_rear_left',
    'entity_left',
    'entity_front_left',
    'entity_pose_attacking',
    'entity_pose_idle',
    'entity_pose_walking',
    'entity_scale_steve',
    'entity_scale_alex',
    'entity_hitbox_front',
    'entity_hitbox_side',
  ],
} as const satisfies Readonly<Record<Exclude<ReviewProfileId, 'held_item'>, readonly string[]>>;

const validReviewMetadata = {
  held_item: {
    heldItem: {
      primaryGrip: [8, 5.5, 11],
      forwardAxis: [0, 0, -1],
      handedness: 'either',
      twoHanded: false,
      itemKind: 'weapon',
      usePose: 'aim',
    },
  },
  block: {
    blockReview: { adjacentBlocks: false, lightingChecks: true, cullingChecks: false },
  },
  placeable: {
    placeableReview: {
      orientations: ['east', 'south'],
      attachments: ['floor', 'wall'],
      footprint: [8, 12],
    },
  },
  armor: {
    armorReview: {
      slots: ['head', 'feet'],
      bodyVariants: ['alex'],
      poses: ['neutral', 'crouching'],
    },
  },
  head_wearable: {
    headWearableReview: {
      bodyVariants: ['alex'],
      firstPersonObstruction: false,
      armorStand: true,
    },
  },
  projectile: {
    projectileReview: {
      forwardAxis: [1, 0, 0],
      inHand: false,
      impact: true,
      stuckDepth: 3,
    },
  },
  gui_item: {
    guiItemReview: {
      counts: [1, 16, 64],
      durability: false,
      glint: true,
      tooltip: 'Arcane focus',
    },
  },
  entity_model: {
    entityModelReview: {
      hitbox: [8, 20, 8],
      animationPoses: ['idle', 'attacking'],
      playerScaleReference: false,
    },
  },
} as const;

function parseProfile(profile: ReviewProfileId, metadata: object = {}) {
  return parseModelSpec({ ...baseSpec, reviewProfile: profile, ...metadata });
}

describe('review profile registry and canonical scene matrix', () => {
  it('registers exactly the eight public profiles in canonical order', () => {
    expect(REVIEW_PROFILE_IDS).toEqual([
      'held_item',
      'block',
      'placeable',
      'armor',
      'head_wearable',
      'projectile',
      'gui_item',
      'entity_model',
    ]);
    expect(Object.keys(REVIEW_PROFILES)).toEqual(REVIEW_PROFILE_IDS);
  });

  for (const profile of REVIEW_PROFILE_IDS.filter(
    (candidate): candidate is Exclude<ReviewProfileId, 'held_item'> => candidate !== 'held_item',
  )) {
    it(`${profile} has stable ordered scenes, identity, bounds, and plan hashing`, () => {
      const spec = parseProfile(profile);
      const first = resolveReviewProfile(spec, 96);
      const second = resolveReviewProfile(spec, 96);
      const sceneIds = first.scenes.map((scene) => scene.id);

      expect(first).toMatchObject({
        profileId: profile,
        profileVersion: 1,
        rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
      });
      expect(sceneIds).toEqual(EXPECTED_SCENES[profile]);
      expect(sceneIds.length).toBeLessThanOrEqual(MAX_REVIEW_SCENES);
      expect(new Set(sceneIds).size).toBe(sceneIds.length);
      expect(new Set(first.requiredViewIds).size).toBe(first.requiredViewIds.length);
      expect(first.requiredViewIds.every((id) => sceneIds.includes(id))).toBe(true);
      expect(first.planSha256).toBe(second.planSha256);
      expect(first.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    });
  }
});

describe('review profile metadata', () => {
  it('accepts valid metadata only when it matches the selected profile', () => {
    for (const profile of REVIEW_PROFILE_IDS) {
      const result = safeParseModelSpec({
        ...baseSpec,
        reviewProfile: profile,
        ...validReviewMetadata[profile],
      });
      expect(result.success, profile).toBe(true);
    }
  });

  it('rejects metadata left behind when the selected profile changes', () => {
    for (const profile of REVIEW_PROFILE_IDS) {
      const nextProfile =
        REVIEW_PROFILE_IDS.at((REVIEW_PROFILE_IDS.indexOf(profile) + 1) % 8) ?? 'held_item';
      const result = safeParseModelSpec({
        ...baseSpec,
        reviewProfile: nextProfile,
        ...validReviewMetadata[profile],
      });
      expect(result.success, `${profile} metadata with ${nextProfile} selected`).toBe(false);
    }
  });

  it.each([
    ['block', { blockReview: { adjacentBlocks: 'yes' } }],
    [
      'placeable',
      {
        placeableReview: {
          orientations: ['north', 'north'],
          attachments: ['floor'],
          footprint: [16, 16],
        },
      },
    ],
    [
      'armor',
      {
        armorReview: {
          slots: ['head', 'head'],
          bodyVariants: ['steve'],
          poses: ['neutral'],
        },
      },
    ],
    ['head_wearable', { headWearableReview: { bodyVariants: ['alex', 'alex'] } }],
    ['projectile', { projectileReview: { forwardAxis: [0, 0, 0] } }],
    ['gui_item', { guiItemReview: { counts: [64, 64] } }],
    [
      'entity_model',
      { entityModelReview: { hitbox: [0, 16, 8], animationPoses: ['idle', 'idle'] } },
    ],
  ] as const)('rejects invalid %s metadata', (profile, metadata) => {
    expect(safeParseModelSpec({ ...baseSpec, reviewProfile: profile, ...metadata }).success).toBe(
      false,
    );
  });

  it('filters each profile scene set from its own metadata without reordering', () => {
    const cases = [
      {
        profile: 'block',
        metadata: {
          blockReview: { adjacentBlocks: false, lightingChecks: false, cullingChecks: false },
        },
        expected: [
          'block_inventory',
          'block_world',
          'block_north',
          'block_south',
          'block_east',
          'block_west',
          'block_up',
          'block_down',
        ],
      },
      {
        profile: 'placeable',
        metadata: {
          placeableReview: {
            orientations: ['east'],
            attachments: ['wall'],
            footprint: [8, 12],
          },
        },
        expected: ['placeable_neutral', 'placeable_east', 'placeable_collision', 'placeable_wall'],
      },
      {
        profile: 'armor',
        metadata: {
          armorReview: {
            slots: ['head', 'feet'],
            bodyVariants: ['alex'],
            poses: ['neutral', 'crouching'],
          },
        },
        expected: [
          'armor_alex_front',
          'armor_alex_rear',
          'armor_alex_right',
          'armor_alex_left',
          'armor_slot_head',
          'armor_slot_feet',
          'armor_alex_crouching',
        ],
      },
      {
        profile: 'head_wearable',
        metadata: {
          headWearableReview: {
            bodyVariants: ['alex'],
            firstPersonObstruction: false,
            armorStand: false,
          },
        },
        expected: [
          'head_alex_front',
          'head_alex_rear',
          'head_alex_right',
          'head_alex_left',
          'head_neutral',
        ],
      },
      {
        profile: 'projectile',
        metadata: {
          projectileReview: {
            forwardAxis: [0, 0, -1],
            inHand: false,
            impact: false,
            stuckDepth: 2,
          },
        },
        expected: ['projectile_flight_side', 'projectile_flight_front', 'projectile_flight_rear'],
      },
      {
        profile: 'gui_item',
        metadata: {
          guiItemReview: {
            counts: [1, 64],
            durability: false,
            glint: false,
          },
        },
        expected: [
          'gui_inventory_64',
          'gui_inventory_32',
          'gui_hotbar',
          'gui_count_1',
          'gui_count_64',
          'gui_tooltip',
          'gui_hotbar_selected',
        ],
      },
      {
        profile: 'entity_model',
        metadata: {
          entityModelReview: {
            hitbox: [8, 16, 8],
            animationPoses: ['idle'],
            playerScaleReference: false,
          },
        },
        expected: [
          'entity_front',
          'entity_front_right',
          'entity_right',
          'entity_rear_right',
          'entity_rear',
          'entity_rear_left',
          'entity_left',
          'entity_front_left',
          'entity_pose_idle',
          'entity_hitbox_front',
          'entity_hitbox_side',
        ],
      },
    ] as const;

    for (const { profile, metadata, expected } of cases) {
      const plan = resolveReviewProfile(parseProfile(profile, metadata), 64);
      expect(
        plan.scenes.map((scene) => scene.id),
        profile,
      ).toEqual(expected);
    }
  });

  it('makes every requested GUI stack count explicit in the hashed scene plan', () => {
    const counts = [1, 16, 64] as const;
    const plan = resolveReviewProfile(
      parseProfile('gui_item', {
        guiItemReview: { counts, durability: false, glint: false },
      }),
      64,
    );

    expect(
      plan.scenes.map((scene) => scene.id).filter((id) => id.startsWith('gui_count_')),
    ).toEqual(counts.map((count) => `gui_count_${String(count)}`));
    for (const count of counts) {
      expect(plan.scenes.find((scene) => scene.id === `gui_count_${String(count)}`)).toMatchObject({
        title: `Stack-count overlay: ${String(count)}`,
        referenceGeometry: [{ kind: 'item_overlay', overlay: 'count', count }],
      });
    }
    expect(plan.scenes.length).toBeLessThanOrEqual(MAX_REVIEW_SCENES);

    const different = resolveReviewProfile(
      parseProfile('gui_item', {
        guiItemReview: { counts: [2, 32], durability: false, glint: false },
      }),
      64,
    );
    expect(different.planSha256).not.toBe(plan.planSha256);
  });

  it('anchors isolated and single-slot armor assets to the selected body slot', () => {
    const isolated = resolveReviewProfile(
      parseProfile('armor', {
        armorReview: {
          slots: ['head', 'feet'],
          bodyVariants: ['steve', 'alex'],
          poses: ['neutral'],
        },
      }),
      64,
    );
    expect(isolated.scenes.find((scene) => scene.id === 'armor_slot_head')).toMatchObject({
      assetState: { kind: 'armor', visibleSlots: ['head'], isolateSlots: true },
      itemPose: { translation: [0, 11, 0] },
    });
    expect(isolated.scenes.find((scene) => scene.id === 'armor_slot_feet')).toMatchObject({
      assetState: { kind: 'armor', visibleSlots: ['feet'], isolateSlots: true },
      itemPose: { translation: [0, -14, 0] },
    });

    const singleSlot = resolveReviewProfile(
      parseProfile('armor', {
        armorReview: {
          slots: ['chest'],
          bodyVariants: ['steve', 'alex'],
          poses: ['neutral'],
        },
      }),
      64,
    );
    expect(singleSlot.scenes.find((scene) => scene.id === 'armor_steve_front')).toMatchObject({
      assetState: { visibleSlots: ['chest'], isolateSlots: false },
      itemPose: { translation: [0, 2, 0] },
    });
  });

  it('keeps variant-fit evidence explicitly skipped when only one body variant is selected', () => {
    const cases = [
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
    ];

    for (const { profile, metadata, metric } of cases) {
      const plan = resolveReviewProfile(parseProfile(profile, metadata), 64);
      expect(plan.measurements.find((measurement) => measurement.id === metric)).toMatchObject({
        sceneIds: [],
      });
    }
  });
});

describe('review-only compiler invariance', () => {
  it('keeps every profile and its metadata out of compiled files and geometry', () => {
    const baseline = compileItemAsset(parseProfile('held_item'));

    for (const profile of REVIEW_PROFILE_IDS) {
      const compiled = compileItemAsset(parseProfile(profile, validReviewMetadata[profile]));
      expect(compiled.files, `${profile} files`).toEqual(baseline.files);
      expect(compiled.geometry, `${profile} geometry`).toEqual(baseline.geometry);
      expect(compiled.uvLayout, `${profile} UV layout`).toEqual(baseline.uvLayout);
      expect(compiled.textures, `${profile} textures`).toEqual(baseline.textures);
    }
  });
});
