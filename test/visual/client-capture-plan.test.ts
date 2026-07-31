import { describe, expect, it } from 'vitest';

import {
  clientCaptureComponentLiterals,
  createVisualClientCaptureScenes,
} from '../../src/visual/client-capture-plan.js';
import {
  CLIENT_CAPTURE_REVIEW_SUPPORT,
  clientCaptureReviewSupport,
} from '../../src/visual/client-capture-support.js';
import { compileItemAsset, createItemBindingProposal } from '../../src/visual/compiler.js';
import { parseModelSpec, REVIEW_PROFILE_IDS } from '../../src/visual/model-spec.js';

const baseSpec = {
  id: 'arcana:capture_fixture',
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

describe('visual client-capture scene lowering', () => {
  it('serializes the independently signed item-model component as Minecraft command syntax', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'held_item' });
    const compiled = compileItemAsset(spec);
    const binding = createItemBindingProposal(spec, compiled, 'minecraft:blaze_rod');

    expect(binding.itemStack.components).toEqual({
      'minecraft:item_model': 'arcana:capture_fixture',
    });
    expect(clientCaptureComponentLiterals(binding)).toEqual({
      'minecraft:item_model': '"arcana:capture_fixture"',
    });
  });

  it('lowers every required and conditional held-item view to bounded client scenes', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      reviewProfile: 'held_item',
      heldItem: {
        primaryGrip: [8, 5.5, 11],
        muzzle: [8, 14, 8],
        forwardAxis: [0, 0, -1],
        handedness: 'either',
        twoHanded: false,
        itemKind: 'weapon',
        usePose: 'aim',
      },
    });

    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
    });

    expect(scenes).toHaveLength(15);
    expect(new Set(scenes.map((scene) => scene.id))).toHaveProperty('size', 15);
    expect(scenes.every((scene) => scene.resolution.width === 1280)).toBe(true);
    expect(scenes.every((scene) => scene.resolution.height === 720)).toBe(true);
    expect(scenes.every((scene) => scene.guiScale === 2)).toBe(true);
    expect(scenes.find((scene) => scene.id === 'fp_left_alex')).toMatchObject({
      camera: 'first_person',
      context: 'world',
      hand: 'left',
      playerModel: 'alex',
      presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' },
    });
    expect(scenes.find((scene) => scene.id === 'tp_front_right_steve')).toMatchObject({
      camera: 'third_person_front',
      hand: 'right',
      playerModel: 'steve',
    });
    expect(scenes.find((scene) => scene.id === 'item_neutral')).toMatchObject({
      camera: 'neutral',
      context: 'item_inspection',
      animationState: 'idle',
    });
    expect(scenes.find((scene) => scene.id === 'swing_midpoint')).toMatchObject({
      camera: 'first_person',
      context: 'world',
      animationState: 'swing',
      frame: 4,
      presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' },
    });
    expect(scenes.find((scene) => scene.id === 'active_use')).toMatchObject({
      camera: 'first_person',
      context: 'world',
      animationState: 'aim',
      frame: 10,
      presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' },
    });
    expect(scenes.find((scene) => scene.id === 'aiming')).toMatchObject({
      camera: 'first_person',
      context: 'world',
      animationState: 'aim',
      presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' },
    });
  });

  it('rejects two-handed capture until a secondary reference arm is posed and verified', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      reviewProfile: 'held_item',
      heldItem: {
        primaryGrip: [8, 5.5, 11],
        secondaryGrip: [8, 10.5, 11],
        twoHanded: true,
      },
    });

    expect(() =>
      createVisualClientCaptureScenes(spec, { width: 1280, height: 720, guiScale: 2 }),
    ).toThrow(/secondary reference arm/u);
  });

  it('rejects a declared secondary grip even when the twoHanded flag is false', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      reviewProfile: 'held_item',
      heldItem: {
        primaryGrip: [8, 5.5, 11],
        secondaryGrip: [8, 10.5, 11],
        twoHanded: false,
      },
    });

    expect(() =>
      createVisualClientCaptureScenes(spec, { width: 1280, height: 720, guiScale: 2 }),
    ).toThrow(/secondary reference arm/u);
  });

  it('uses actual GUI contexts and presentation states for the gui_item profile', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      reviewProfile: 'gui_item',
      guiItemReview: { counts: [1, 32], durability: true, glint: true },
    });

    const scenes = createVisualClientCaptureScenes(spec, {
      width: 960,
      height: 540,
      guiScale: 3,
    });

    expect(scenes.find((scene) => scene.id === 'gui_inventory_64')).toMatchObject({
      context: 'inventory',
      guiScale: 4,
    });
    expect(scenes.find((scene) => scene.id === 'gui_inventory_32')).toMatchObject({
      context: 'inventory',
      guiScale: 2,
    });
    expect(scenes.find((scene) => scene.id === 'gui_hotbar')).toMatchObject({
      context: 'hotbar',
      guiScale: 3,
    });
    expect(scenes.find((scene) => scene.id === 'gui_tooltip')).toMatchObject({
      context: 'tooltip',
    });
    expect(scenes.find((scene) => scene.id === 'gui_count_32')).toMatchObject({
      presentation: { stackCount: 32 },
    });
    expect(scenes.find((scene) => scene.id === 'gui_durability')).toMatchObject({
      presentation: { durabilityFraction: 0.5 },
    });
    expect(scenes.find((scene) => scene.id === 'gui_glint')).toMatchObject({
      presentation: { showGlint: true },
    });
  });

  it('does not invent an unsupported native use animation for a directional idle item', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      reviewProfile: 'held_item',
      heldItem: {
        primaryGrip: [8, 5.5, 11],
        forwardAxis: [0, 0, -1],
        usePose: 'none',
      },
    });

    const scenes = createVisualClientCaptureScenes(spec, {
      width: 960,
      height: 540,
      guiScale: 2,
    });

    expect(scenes.find((scene) => scene.id === 'aiming')).toMatchObject({
      animationState: 'idle',
      frame: 0,
    });
  });

  it('fails explicitly instead of relabeling CPU renders for unsupported profiles', () => {
    expect(Object.keys(CLIENT_CAPTURE_REVIEW_SUPPORT).sort()).toEqual(
      [...REVIEW_PROFILE_IDS].sort(),
    );
    for (const profile of REVIEW_PROFILE_IDS) {
      const spec = parseModelSpec({ ...baseSpec, reviewProfile: profile });
      if (clientCaptureReviewSupport(profile) === 'unsupported') {
        expect(() =>
          createVisualClientCaptureScenes(spec, { width: 640, height: 360, guiScale: 2 }),
        ).toThrow(/cannot produce authoritative Minecraft-client evidence/u);
      }
    }
  });
});
