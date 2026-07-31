import { describe, expect, it } from 'vitest';

import {
  clientCaptureComponentLiterals,
  createVisualClientCapturePlan,
  createVisualClientCaptureScenes,
} from '../../src/visual/client-capture-plan.js';
import {
  ClientCaptureRepresentationSchema,
  clientCaptureViewAuthority,
  computeClientCaptureRepresentationSha256,
  expectedClientCaptureObservedFixture,
  parseClientCapturePlan,
} from '../../src/minecraft/client-capture-protocol.js';
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
  it('serializes the independently hash-bound item-model component as Minecraft command syntax', () => {
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
    expect(scenes.every((scene) => scene.requiredForAuthority)).toBe(true);
    expect(
      scenes.every(
        (scene) =>
          scene.presentation?.referenceArm === undefined &&
          scene.presentation?.referenceArmPurpose === undefined,
      ),
    ).toBe(true);
    expect(scenes.find((scene) => scene.id === 'first_person_vanilla--fp_left_alex')).toMatchObject(
      {
        baseSceneId: 'fp_left_alex',
        viewKind: 'first_person_vanilla',
        requiredForAuthority: true,
        camera: 'first_person',
        context: 'world',
        hand: 'left',
        playerModel: 'alex',
      },
    );
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
    expect(
      scenes.find((scene) => scene.id === 'first_person_vanilla--swing_midpoint'),
    ).toMatchObject({
      viewKind: 'first_person_vanilla',
      camera: 'first_person',
      context: 'world',
      animationState: 'swing',
      frame: 4,
    });
    expect(scenes.find((scene) => scene.id === 'first_person_vanilla--active_use')).toMatchObject({
      camera: 'first_person',
      context: 'world',
      animationState: 'aim',
      frame: 10,
    });
    expect(scenes.find((scene) => scene.id === 'first_person_vanilla--aiming')).toMatchObject({
      camera: 'first_person',
      context: 'world',
      animationState: 'aim',
    });
  });

  it('adds separately identified scale-reference QA views only when explicitly requested', () => {
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
      includeScaleReferenceViews: true,
    });
    const authoritative = scenes.filter((scene) => scene.requiredForAuthority);
    const supplemental = scenes.filter((scene) => !scene.requiredForAuthority);

    expect(scenes).toHaveLength(23);
    expect(authoritative).toHaveLength(15);
    expect(supplemental).toHaveLength(8);
    expect(supplemental.every((scene) => scene.viewKind === 'first_person_scale_reference')).toBe(
      true,
    );
    expect(
      supplemental.every(
        (scene) =>
          scene.presentation?.referenceArm === true &&
          scene.presentation.referenceArmPurpose === 'scale_only',
      ),
    ).toBe(true);
    for (const reference of supplemental) {
      const vanilla = scenes.find(
        (scene) =>
          scene.viewKind === 'first_person_vanilla' && scene.baseSceneId === reference.baseSceneId,
      );
      expect(vanilla).toBeDefined();
      expect(vanilla?.presentation?.referenceArm).toBeUndefined();
      expect({
        ...reference,
        id: vanilla?.id,
        viewKind: vanilla?.viewKind,
        requiredForAuthority: true,
        presentation: vanilla?.presentation,
        measurementIntents: vanilla?.measurementIntents,
      }).toMatchObject(vanilla ?? {});
    }
  });

  it('rejects two-handed capture until the gameplay secondary hand is posed and verified', () => {
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
    ).toThrow(/gameplay hand/u);
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
    ).toThrow(/gameplay hand/u);
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

    expect(scenes).toHaveLength(9);
    expect(scenes.every((scene) => scene.viewKind === 'minecraft_vanilla')).toBe(true);
    expect(scenes.every((scene) => scene.requiredForAuthority)).toBe(true);

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

    expect(scenes.find((scene) => scene.id === 'first_person_vanilla--aiming')).toMatchObject({
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

  it('lowers an exact native block-state replacement into authoritative world evidence', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'block' });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'block',
      strategy: 'native_block_state',
      capability: 'replacement',
      states: {
        default: { blockState: { id: 'minecraft:stone', properties: {} } },
        powered: { blockState: { id: 'minecraft:redstone_lamp', properties: { lit: 'true' } } },
      },
      review: {
        transparency: false,
        biomeTintBiomes: [],
        animatedTextureTicks: [],
      },
    });
    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
    });

    expect(scenes.map((scene) => scene.id)).toEqual(
      expect.arrayContaining([
        'block_hero',
        'block_face_north',
        'block_face_down',
        'block_adjacency',
        'block_culling',
        'block_light_day',
        'block_light_low',
        'block_state_powered',
      ]),
    );
    expect(
      scenes.some((scene) => 'layout' in scene.fixture && scene.fixture.layout === 'inventory'),
    ).toBe(false);
    expect(scenes.every((scene) => scene.targetKind === 'block')).toBe(true);
    expect(scenes.filter((scene) => scene.requiredForAuthority)).toHaveLength(scenes.length - 1);
    expect(scenes.find((scene) => scene.id === 'measurement_control--block_hero')).toMatchObject({
      viewKind: 'measurement_control',
      requiredForAuthority: false,
      fixture: {
        kind: 'measurement_control',
        targetKind: 'block',
        stateId: 'default',
        control: 'empty_subject',
      },
      comparisonSceneIds: ['block_hero'],
    });
    expect(scenes.find((scene) => scene.id === 'block_light_low')).toMatchObject({
      environment: { time: 18000, lightProfile: 'low', skyLight: 15, blockLight: 4 },
      comparisonSceneIds: ['block_light_day'],
      measurementIntents: [
        {
          metric: 'pairwise_pixel_delta',
          requiredForReadiness: true,
          threshold: { comparison: 'below', warning: 0.1, failure: 0 },
        },
        { metric: 'lighting_separation', requiredForReadiness: true },
      ],
    });
    expect(scenes.find((scene) => scene.id === 'block_hero')).toMatchObject({
      cameraPose: { y: 82.25, yaw: 45, pitch: 14 },
      comparisonSceneIds: ['measurement_control--block_hero'],
    });
    const front = scenes.find((scene) => scene.id === 'block_face_north');
    expect(front?.cameraPose).toMatchObject({ x: 0.5, z: 0.5, yaw: 0, pitch: 14 });
    expect(scenes.find((scene) => scene.id === 'block_face_up')?.cameraPose).toEqual({
      x: 0.5,
      y: 86.5,
      z: 5.5,
      yaw: 0,
      pitch: 90,
    });
    expect(scenes.find((scene) => scene.id === 'block_face_down')?.cameraPose).toEqual({
      x: 0.5,
      y: 82.25,
      z: 5.5,
      yaw: 0,
      pitch: -90,
    });
    expect(scenes.find((scene) => scene.id === 'block_face_down')).toMatchObject({
      fixture: { blockPosition: { x: 0, y: 84, z: 5 } },
    });
  });

  it('emits only explicitly declared block inventory, alpha, and biome conditionals', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'block' });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'block',
      strategy: 'native_block_state',
      capability: 'replacement',
      states: { default: { blockState: { id: 'minecraft:oak_leaves', properties: {} } } },
      review: {
        inventoryItemStack: { itemId: 'minecraft:oak_leaves', count: 1, components: {} },
        transparency: true,
        biomeTintBiomes: ['minecraft:forest', 'minecraft:plains'],
        animatedTextureTicks: [],
      },
    });
    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
    });
    expect(scenes.map((scene) => scene.id)).toEqual(
      expect.arrayContaining([
        'block_inventory',
        'block_transparency_light',
        'block_transparency_dark',
        'block_transparency_overlap',
        'block_biome_0',
        'block_biome_1',
      ]),
    );
    expect(scenes.find((scene) => scene.id === 'block_transparency_light')).toMatchObject({
      fixture: { layout: 'transparency_light', backdrop: 'light', overlapCopies: 1 },
    });
    expect(scenes.find((scene) => scene.id === 'block_transparency_dark')).toMatchObject({
      fixture: { layout: 'transparency_dark', backdrop: 'dark', overlapCopies: 1 },
    });
    expect(scenes.find((scene) => scene.id === 'block_transparency_overlap')).toMatchObject({
      fixture: { layout: 'transparency_overlap', backdrop: 'light', overlapCopies: 2 },
    });
    expect(scenes.find((scene) => scene.id === 'block_biome_1')).toMatchObject({
      environment: { biome: 'minecraft:plains' },
      comparisonSceneIds: ['block_hero'],
      measurementIntents: [
        {
          metric: 'pairwise_pixel_delta',
          requiredForReadiness: false,
          threshold: { comparison: 'below', warning: 0.1, failure: 0 },
        },
      ],
    });

    const representationSha256 = computeClientCaptureRepresentationSha256(representation);
    const plan = createVisualClientCapturePlan({
      spec,
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
      provenance: {
        projectId: 'block_fixture',
        runId: 'a'.repeat(64),
        revisionId: 'b'.repeat(64),
        specSha256: 'c'.repeat(64),
        compiledArtifactId: 'd'.repeat(64),
        proposalArtifactId: 'e'.repeat(64),
        projectManifestSha256: 'f'.repeat(64),
        datapackContentSha256: '0'.repeat(64),
        resourcepackContentSha256: '1'.repeat(64),
        runtimeManifestSha256: '2'.repeat(64),
        representation,
        representationSha256,
        client: { jarSha1: '3'.repeat(40), jarSha256: '4'.repeat(64) },
        captureMod: { id: 'packwright_capture', version: '0.5.0-dev', sha256: '5'.repeat(64) },
      },
      execution: {
        executionId: 'block-transparency-matrix',
        gameDirectory: '/private/tmp/packwright-block',
        outputDirectory: '/private/tmp/packwright-block/output',
      },
    });
    expect(() => parseClientCapturePlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
  });

  it('captures equipped headwear on both player rigs with gameplay and paired control views', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'head_wearable' });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'headwear',
      strategy: 'equippable_head',
      capability: 'native',
      states: {
        default: {
          itemStack: {
            itemId: 'minecraft:carved_pumpkin',
            count: 1,
            components: {
              'minecraft:equippable':
                '{slot:"head",asset_id:"minecraft:diamond",camera_overlay:"arcana:masks/fire"}',
            },
          },
        },
        glint: {
          itemStack: {
            itemId: 'minecraft:carved_pumpkin',
            count: 1,
            components: {
              'minecraft:enchantment_glint_override': 'true',
              'minecraft:equippable':
                '{slot:"head",asset_id:"minecraft:diamond",camera_overlay:"arcana:masks/fire"}',
            },
          },
        },
      },
      headwear: {
        renderMode: 'equipment_model',
        cameraOverlay: 'arcana:masks/fire',
      },
      review: {
        wideFov: true,
        armorStand: true,
        statePoses: { default: 'idle', glint: 'idle' },
        chestArmorItemStack: {
          itemId: 'minecraft:diamond_chestplate',
          count: 1,
          components: { 'minecraft:enchantment_glint_override': 'true' },
        },
      },
    });
    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
    });

    expect(scenes).toHaveLength(26);
    expect(scenes.find((scene) => scene.id === 'head_steve_front_close')).toMatchObject({
      fixture: { subject: 'player', framing: 'head', stateId: 'default' },
      playerModel: 'steve',
      comparisonSceneIds: ['measurement_control--head_steve_front_close'],
    });
    expect(scenes.find((scene) => scene.id === 'head_alex_rear_full')).toMatchObject({
      fixture: { subject: 'player', framing: 'full_body' },
      playerModel: 'alex',
      cameraPose: { yaw: 0 },
    });
    expect(scenes.find((scene) => scene.id === 'head_steve_side_close')).toMatchObject({
      cameraPose: { x: 0.5, y: 80, z: 5.5, yaw: 0, pitch: 0 },
      expectedRenderCameraPose: { x: -1.75, y: 81.62, z: 5.5, yaw: -90, pitch: 0 },
      fixture: { framing: 'head', viewAngle: 'side', subjectYaw: 0, cameraDistance: 2.25 },
    });
    expect(
      scenes.find((scene) => scene.id === 'first_person_vanilla--head_first_person'),
    ).toMatchObject({
      fov: 70,
      viewKind: 'first_person_vanilla',
      requiredForAuthority: true,
      cameraPose: { x: 0.5, y: 80, z: 5.5, yaw: 0, pitch: 0 },
      expectedRenderCameraPose: { x: 0.5, y: 81.62, z: 5.5, yaw: 0, pitch: 0 },
      comparisonSceneIds: ['measurement_control--head_first_person'],
      measurementIntents: [
        {
          id: 'm_head_fp_obstruction',
          requiredForReadiness: false,
          sourceSceneIds: [
            'first_person_vanilla--head_first_person',
            'measurement_control--head_first_person',
          ],
        },
      ],
    });
    expect(
      scenes.find((scene) => scene.id === 'comparison_reference--head_bare_steve'),
    ).toMatchObject({
      fixture: { subject: 'bare_control' },
      comparisonSceneIds: ['head_steve_front_close'],
      viewKind: 'comparison_reference',
      requiredForAuthority: false,
    });
    expect(
      scenes
        .filter(
          (scene) =>
            scene.fixture.kind === 'equippable_head' && scene.fixture.subject === 'bare_control',
        )
        .every((scene) => scene.viewKind === 'comparison_reference' && !scene.requiredForAuthority),
    ).toBe(true);
    expect(
      scenes.find((scene) => scene.id === 'first_person_vanilla--head_camera_overlay'),
    ).toMatchObject({
      comparisonSceneIds: ['measurement_control--head_camera_overlay'],
      measurementIntents: [
        {
          id: 'm_head_overlay',
          requiredForReadiness: false,
          sourceSceneIds: [
            'first_person_vanilla--head_camera_overlay',
            'measurement_control--head_camera_overlay',
          ],
        },
      ],
    });
    expect(scenes.find((scene) => scene.id === 'head_state_glint')).toMatchObject({
      fixture: { stateId: 'glint' },
    });
    expect(scenes.find((scene) => scene.id === 'head_chest_steve')).toMatchObject({
      fixture: {
        kind: 'equippable_head',
        subject: 'player',
        framing: 'full_body',
        chestArmor: true,
      },
      comparisonSceneIds: ['head_steve_front_full'],
    });
    expect(scenes.find((scene) => scene.id === 'head_chest_alex')).toMatchObject({
      fixture: { chestArmor: true },
      comparisonSceneIds: ['head_alex_front_full'],
    });
    expect(scenes.find((scene) => scene.id === 'head_stand_front')).toMatchObject({
      camera: 'neutral',
      context: 'world',
      requiredForAuthority: true,
      fixture: {
        kind: 'equippable_head',
        subject: 'armor_stand',
        framing: 'full_body',
        viewAngle: 'front',
        cameraDistance: 6,
      },
      cameraPose: { x: 0.5, y: 80, z: 5.5, yaw: 0, pitch: 0 },
      expectedRenderCameraPose: { x: 0.5, y: 80.95, z: 11.5, yaw: 180, pitch: 0 },
    });
    expect(scenes.find((scene) => scene.id === 'head_stand_side')).toMatchObject({
      camera: 'neutral',
      context: 'world',
      requiredForAuthority: true,
      fixture: {
        kind: 'equippable_head',
        subject: 'armor_stand',
        framing: 'full_body',
        viewAngle: 'side',
        cameraDistance: 6,
      },
      cameraPose: { x: 0.5, y: 80, z: 5.5, yaw: 0, pitch: 0 },
      expectedRenderCameraPose: { x: -5.5, y: 80.95, z: 5.5, yaw: -90, pitch: 0 },
    });
    expect(
      scenes.find((scene) => scene.id === 'measurement_control--head_steve_front_close'),
    ).toMatchObject({
      viewKind: 'measurement_control',
      requiredForAuthority: false,
      fixture: { kind: 'measurement_control', targetKind: 'headwear' },
    });
    for (const baseSceneId of [
      'head_first_person',
      'head_first_person_wide',
      'head_camera_overlay',
    ]) {
      const control = scenes.find((scene) => scene.id === `measurement_control--${baseSceneId}`);
      const base = scenes.find((scene) => scene.id === `first_person_vanilla--${baseSceneId}`);
      expect(control).toMatchObject({
        viewKind: 'measurement_control',
        requiredForAuthority: false,
        comparisonSceneIds: [`first_person_vanilla--${baseSceneId}`],
      });
      expect(control?.cameraPose).toEqual(base?.cameraPose);
      expect(control?.expectedRenderCameraPose).toEqual(base?.expectedRenderCameraPose);
      expect(control?.environment).toEqual(base?.environment);
    }

    const representationSha256 = computeClientCaptureRepresentationSha256(representation);
    const plan = createVisualClientCapturePlan({
      spec,
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
      provenance: {
        projectId: 'headwear_fixture',
        runId: 'a'.repeat(64),
        revisionId: 'b'.repeat(64),
        specSha256: 'c'.repeat(64),
        compiledArtifactId: 'd'.repeat(64),
        proposalArtifactId: 'e'.repeat(64),
        projectManifestSha256: 'f'.repeat(64),
        datapackContentSha256: '0'.repeat(64),
        resourcepackContentSha256: '1'.repeat(64),
        runtimeManifestSha256: '2'.repeat(64),
        representation,
        representationSha256,
        client: { jarSha1: '3'.repeat(40), jarSha256: '4'.repeat(64) },
        captureMod: { id: 'packwright_capture', version: '0.5.0-dev', sha256: '5'.repeat(64) },
      },
      execution: {
        executionId: 'headwear-chest-compatibility',
        gameDirectory: '/private/tmp/packwright-headwear',
        outputDirectory: '/private/tmp/packwright-headwear/output',
      },
    });
    expect(() => parseClientCapturePlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
  });

  it('always includes armor-stand core views while omitting headwear conditional scenes', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'head_wearable' });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'headwear',
      strategy: 'equippable_head',
      capability: 'replacement',
      states: {
        default: {
          itemStack: {
            itemId: 'minecraft:carved_pumpkin',
            count: 1,
            components: { 'minecraft:equippable': '{slot:"head"}' },
          },
        },
      },
      headwear: { renderMode: 'fallback_item' },
      review: { wideFov: false, armorStand: true, statePoses: { default: 'idle' } },
    });
    const ids = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
    }).map((scene) => scene.id);
    expect(ids).not.toContain('first_person_vanilla--head_first_person_wide');
    expect(ids).toContain('head_stand_front');
    expect(ids).toContain('head_stand_side');
    expect(ids).not.toContain('first_person_vanilla--head_camera_overlay');
    expect(ids).not.toContain('head_chest_steve');
    expect(ids).not.toContain('head_chest_alex');
  });

  it('captures an allow-listed native entity and keeps F3 hitboxes supplemental', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'entity_model' });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'entity',
      strategy: 'native_entity',
      capability: 'replacement',
      states: {
        default: {
          entity: {
            entityType: 'minecraft:zombie',
            baby: false,
            equipment: {
              head: {
                itemId: 'minecraft:diamond_helmet',
                count: 1,
                components: { 'minecraft:enchantment_glint_override': 'true' },
              },
              mainhand: { itemId: 'minecraft:iron_sword', count: 1, components: {} },
            },
          },
        },
        variant_adult: {
          entity: {
            entityType: 'minecraft:wolf',
            variant: 'minecraft:pale',
            baby: false,
            equipment: {},
          },
        },
        variant_baby: {
          entity: {
            entityType: 'minecraft:wolf',
            variant: 'minecraft:woods',
            baby: true,
            equipment: {},
          },
        },
      },
      review: { lowLight: true, animationTicks: [5, 10] },
    });
    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      includeDebugHitboxViews: true,
      representation,
    });
    const debug = scenes.filter((scene) => scene.viewKind === 'debug_hitbox_reference');

    expect(scenes.map((scene) => scene.id)).toEqual(
      expect.arrayContaining([
        'entity_front',
        'entity_rear_left',
        'entity_pose_idle',
        'entity_pose_walk',
        'entity_pose_attack',
        'entity_ground_shadow',
        'world_scale_reference--entity_player_scale',
        'entity_state_variant_adult',
        'entity_state_variant_baby',
        'entity_low_light',
        'debug_hitbox_reference--entity_front',
        'debug_hitbox_reference--entity_right',
      ]),
    );
    expect(debug).toHaveLength(2);
    expect(debug.every((scene) => !scene.requiredForAuthority)).toBe(true);
    expect(
      debug.every((scene) => clientCaptureViewAuthority(scene) === 'augmented_qa_reference'),
    ).toBe(true);
    expect(
      scenes
        .filter(
          (scene) =>
            scene.viewKind !== 'debug_hitbox_reference' &&
            scene.viewKind !== 'measurement_control' &&
            scene.viewKind !== 'world_scale_reference',
        )
        .every((scene) => scene.requiredForAuthority),
    ).toBe(true);
    expect(scenes.find((scene) => scene.id === 'entity_front')).toMatchObject({
      cameraPose: { yaw: 0 },
      fixture: { angle: 0 },
      comparisonSceneIds: ['measurement_control--entity_front'],
    });
    expect(scenes.find((scene) => scene.id === 'entity_rear')).toMatchObject({
      cameraPose: { yaw: 0 },
      fixture: { angle: 180 },
    });
    expect(
      scenes.find((scene) => scene.id === 'world_scale_reference--entity_player_scale'),
    ).toMatchObject({
      baseSceneId: 'entity_player_scale',
      viewKind: 'world_scale_reference',
      requiredForAuthority: false,
      comparisonSceneIds: ['entity_front'],
      fixture: { showPlayerScale: true },
    });
    expect(scenes.find((scene) => scene.id === 'entity_low_light')).toMatchObject({
      environment: { lightProfile: 'low', time: 18000 },
      comparisonSceneIds: ['entity_front'],
      measurementIntents: [
        {
          metric: 'pairwise_pixel_delta',
          requiredForReadiness: true,
          threshold: { comparison: 'below', warning: 0.1, failure: 0 },
        },
      ],
    });
    expect(scenes.find((scene) => scene.id === 'entity_pose_walk')).toMatchObject({
      fixture: { pose: 'walk', animationTick: 5 },
    });
    expect(scenes.find((scene) => scene.id === 'entity_pose_attack')).toMatchObject({
      fixture: { pose: 'attack', animationTick: 5 },
    });
    expect(scenes.find((scene) => scene.id === 'entity_state_variant_adult')).toMatchObject({
      fixture: { stateId: 'variant_adult' },
    });
    expect(scenes.find((scene) => scene.id === 'entity_state_variant_baby')).toMatchObject({
      fixture: { stateId: 'variant_baby' },
    });
    expect(scenes.find((scene) => scene.id === 'measurement_control--entity_front')).toMatchObject({
      requiredForAuthority: false,
      fixture: { kind: 'measurement_control', targetKind: 'entity' },
    });
    expect(scenes.find((scene) => scene.id === 'measurement_control--entity_right')).toMatchObject({
      requiredForAuthority: false,
      comparisonSceneIds: ['entity_right'],
    });
    expect(
      scenes.find((scene) => scene.id === 'debug_hitbox_reference--entity_right'),
    ).toMatchObject({
      comparisonSceneIds: ['entity_right', 'measurement_control--entity_right'],
      measurementIntents: [
        expect.objectContaining({
          sourceSceneIds: [
            'debug_hitbox_reference--entity_right',
            'entity_right',
            'measurement_control--entity_right',
          ],
        }),
        expect.objectContaining({
          sourceSceneIds: [
            'debug_hitbox_reference--entity_right',
            'entity_right',
            'measurement_control--entity_right',
          ],
        }),
      ],
    });

    const representationSha256 = computeClientCaptureRepresentationSha256(representation);
    const plan = createVisualClientCapturePlan({
      spec,
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
      includeDebugHitboxViews: true,
      provenance: {
        projectId: 'entity_fixture',
        runId: 'a'.repeat(64),
        revisionId: 'b'.repeat(64),
        specSha256: 'c'.repeat(64),
        compiledArtifactId: 'd'.repeat(64),
        proposalArtifactId: 'e'.repeat(64),
        projectManifestSha256: 'f'.repeat(64),
        datapackContentSha256: '0'.repeat(64),
        resourcepackContentSha256: '1'.repeat(64),
        runtimeManifestSha256: '2'.repeat(64),
        representation,
        representationSha256,
        client: { jarSha1: '3'.repeat(40), jarSha256: '4'.repeat(64) },
        captureMod: { id: 'packwright_capture', version: '0.5.0-dev', sha256: '5'.repeat(64) },
      },
      execution: {
        executionId: 'native-entity-variant-matrix',
        gameDirectory: '/private/tmp/packwright-entity',
        outputDirectory: '/private/tmp/packwright-entity/output',
      },
    });
    expect(() => parseClientCapturePlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
    const babyScene = plan.scenes.find((scene) => scene.id === 'entity_state_variant_baby');
    if (babyScene === undefined) throw new Error('Missing exact baby-variant scene.');
    expect(expectedClientCaptureObservedFixture(representation, babyScene)).toMatchObject({
      strategy: 'native_entity',
      entity: {
        entityType: 'minecraft:wolf',
        variant: 'minecraft:woods',
        baby: true,
        equipment: {},
      },
    });
  });

  it('binds simulated entity poses to three exact static display-rig states', () => {
    const spec = parseModelSpec({ ...baseSpec, reviewProfile: 'entity_model' });
    const rigState = (translationX: number) => ({
      displayRig: {
        nodes: [
          {
            id: 'body',
            kind: 'block_display' as const,
            position: [0.5, 80, 5.5] as [number, number, number],
            yaw: 0,
            pitch: 0,
            transform: {
              translation: [translationX, 0, 0] as [number, number, number],
              leftRotation: [0, 0, 0] as [number, number, number],
              scale: [1, 1, 1] as [number, number, number],
              rightRotation: [0, 0, 0] as [number, number, number],
            },
            billboard: 'fixed' as const,
            brightness: { block: 15, sky: 15 },
            shadow: { radius: 0.5, strength: 1 },
            interpolation: { duration: 0, startDelta: 0 },
            blockState: { id: 'minecraft:stone', properties: {} },
          },
        ],
      },
    });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'entity',
      strategy: 'display_rig',
      capability: 'simulated',
      states: { attack: rigState(0.25), idle: rigState(0), walk: rigState(0.125) },
      review: {
        lowLight: false,
        animationTicks: [],
        poseStates: { idle: 'idle', walk: 'walk', attack: 'attack' },
      },
    });
    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      displaySettlingTicks: 2,
      representation,
    });
    expect(scenes.find((scene) => scene.id === 'entity_front')).toMatchObject({
      fixture: { stateId: 'idle', pose: 'idle', animationTick: 0 },
    });
    expect(scenes.find((scene) => scene.id === 'entity_pose_walk')).toMatchObject({
      fixture: { stateId: 'walk', pose: 'walk', animationTick: 0 },
    });
    expect(scenes.find((scene) => scene.id === 'entity_pose_attack')).toMatchObject({
      fixture: { stateId: 'attack', pose: 'attack', animationTick: 0 },
    });
    expect(scenes.some((scene) => scene.id.startsWith('entity_walk_sample_'))).toBe(false);
  });

  it('captures a strict static placeable rig with settling and optional hitbox QA', () => {
    const spec = parseModelSpec({
      ...baseSpec,
      reviewProfile: 'placeable',
      placeableReview: {
        orientations: ['north', 'east', 'south', 'west'],
        attachments: ['floor', 'wall', 'ceiling'],
        footprint: [16, 16],
      },
    });
    const representation = ClientCaptureRepresentationSchema.parse({
      targetKind: 'placeable',
      strategy: 'display_rig',
      capability: 'simulated',
      states: {
        default: {
          displayRig: {
            nodes: [
              {
                id: 'body',
                kind: 'block_display',
                position: [0, 1, 0],
                yaw: 0,
                pitch: 0,
                transform: {
                  translation: [0, 0, 0],
                  leftRotation: [0, 0, 0],
                  scale: [1, 1, 1],
                  rightRotation: [0, 0, 0],
                },
                billboard: 'fixed',
                brightness: { block: 15, sky: 15 },
                shadow: { radius: 0.5, strength: 1 },
                interpolation: { duration: 0, startDelta: 0 },
                blockState: { id: 'minecraft:oak_planks', properties: {} },
              },
            ],
            interaction: { position: [0, 1, 0], width: 1, height: 2, response: false },
          },
        },
        variant: {
          displayRig: {
            nodes: [
              {
                id: 'body',
                kind: 'block_display',
                position: [0, 1, 0],
                yaw: 0,
                pitch: 0,
                transform: {
                  translation: [0, 0, 0],
                  leftRotation: [0, 0, 0],
                  scale: [1, 1, 1],
                  rightRotation: [0, 0, 0],
                },
                billboard: 'fixed',
                brightness: { block: 15, sky: 15 },
                shadow: { radius: 0.5, strength: 1 },
                interpolation: { duration: 0, startDelta: 0 },
                blockState: { id: 'minecraft:glass', properties: {} },
              },
            ],
          },
        },
      },
      review: {
        orientations: ['north', 'east', 'south', 'west'],
        attachments: ['floor', 'wall', 'ceiling'],
        placementStates: ['north', 'east', 'south', 'west'].flatMap((orientation) =>
          ['floor', 'wall', 'ceiling'].map((attachment) => ({
            orientation,
            attachment,
            stateId: orientation === 'west' && attachment === 'floor' ? 'variant' : 'default',
          })),
        ),
      },
    });
    const scenes = createVisualClientCaptureScenes(spec, {
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
      includeDebugHitboxViews: true,
      displaySettlingTicks: 4,
    });
    const debug = scenes.filter((scene) => scene.viewKind === 'debug_hitbox_reference');

    expect(scenes.map((scene) => scene.id)).toEqual(
      expect.arrayContaining([
        'place_north_player_eye',
        'place_east_close',
        'place_floor_contact',
        'place_wall_contact',
        'place_ceiling_contact',
        'place_footprint_corner',
        'place_doorway',
        'place_range_near',
        'place_range_mid',
        'place_occluded',
      ]),
    );
    expect(
      scenes
        .filter((scene) => scene.viewKind !== 'measurement_control')
        .every((scene) => scene.settlingTicks === 4),
    ).toBe(true);
    expect(
      scenes.find((scene) => scene.id === 'measurement_control--place_floor_contact'),
    ).toMatchObject({
      requiredForAuthority: false,
      settlingTicks: 0,
      fixture: { kind: 'measurement_control', targetKind: 'placeable' },
    });
    expect(debug).toHaveLength(2);
    expect(debug.every((scene) => scene.fixture.kind === 'display_rig')).toBe(true);
    expect(debug.every((scene) => !scene.requiredForAuthority)).toBe(true);
    expect(scenes.find((scene) => scene.id === 'place_north_close')).toMatchObject({
      fixture: { orientation: 'north', distance: 'close' },
      cameraPose: { yaw: 45 },
    });
    expect(scenes.find((scene) => scene.id === 'place_east_close')).toMatchObject({
      fixture: { orientation: 'east', distance: 'close' },
      cameraPose: { yaw: 135 },
    });
    expect(scenes.find((scene) => scene.id === 'place_east_player_eye')).toMatchObject({
      cameraPose: { yaw: 90 },
    });
    expect(scenes.find((scene) => scene.id === 'place_state_variant')).toMatchObject({
      fixture: {
        stateId: 'variant',
        orientation: 'west',
        attachment: 'floor',
      },
    });
    expect(scenes.find((scene) => scene.id === 'place_footprint_corner')).toMatchObject({
      fixture: {
        context: 'corner',
        subjectPosition: { x: 0, y: 80, z: 5 },
      },
    });
    expect(scenes.find((scene) => scene.id === 'place_range_mid')?.cameraPose.z).toBe(-6.5);
    expect(
      scenes
        .find((scene) => scene.id === 'place_occluded')
        ?.measurementIntents.some(
          (intent) =>
            intent.metric === 'pairwise_pixel_delta' &&
            intent.requiredForReadiness &&
            intent.threshold?.comparison === 'below' &&
            intent.threshold.warning === 0.1 &&
            intent.threshold.failure === 0,
        ),
    ).toBe(true);

    const representationSha256 = computeClientCaptureRepresentationSha256(representation);
    const plan = createVisualClientCapturePlan({
      spec,
      width: 1280,
      height: 720,
      guiScale: 2,
      representation,
      includeDebugHitboxViews: true,
      displaySettlingTicks: 4,
      provenance: {
        projectId: 'placeable_fixture',
        runId: 'a'.repeat(64),
        revisionId: 'b'.repeat(64),
        specSha256: 'c'.repeat(64),
        compiledArtifactId: 'd'.repeat(64),
        proposalArtifactId: 'e'.repeat(64),
        projectManifestSha256: 'f'.repeat(64),
        datapackContentSha256: '0'.repeat(64),
        resourcepackContentSha256: '1'.repeat(64),
        runtimeManifestSha256: '2'.repeat(64),
        representation,
        representationSha256,
        client: { jarSha1: '3'.repeat(40), jarSha256: '4'.repeat(64) },
        captureMod: {
          id: 'packwright_capture',
          version: '0.5.0-dev',
          sha256: '5'.repeat(64),
        },
      },
      execution: {
        executionId: 'placeable-debug-pair',
        gameDirectory: '/private/tmp/packwright-placeable-debug',
        outputDirectory: '/private/tmp/packwright-placeable-debug/output',
      },
    });
    expect(() => parseClientCapturePlan(JSON.parse(JSON.stringify(plan)))).not.toThrow();
    const floorBase = plan.scenes.find((scene) => scene.id === 'place_floor_contact');
    const floorDebug = plan.scenes.find(
      (scene) => scene.id === 'debug_hitbox_reference--place_floor_contact',
    );
    expect(floorBase).toBeDefined();
    expect(floorBase?.comparisonSceneIds).toContain('measurement_control--place_floor_contact');
    expect(floorDebug).toMatchObject({
      requiredForAuthority: false,
      comparisonSceneIds: ['measurement_control--place_floor_contact', 'place_floor_contact'],
      fixture: { context: 'corner' },
    });
    expect(floorDebug?.fixture).toEqual(floorBase?.fixture);
    expect(floorDebug?.cameraPose).toEqual(floorBase?.cameraPose);
    expect(floorDebug?.measurementIntents[0]?.sourceSceneIds).toEqual([
      'debug_hitbox_reference--place_floor_contact',
      'measurement_control--place_floor_contact',
      'place_floor_contact',
    ]);
    expect(
      scenes.find((scene) => scene.id === 'measurement_control--place_range_mid'),
    ).toMatchObject({
      requiredForAuthority: false,
      comparisonSceneIds: ['place_range_mid'],
    });
    expect(
      scenes.find((scene) => scene.id === 'measurement_control--place_east_close'),
    ).toBeDefined();
    expect(
      scenes.find((scene) => scene.id === 'place_range_mid')?.measurementIntents[0]?.sourceSceneIds,
    ).toEqual(['place_range_mid', 'place_range_near']);
    expect(scenes.find((scene) => scene.id === 'place_occluded')?.measurementIntents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'm_place_occlusion',
          sourceSceneIds: [
            'measurement_control--place_range_mid',
            'place_occluded',
            'place_range_mid',
          ],
        }),
        expect.objectContaining({
          id: 'm_place_occlusion_delta',
          sourceSceneIds: ['place_occluded', 'place_range_mid'],
        }),
      ]),
    );
    expect(scenes.length).toBeLessThanOrEqual(64);
  });

  it('rejects unsupported native identities, executable rig fields, and settling overrides outside display rigs', () => {
    const supportedHeadwear = {
      targetKind: 'headwear',
      strategy: 'equippable_head',
      capability: 'replacement',
      states: {
        default: {
          itemStack: {
            itemId: 'minecraft:carved_pumpkin',
            count: 1,
            components: { 'minecraft:equippable': '{slot:"head"}' },
          },
        },
      },
      headwear: { renderMode: 'fallback_item' },
      review: { wideFov: false, armorStand: true, statePoses: { default: 'idle' } },
    } as const;
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        ...supportedHeadwear,
        review: { ...supportedHeadwear.review, armorStand: false },
      }),
    ).toThrow();
    const missingArmorStand = structuredClone(supportedHeadwear) as unknown as {
      review: Record<string, unknown>;
    };
    delete missingArmorStand.review.armorStand;
    expect(() => ClientCaptureRepresentationSchema.parse(missingArmorStand)).toThrow();

    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        targetKind: 'headwear',
        strategy: 'equippable_head',
        capability: 'replacement',
        states: {
          default: {
            itemStack: {
              itemId: 'minecraft:diamond_helmet',
              count: 1,
              components: { 'minecraft:equippable': '{slot:"head"}' },
            },
          },
        },
        headwear: { renderMode: 'equipment_model' },
        review: { wideFov: false, armorStand: true, statePoses: { default: 'idle' } },
      }),
    ).toThrow(/asset_id/u);
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        targetKind: 'headwear',
        strategy: 'equippable_head',
        capability: 'replacement',
        states: {
          default: {
            itemStack: {
              itemId: 'minecraft:carved_pumpkin',
              count: 1,
              components: {
                'minecraft:equippable': '{slot:"head",camera_overlay:"minecraft:misc/pumpkinblur"}',
              },
            },
          },
        },
        headwear: {
          renderMode: 'fallback_item',
          cameraOverlay: 'minecraft:misc/other_overlay',
        },
        review: { wideFov: false, armorStand: true, statePoses: { default: 'idle' } },
      }),
    ).toThrow(/cameraOverlay/u);
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        targetKind: 'entity',
        strategy: 'native_entity',
        capability: 'replacement',
        states: {
          default: {
            entity: {
              entityType: 'minecraft:wolf',
              baby: false,
              equipment: {},
            },
          },
        },
        review: { lowLight: false, animationTicks: [5] },
      }),
    ).toThrow(/exact data-driven capture variant/u);
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        targetKind: 'entity',
        strategy: 'native_entity',
        capability: 'replacement',
        states: {
          default: {
            entity: {
              entityType: 'minecraft:ender_dragon',
              baby: false,
              equipment: {},
            },
          },
        },
        review: { lowLight: false, animationTicks: [0, 5] },
      }),
    ).toThrow();
    const nativePlaceable = {
      targetKind: 'placeable',
      strategy: 'native_placeable_block',
      capability: 'replacement',
      states: {
        default: {
          blockState: { id: 'minecraft:oak_stairs', properties: { facing: 'north' } },
        },
      },
      review: {
        orientations: ['north', 'east', 'south', 'west'],
        attachments: ['floor'],
        placementStates: ['north', 'east', 'south', 'west'].map((orientation) => ({
          orientation,
          attachment: 'floor',
          stateId: 'default',
        })),
      },
    };
    expect(() => ClientCaptureRepresentationSchema.parse(nativePlaceable)).toThrow(
      /facing property/u,
    );
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        ...nativePlaceable,
        review: {
          ...nativePlaceable.review,
          attachments: ['floor', 'wall'],
          placementStates: ['north', 'east', 'south', 'west'].flatMap((orientation) =>
            ['floor', 'wall'].map((attachment) => ({
              orientation,
              attachment,
              stateId: 'default',
            })),
          ),
        },
      }),
    ).toThrow(/floor attachment only/u);
    expect(() =>
      ClientCaptureRepresentationSchema.parse({
        targetKind: 'placeable',
        strategy: 'display_rig',
        capability: 'simulated',
        states: {
          default: {
            displayRig: {
              nodes: [],
              function: 'minecraft:op @a',
            },
          },
        },
        review: {
          orientations: ['north'],
          attachments: ['floor'],
          placementStates: [{ orientation: 'north', attachment: 'floor', stateId: 'default' }],
        },
      }),
    ).toThrow();
    const blockSpec = parseModelSpec({ ...baseSpec, reviewProfile: 'block' });
    const block = ClientCaptureRepresentationSchema.parse({
      targetKind: 'block',
      strategy: 'native_block_state',
      capability: 'replacement',
      states: { default: { blockState: { id: 'minecraft:stone', properties: {} } } },
      review: { transparency: false, biomeTintBiomes: [], animatedTextureTicks: [] },
    });
    expect(() =>
      createVisualClientCaptureScenes(blockSpec, {
        width: 1280,
        height: 720,
        guiScale: 2,
        representation: block,
        displaySettlingTicks: 2,
      }),
    ).toThrow(/only valid.*display_rig/u);
    expect(() =>
      createVisualClientCaptureScenes(blockSpec, {
        width: 1280,
        height: 720,
        guiScale: 2,
        representation: block,
        includeScaleReferenceViews: true,
      }),
    ).toThrow(/only for held_item/u);
    expect(() =>
      createVisualClientCaptureScenes(blockSpec, {
        width: 1280,
        height: 720,
        guiScale: 2,
        representation: block,
        includeDebugHitboxViews: true,
      }),
    ).toThrow(/not supported for 'block'/u);
  });
});
