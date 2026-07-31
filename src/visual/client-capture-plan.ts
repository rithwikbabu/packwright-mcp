import {
  CLIENT_CAPTURE_PACK_ACTIVATION,
  ClientCaptureRepresentationSchema,
  type ClientCaptureMeasurementIntentSchema,
  ClientCaptureSceneSchema,
  ClientCaptureStudioSchema,
  computeClientCaptureRepresentationSha256,
  type ClientCaptureExecution,
  type ClientCaptureItemStack,
  type ClientCaptureMeasurementMetricSchema,
  type ClientCapturePlan,
  type ClientCaptureProvenance,
  type ClientCaptureRepresentation,
  type ClientCaptureScene,
  type ClientCaptureStudio,
  createClientCapturePlan,
} from '../minecraft/client-capture-protocol.js';
import type { z } from 'zod/v4';
import type { ItemBindingProposal } from './compiler.js';
import type { ModelSpec } from './model-spec.js';
import {
  assertClientCaptureReviewSupport,
  assertClientCaptureStrategySupport,
} from './client-capture-support.js';
import { resolveReviewProfile, type ReviewSceneDefinition } from './review-profile.js';

type ClientMeasurementMetric = z.infer<typeof ClientCaptureMeasurementMetricSchema>;
type DisplayRigRepresentation = Extract<ClientCaptureRepresentation, { strategy: 'display_rig' }>;
type EntityRepresentation =
  | Extract<ClientCaptureRepresentation, { strategy: 'native_entity' }>
  | (DisplayRigRepresentation & { readonly targetKind: 'entity' });
type PlaceableRepresentation =
  | Extract<
      ClientCaptureRepresentation,
      { strategy: 'native_placeable_block' | 'native_placeable_entity' }
    >
  | (DisplayRigRepresentation & { readonly targetKind: 'placeable' });

export interface ClientCaptureSceneOptions {
  readonly width: number;
  readonly height: number;
  readonly guiScale: number;
  readonly includeScaleReferenceViews?: boolean | undefined;
  readonly includeDebugHitboxViews?: boolean | undefined;
  readonly displaySettlingTicks?: number | undefined;
  readonly representation?: ClientCaptureRepresentation | undefined;
}

type ExactPlanProvenance = Omit<ClientCaptureProvenance, 'packActivation'>;

type LegacyPlanProvenance = Omit<
  ClientCaptureProvenance,
  'representation' | 'representationSha256' | 'packActivation'
> & {
  readonly itemStack: ClientCaptureItemStack;
};

export interface CreateVisualClientCapturePlanInput extends ClientCaptureSceneOptions {
  readonly spec: ModelSpec;
  readonly provenance: ExactPlanProvenance | LegacyPlanProvenance;
  readonly execution: ClientCaptureExecution;
  readonly studio?: ClientCaptureStudio | undefined;
}

export const DEFAULT_CLIENT_CAPTURE_STUDIO: ClientCaptureStudio = Object.freeze({
  preset: 'void_matte',
  rendererBackend: 'opengl',
  renderDistance: 8,
  simulationDistance: 5,
  graphicsMode: 'custom',
  clouds: 'off',
  particles: 'minimal',
  entityShadows: true,
  viewBobbing: false,
  debugUi: false,
  floorBlock: { id: 'minecraft:smooth_stone', properties: {} },
  backdropBlock: { id: 'minecraft:light_gray_concrete', properties: {} },
  scaleReference: {
    kind: 'ordinary_block_floor_ruler',
    origin: { x: -2, y: 79, z: 7 },
    lengthBlocks: 2,
    firstBlock: { id: 'minecraft:black_concrete', properties: {} },
    secondBlock: { id: 'minecraft:white_concrete', properties: {} },
  } as const,
});

/** Convert the semantic item binding into Minecraft's bounded command-component literals. */
export function clientCaptureComponentLiterals(
  binding: ItemBindingProposal,
): Readonly<Record<'minecraft:item_model', string>> {
  return Object.freeze({
    'minecraft:item_model': JSON.stringify(binding.itemStack.components['minecraft:item_model']),
  });
}

function defaultItemRepresentation(spec: ModelSpec): ClientCaptureRepresentation {
  const itemModelId = spec.id;
  return ClientCaptureRepresentationSchema.parse({
    targetKind: spec.reviewProfile === 'gui_item' ? 'gui_item' : 'held_item',
    strategy: 'item_stack',
    capability: 'native',
    states: {
      default: {
        itemStack: {
          itemId: spec.connection?.carrierItem ?? 'minecraft:stick',
          count: 1,
          components: { 'minecraft:item_model': JSON.stringify(itemModelId) },
        },
      },
    },
  });
}

function representationForScenes(
  spec: ModelSpec,
  representation: ClientCaptureRepresentation | undefined,
): ClientCaptureRepresentation {
  if (representation !== undefined) return ClientCaptureRepresentationSchema.parse(representation);
  if (spec.reviewProfile === 'held_item' || spec.reviewProfile === 'gui_item') {
    return defaultItemRepresentation(spec);
  }
  throw new Error(
    `Review profile '${spec.reviewProfile}' requires an exact protocol-v3 client representation before Minecraft can launch.`,
  );
}

function expectedTargetForProfile(
  profile: ModelSpec['reviewProfile'],
): ClientCaptureRepresentation['targetKind'] | undefined {
  switch (profile) {
    case 'held_item':
      return 'held_item';
    case 'gui_item':
      return 'gui_item';
    case 'block':
      return 'block';
    case 'head_wearable':
      return 'headwear';
    case 'entity_model':
      return 'entity';
    case 'placeable':
      return 'placeable';
    default:
      return undefined;
  }
}

export function assertClientCaptureRepresentationForProfile(
  spec: ModelSpec,
  representation: ClientCaptureRepresentation,
): void {
  const expected = expectedTargetForProfile(spec.reviewProfile);
  if (expected === undefined) {
    throw new Error(
      `Review profile '${spec.reviewProfile}' is not implemented by protocol-v3 client capture.`,
    );
  }
  if (representation.targetKind !== expected) {
    throw new Error(
      `Review profile '${spec.reviewProfile}' requires target '${expected}', but representation '${representation.strategy}' targets '${representation.targetKind}'.`,
    );
  }
  assertClientCaptureStrategySupport(spec.reviewProfile, representation.strategy);
}

function cameraForReviewScene(scene: ReviewSceneDefinition): ClientCaptureScene['camera'] {
  if (
    scene.category === 'first_person' ||
    (scene.category === 'conditional' && scene.referenceRig?.includeBody === false)
  ) {
    return 'first_person';
  }
  if (scene.category === 'third_person') {
    return scene.id.includes('front') ? 'third_person_front' : 'third_person_back';
  }
  return 'neutral';
}

function contextForReviewScene(scene: ReviewSceneDefinition): ClientCaptureScene['context'] {
  if (scene.category === 'inventory' || scene.category === 'overlay') return 'inventory';
  if (scene.category === 'hotbar' || scene.id.includes('hotbar')) return 'hotbar';
  if (scene.category === 'tooltip') return 'tooltip';
  if (scene.category === 'neutral') return 'item_inspection';
  return 'world';
}

function animationForReviewScene(
  spec: ModelSpec,
  scene: ReviewSceneDefinition,
): ClientCaptureScene['animationState'] {
  if (scene.id.includes('swing')) return 'swing';
  if (scene.id.includes('aim')) return spec.heldItem?.usePose === 'aim' ? 'aim' : 'idle';
  if (scene.id.includes('active_use')) return spec.heldItem?.usePose === 'aim' ? 'aim' : 'use';
  return 'idle';
}

function presentationForReviewScene(
  spec: ModelSpec,
  scene: ReviewSceneDefinition,
  viewKind: ClientCaptureScene['viewKind'],
): ClientCaptureScene['presentation'] {
  if (viewKind === 'first_person_scale_reference') {
    return { referenceArm: true, referenceArmPurpose: 'scale_only' };
  }
  if (spec.reviewProfile !== 'gui_item') return undefined;
  const count = /^gui_count_(?<count>[1-9][0-9]?)$/u.exec(scene.id)?.groups?.count;
  if (count !== undefined) return { stackCount: Number.parseInt(count, 10) };
  if (scene.id === 'gui_hotbar_selected') return { selectedHotbar: true };
  if (scene.id === 'gui_glint') return { showGlint: true };
  if (scene.id === 'gui_durability') return { durabilityFraction: 0.5 };
  return undefined;
}

function firstStateId(representation: ClientCaptureRepresentation): string {
  const id = Object.keys(representation.states)[0];
  if (id === undefined) throw new Error('Capture representation has no state.');
  return id;
}

function measurement(
  id: string,
  metric: ClientMeasurementMetric,
  unit: 'percent' | 'pixels' | 'ratio' | 'count' | 'dot',
  sourceSceneIds?: readonly string[],
  requiredForReadiness = false,
): z.input<typeof ClientCaptureMeasurementIntentSchema> {
  const calibratedThresholds: Partial<
    Record<
      ClientMeasurementMetric,
      Readonly<{ comparison: 'above' | 'below'; warning: number; failure: number }>
    >
  > = {
    pairwise_pixel_delta: { comparison: 'below', warning: 0.1, failure: 0 },
    animation_stability: { comparison: 'below', warning: 0.1, failure: 0 },
    frame_retention: { comparison: 'below', warning: 98, failure: 85 },
    lighting_separation: { comparison: 'below', warning: 8, failure: 3 },
    unexpected_culling: { comparison: 'above', warning: 0, failure: 1 },
    head_penetration: { comparison: 'above', warning: 10, failure: 35 },
    self_intersection: { comparison: 'above', warning: 5, failure: 25 },
    first_person_obstruction: { comparison: 'above', warning: 15, failure: 30 },
    player_scale: { comparison: 'above', warning: 0.1, failure: 0.25 },
    texture_variant_resolution: { comparison: 'below', warning: 0.1, failure: 0 },
    hitbox_containment: { comparison: 'below', warning: 95, failure: 80 },
    hitbox_empty_space: { comparison: 'above', warning: 40, failure: 70 },
    orientation_alignment: { comparison: 'below', warning: 0.98, failure: 0.9 },
    billboard_correctness: { comparison: 'below', warning: 0.98, failure: 0.9 },
  };
  const threshold = calibratedThresholds[metric];
  return {
    id,
    metric,
    authority: 'client_pixels',
    unit,
    requiredForReadiness,
    ...(threshold === undefined ? {} : { threshold }),
    ...(sourceSceneIds === undefined ? {} : { sourceSceneIds: [...sourceSceneIds].sort() }),
  };
}

interface SceneDescriptor {
  readonly id: string;
  readonly viewKind?: ClientCaptureScene['viewKind'];
  readonly camera?: ClientCaptureScene['camera'];
  readonly context?: ClientCaptureScene['context'];
  readonly hand?: ClientCaptureScene['hand'];
  readonly playerModel?: ClientCaptureScene['playerModel'];
  readonly fov?: number;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly cameraDistance?: number;
  readonly cameraPosition?: Readonly<{ x: number; y: number; z: number }>;
  readonly expectedRenderCameraPosition?: Readonly<{ x: number; y: number; z: number }>;
  readonly expectedRenderCameraYaw?: number;
  readonly expectedRenderCameraPitch?: number;
  readonly lowLight?: boolean;
  readonly biome?: string;
  readonly animationState?: ClientCaptureScene['animationState'];
  readonly frame?: number;
  readonly fixture: ClientCaptureScene['fixture'];
  readonly measurements?: readonly z.input<typeof ClientCaptureMeasurementIntentSchema>[];
  readonly comparisonSceneIds?: readonly string[];
  readonly presentation?: ClientCaptureScene['presentation'];
}

function vanillaSelfRenderCameraPose(
  camera: ClientCaptureScene['camera'],
  anchor: Readonly<{ x: number; y: number; z: number; yaw: number; pitch: number }>,
): ClientCaptureScene['expectedRenderCameraPose'] {
  const eye = { x: anchor.x, y: anchor.y + 1.62, z: anchor.z };
  if (camera === 'first_person' || camera === 'neutral') {
    return { ...eye, yaw: anchor.yaw, pitch: anchor.pitch };
  }
  const reverse = camera === 'third_person_front';
  const yaw = reverse ? anchor.yaw + 180 : anchor.yaw;
  const pitch = reverse ? -anchor.pitch : anchor.pitch;
  const yawRadians = (yaw * Math.PI) / 180;
  const pitchRadians = (pitch * Math.PI) / 180;
  const forward = {
    x: -Math.sin(yawRadians) * Math.cos(pitchRadians),
    y: -Math.sin(pitchRadians),
    z: Math.cos(yawRadians) * Math.cos(pitchRadians),
  };
  return {
    x: eye.x - forward.x * 4,
    y: eye.y - forward.y * 4,
    z: eye.z - forward.z * 4,
    yaw,
    pitch,
  };
}

function lowerDescriptor(
  representation: ClientCaptureRepresentation,
  options: ClientCaptureSceneOptions,
  descriptor: SceneDescriptor,
): ClientCaptureScene {
  const viewKind = descriptor.viewKind ?? 'minecraft_vanilla';
  const baseSceneId = descriptor.id;
  const id = viewKind === 'minecraft_vanilla' ? baseSceneId : `${viewKind}--${baseSceneId}`;
  const fov = descriptor.fov ?? 70;
  const yaw = descriptor.yaw ?? 0;
  // Minecraft's canonical studio subject is centered at (0.5, 81, 5.5). Player
  // yaw 0 faces +Z and positive pitch looks down. cameraPose is an explicit
  // local-player feet anchor; expectedRenderCameraPose is the framebuffer camera.
  const pitch = descriptor.pitch ?? 14;
  const lowLight = descriptor.lowLight === true;
  const presentation = descriptor.presentation;
  const camera = descriptor.camera ?? 'neutral';
  const context = descriptor.context ?? 'world';
  const displayBased =
    representation.strategy === 'display_rig' || representation.strategy === 'block_display';
  const yawRadians = (yaw * Math.PI) / 180;
  const orbitsStudioSubject = camera === 'neutral' && context === 'world';
  const cameraDistance = descriptor.cameraDistance ?? 5;
  const cameraX =
    descriptor.cameraPosition?.x ??
    (orbitsStudioSubject ? 0.5 + Math.sin(yawRadians) * cameraDistance : 0.5);
  const cameraY = descriptor.cameraPosition?.y ?? 82.25;
  const cameraZ =
    descriptor.cameraPosition?.z ??
    (orbitsStudioSubject ? 5.5 - Math.cos(yawRadians) * cameraDistance : 0.5);
  const playerFeetAnchor = { x: cameraX, y: cameraY, z: cameraZ, yaw, pitch };
  const usesVanillaSelfCamera =
    (representation.targetKind === 'held_item' || representation.targetKind === 'gui_item') &&
    context === 'world';
  const expectedRenderCameraPose =
    descriptor.expectedRenderCameraPosition === undefined
      ? usesVanillaSelfCamera
        ? vanillaSelfRenderCameraPose(camera, playerFeetAnchor)
        : playerFeetAnchor
      : {
          ...descriptor.expectedRenderCameraPosition,
          yaw: descriptor.expectedRenderCameraYaw ?? yaw,
          pitch: descriptor.expectedRenderCameraPitch ?? pitch,
        };
  if (
    options.displaySettlingTicks !== undefined &&
    (!Number.isSafeInteger(options.displaySettlingTicks) ||
      options.displaySettlingTicks < 2 ||
      options.displaySettlingTicks > 40)
  ) {
    throw new Error('Display settling ticks must be an integer from 2 through 40.');
  }
  if (options.displaySettlingTicks !== undefined && !displayBased) {
    throw new Error(
      'Display settling ticks are only valid for strict block_display or display_rig representations.',
    );
  }
  return ClientCaptureSceneSchema.parse({
    id,
    baseSceneId,
    targetKind: representation.targetKind,
    representationSha256: computeClientCaptureRepresentationSha256(representation),
    viewKind,
    requiredForAuthority:
      viewKind !== 'first_person_scale_reference' &&
      viewKind !== 'debug_hitbox_reference' &&
      viewKind !== 'comparison_reference' &&
      viewKind !== 'world_scale_reference' &&
      viewKind !== 'measurement_control',
    camera,
    context,
    hand: descriptor.hand ?? 'right',
    playerModel: descriptor.playerModel ?? 'steve',
    fov,
    resolution: { width: options.width, height: options.height },
    guiScale: options.guiScale,
    animationState: descriptor.animationState ?? 'idle',
    frame: descriptor.frame ?? 0,
    cameraPoseSemantics: 'player_feet_anchor',
    cameraPose: playerFeetAnchor,
    expectedRenderCameraPose,
    environment: {
      biome: descriptor.biome ?? 'minecraft:plains',
      time: lowLight ? 18000 : 6000,
      weather: 'clear',
      lightProfile: lowLight ? 'low' : 'day',
      skyLight: 15,
      blockLight: lowLight ? 4 : 0,
      lightSource: {
        level: lowLight ? 11 : 0,
        offset: { x: 0, y: 5, z: -2 },
      },
    },
    settlingTicks: displayBased ? (options.displaySettlingTicks ?? 2) : 0,
    fixture: descriptor.fixture,
    measurementIntents: [...(descriptor.measurements ?? [])].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    comparisonSceneIds: [...(descriptor.comparisonSceneIds ?? [])].sort(),
    ...(presentation === undefined ? {} : { presentation }),
  });
}

function withMeasurementControl(
  scenes: readonly ClientCaptureScene[],
  baseSceneId: string,
): readonly ClientCaptureScene[] {
  const base = scenes.find((scene) => scene.id === baseSceneId && scene.requiredForAuthority);
  if (base === undefined) {
    throw new Error(`Measurement control has no authoritative '${baseSceneId}' scene.`);
  }
  if (!['block', 'headwear', 'entity', 'placeable'].includes(base.targetKind)) {
    throw new Error(`Target '${base.targetKind}' does not use empty-subject measurement controls.`);
  }
  const controlId = `measurement_control--${base.baseSceneId}`;
  const boundBase = ClientCaptureSceneSchema.parse({
    ...base,
    comparisonSceneIds: [...new Set([...base.comparisonSceneIds, controlId])].sort(),
  });
  const candidate: Record<string, unknown> = {
    ...boundBase,
    id: controlId,
    viewKind: 'measurement_control',
    requiredForAuthority: false,
    settlingTicks: 0,
    fixture: {
      kind: 'measurement_control',
      targetKind: base.targetKind,
      stateId: base.fixture.stateId,
      control: 'empty_subject',
    },
    measurementIntents: [
      measurement(`m_${base.baseSceneId}_foreground_control`, 'pairwise_pixel_delta', 'percent', [
        boundBase.id,
        controlId,
      ]),
    ],
    comparisonSceneIds: [boundBase.id],
  };
  delete candidate.presentation;
  return [
    ...scenes.map((scene) => (scene.id === boundBase.id ? boundBase : scene)),
    ClientCaptureSceneSchema.parse(candidate),
  ];
}

function withMeasurementControls(
  scenes: readonly ClientCaptureScene[],
  baseSceneIds: readonly string[],
): readonly ClientCaptureScene[] {
  return baseSceneIds.reduce<readonly ClientCaptureScene[]>(
    (current, baseSceneId) => withMeasurementControl(current, baseSceneId),
    scenes,
  );
}

function itemScenes(
  spec: ModelSpec,
  representation: ClientCaptureRepresentation,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  if (spec.reviewProfile === 'held_item' && spec.heldItem?.secondaryGrip !== undefined) {
    throw new Error(
      'Official-client capture for two-handed held items is not yet authoritative because the capture mod does not pose and verify the gameplay hand at secondaryGrip.',
    );
  }
  const stateId = firstStateId(representation);
  const reviewPlan = resolveReviewProfile(spec, 128);
  return reviewPlan.scenes.flatMap((scene) => {
    const camera = cameraForReviewScene(scene);
    const context = contextForReviewScene(scene);
    const firstPersonWorld = camera === 'first_person' && context === 'world';
    const kinds: readonly ClientCaptureScene['viewKind'][] = firstPersonWorld
      ? options.includeScaleReferenceViews === true
        ? ['first_person_vanilla', 'first_person_scale_reference']
        : ['first_person_vanilla']
      : ['minecraft_vanilla'];
    return kinds.map((viewKind) => {
      const fov =
        scene.camera.kind === 'perspective'
          ? Math.max(30, Math.min(120, Math.round(scene.camera.verticalFovDegrees)))
          : 70;
      const guiScale =
        spec.reviewProfile === 'gui_item' && scene.id === 'gui_inventory_32'
          ? 2
          : spec.reviewProfile === 'gui_item' && scene.id === 'gui_inventory_64'
            ? 4
            : options.guiScale;
      return lowerDescriptor(
        representation,
        { ...options, guiScale },
        {
          id: scene.id,
          viewKind,
          camera,
          context,
          hand: scene.hand ?? 'right',
          playerModel: scene.referenceRig?.variant ?? 'steve',
          fov,
          yaw: scene.camera.yaw,
          pitch: -scene.camera.pitch,
          animationState: animationForReviewScene(spec, scene),
          frame: scene.id.includes('swing') ? 4 : scene.id.includes('active_use') ? 10 : 0,
          fixture: { kind: 'item_stack', stateId },
          measurements:
            viewKind === 'first_person_scale_reference'
              ? []
              : [measurement(`m_${scene.id}_frame`, 'frame_retention', 'percent')],
          presentation: presentationForReviewScene(spec, scene, viewKind),
        },
      );
    });
  });
}

function blockScenes(
  representation: Extract<ClientCaptureRepresentation, { targetKind: 'block' }>,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  const stateIds = Object.keys(representation.states);
  const stateId = firstStateId(representation);
  const kind = representation.strategy;
  const fixture = (
    layout:
      | 'single'
      | 'adjacency'
      | 'culling'
      | 'inventory'
      | 'transparency_light'
      | 'transparency_dark'
      | 'transparency_overlap',
    orientation: 'north' | 'south' | 'east' | 'west' | 'up' | 'down' | 'three_quarter',
    selectedState = stateId,
    animationTick = 0,
    blockPosition: Readonly<{ x: number; y: number; z: number }> = { x: 0, y: 80, z: 5 },
    backdrop: 'studio' | 'light' | 'dark' = 'studio',
    overlapCopies: 1 | 2 = 1,
  ): ClientCaptureScene['fixture'] => ({
    kind,
    stateId: selectedState,
    layout,
    orientation,
    animationTick,
    blockPosition,
    backdrop,
    overlapCopies,
  });
  const descriptors: SceneDescriptor[] = [
    {
      id: 'block_hero',
      yaw: 45,
      fixture: fixture('single', 'three_quarter'),
      measurements: [measurement('m_block_hero_frame', 'frame_retention', 'percent')],
    },
    ...(
      [
        ['north', 0, 14, undefined],
        ['south', 180, 14, undefined],
        ['east', 90, 14, undefined],
        ['west', -90, 14, undefined],
        ['up', 0, 90, { x: 0.5, y: 86.5, z: 5.5 }],
        ['down', 0, -90, { x: 0.5, y: 82.25, z: 5.5 }],
      ] as const
    ).map(([face, yaw, pitch, cameraPosition]) => ({
      id: `block_face_${face}`,
      yaw,
      pitch,
      ...(cameraPosition === undefined ? {} : { cameraPosition }),
      fixture: fixture(
        'single',
        face,
        stateId,
        0,
        face === 'down' ? { x: 0, y: 84, z: 5 } : { x: 0, y: 80, z: 5 },
      ),
      measurements: [
        measurement(`m_block_${face}_frame`, 'frame_retention', 'percent'),
        measurement(`m_block_${face}_visible`, 'visible_faces', 'count'),
      ],
    })),
    {
      id: 'block_adjacency',
      yaw: 45,
      fixture: fixture('adjacency', 'three_quarter'),
      measurements: [measurement('m_block_adjacency', 'adjacency_seam', 'pixels')],
    },
    {
      id: 'block_culling',
      yaw: 45,
      fixture: fixture('culling', 'three_quarter'),
      measurements: [measurement('m_block_culling', 'unexpected_culling', 'count')],
    },
    {
      id: 'block_light_day',
      fixture: fixture('single', 'three_quarter'),
      measurements: [],
    },
    {
      id: 'block_light_low',
      lowLight: true,
      fixture: fixture('single', 'three_quarter'),
      comparisonSceneIds: ['block_light_day'],
      measurements: [
        measurement('m_block_lighting_delta', 'pairwise_pixel_delta', 'percent', undefined, true),
        measurement('m_block_lighting_sep', 'lighting_separation', 'percent', undefined, true),
      ],
    },
  ];
  if (representation.review.inventoryItemStack !== undefined) {
    descriptors.push({
      id: 'block_inventory',
      context: 'inventory',
      fixture: fixture('inventory', 'three_quarter'),
      measurements: [measurement('m_block_inventory', 'frame_retention', 'percent')],
    });
  }
  if (representation.review.transparency) {
    descriptors.push(
      {
        id: 'block_transparency_light',
        fixture: fixture(
          'transparency_light',
          'three_quarter',
          stateId,
          0,
          { x: 0, y: 80, z: 5 },
          'light',
          1,
        ),
        measurements: [
          measurement('m_block_transparency_light', 'alpha_order_artifacts', 'percent'),
        ],
      },
      {
        id: 'block_transparency_dark',
        fixture: fixture(
          'transparency_dark',
          'three_quarter',
          stateId,
          0,
          { x: 0, y: 80, z: 5 },
          'dark',
          1,
        ),
        comparisonSceneIds: ['block_transparency_light'],
        measurements: [
          measurement('m_block_transparency_dark', 'alpha_order_artifacts', 'percent'),
        ],
      },
      {
        id: 'block_transparency_overlap',
        fixture: fixture(
          'transparency_overlap',
          'three_quarter',
          stateId,
          0,
          { x: 0, y: 80, z: 5 },
          'light',
          2,
        ),
        comparisonSceneIds: ['block_transparency_light'],
        measurements: [
          measurement('m_block_transparency_overlap', 'alpha_order_artifacts', 'percent'),
        ],
      },
    );
  }
  for (const [index, biome] of representation.review.biomeTintBiomes.entries()) {
    descriptors.push({
      id: `block_biome_${String(index)}`,
      biome,
      fixture: fixture('single', 'three_quarter'),
      comparisonSceneIds: ['block_hero'],
      measurements: [
        measurement(
          `m_block_biome_${String(index)}`,
          'pairwise_pixel_delta',
          'percent',
          undefined,
          biome !== 'minecraft:plains',
        ),
      ],
    });
  }
  for (const [index, animationTick] of representation.review.animatedTextureTicks.entries()) {
    descriptors.push({
      id: `block_animation_${String(index)}`,
      fixture: fixture('single', 'three_quarter', stateId, animationTick),
      comparisonSceneIds: index === 0 ? [] : ['block_animation_0'],
      measurements:
        index === 0
          ? []
          : [measurement(`m_block_animation_${String(index)}`, 'animation_stability', 'percent')],
    });
  }
  for (const extraState of stateIds.slice(1)) {
    descriptors.push({
      id: `block_state_${extraState}`,
      fixture: fixture('single', 'three_quarter', extraState),
      comparisonSceneIds: ['block_hero'],
      measurements: [
        measurement(`m_block_state_${extraState}`, 'pairwise_pixel_delta', 'percent', undefined),
      ],
    });
  }
  return withMeasurementControl(
    descriptors.map((descriptor) => lowerDescriptor(representation, options, descriptor)),
    'block_hero',
  );
}

function headwearScenes(
  representation: Extract<ClientCaptureRepresentation, { targetKind: 'headwear' }>,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  const stateIds = Object.keys(representation.states);
  const stateId = firstStateId(representation);
  const fixture = (
    subject: 'player' | 'armor_stand' | 'bare_control',
    framing: 'head' | 'full_body' | 'first_person',
    pose: 'idle' | 'walk' | 'crouch' | 'swim' | 'glide' = 'idle',
    selectedState = stateId,
    viewAngle: 'front' | 'side' | 'rear' = 'front',
    chestArmor = false,
  ): ClientCaptureScene['fixture'] => ({
    kind: 'equippable_head',
    stateId: selectedState,
    subject,
    framing,
    pose,
    subjectYaw: 0,
    viewAngle,
    cameraDistance: framing === 'head' ? 2.25 : framing === 'full_body' ? 6 : 0,
    chestArmor,
  });
  const descriptors: SceneDescriptor[] = [];
  for (const playerModel of ['steve', 'alex'] as const) {
    for (const [angle, yaw] of [
      ['front', 0],
      ['side', -90],
      ['rear', 0],
    ] as const) {
      for (const framing of ['head', 'full_body'] as const) {
        const id = `head_${playerModel}_${angle}_${framing === 'head' ? 'close' : 'full'}`;
        descriptors.push({
          id,
          playerModel,
          yaw,
          camera: angle === 'front' ? 'third_person_front' : 'third_person_back',
          fixture: fixture('player', framing, 'idle', stateId, angle),
          measurements: [
            measurement(
              `m_${id}_fit`,
              angle === 'front' ? 'face_eye_clearance' : 'head_penetration',
              'pixels',
            ),
            measurement(`m_${id}_frame`, 'frame_retention', 'percent'),
          ],
        });
      }
    }
    descriptors.push({
      id: `head_bare_${playerModel}`,
      viewKind: 'comparison_reference',
      playerModel,
      camera: 'third_person_front',
      fixture: fixture('bare_control', 'head'),
      measurements: [measurement(`m_head_bare_${playerModel}`, 'variant_fit_delta', 'pixels')],
      comparisonSceneIds: [`head_${playerModel}_front_close`],
    });
  }
  if (representation.review.chestArmorItemStack !== undefined) {
    for (const playerModel of ['steve', 'alex'] as const) {
      descriptors.push({
        id: `head_chest_${playerModel}`,
        playerModel,
        camera: 'third_person_front',
        fixture: fixture('player', 'full_body', 'idle', stateId, 'front', true),
        comparisonSceneIds: [`head_${playerModel}_front_full`],
        measurements: [
          measurement(
            `m_head_chest_${playerModel}_delta`,
            'pairwise_pixel_delta',
            'percent',
            undefined,
            true,
          ),
          measurement(`m_head_chest_${playerModel}_intersection`, 'self_intersection', 'percent'),
        ],
      });
    }
  }
  descriptors.push({
    id: 'head_first_person',
    viewKind: 'first_person_vanilla',
    camera: 'first_person',
    fov: 70,
    fixture: fixture('player', 'first_person'),
    measurements: [
      measurement('m_head_fp_obstruction', 'first_person_obstruction', 'percent', [
        'first_person_vanilla--head_first_person',
        'measurement_control--head_first_person',
      ]),
    ],
  });
  if (representation.review.wideFov) {
    descriptors.push({
      id: 'head_first_person_wide',
      viewKind: 'first_person_vanilla',
      camera: 'first_person',
      fov: 100,
      fixture: fixture('player', 'first_person'),
      measurements: [
        measurement('m_head_fp_wide', 'first_person_obstruction', 'percent', [
          'first_person_vanilla--head_first_person_wide',
          'measurement_control--head_first_person_wide',
        ]),
      ],
    });
  }
  descriptors.push(
    {
      id: 'head_stand_front',
      camera: 'neutral',
      fixture: fixture('armor_stand', 'full_body', 'idle', stateId, 'front'),
      measurements: [measurement('m_head_stand_front', 'armor_stand_alignment', 'pixels')],
    },
    {
      id: 'head_stand_side',
      camera: 'neutral',
      fixture: fixture('armor_stand', 'full_body', 'idle', stateId, 'side'),
      measurements: [measurement('m_head_stand_side', 'armor_stand_alignment', 'pixels')],
    },
  );
  if (representation.headwear.cameraOverlay !== undefined) {
    descriptors.push({
      id: 'head_camera_overlay',
      viewKind: 'first_person_vanilla',
      camera: 'first_person',
      fov: 70,
      fixture: fixture('player', 'first_person'),
      measurements: [
        measurement('m_head_overlay', 'overlay_coverage', 'percent', [
          'first_person_vanilla--head_camera_overlay',
          'measurement_control--head_camera_overlay',
        ]),
      ],
    });
  }
  for (const extraState of stateIds.slice(1)) {
    const pose = representation.review.statePoses[extraState];
    if (pose === undefined)
      throw new Error(`Headwear state '${extraState}' has no declared review pose.`);
    descriptors.push({
      id: `head_state_${extraState}`,
      camera: 'third_person_front',
      fixture: fixture('player', 'full_body', pose, extraState),
      comparisonSceneIds: ['head_steve_front_full'],
      measurements: [
        measurement(`m_head_state_${extraState}`, 'pairwise_pixel_delta', 'percent', undefined),
      ],
    });
  }
  const scenes = descriptors.map((descriptor) => {
    const fixture = descriptor.fixture;
    if (fixture.kind !== 'equippable_head') {
      throw new Error('Headwear scene lowered with a non-headwear fixture.');
    }
    const playerFeet = { x: 0.5, y: 80, z: 5.5 };
    if (fixture.framing === 'first_person') {
      return lowerDescriptor(representation, options, {
        ...descriptor,
        yaw: 0,
        pitch: 0,
        cameraPosition: playerFeet,
        expectedRenderCameraPosition: { x: 0.5, y: 81.62, z: 5.5 },
        expectedRenderCameraYaw: 0,
        expectedRenderCameraPitch: 0,
      });
    }
    const targetY = fixture.framing === 'head' ? 81.62 : 80.95;
    const distance = fixture.cameraDistance;
    const renderCamera =
      fixture.viewAngle === 'front'
        ? { x: 0.5, y: targetY, z: 5.5 + distance, yaw: 180 }
        : fixture.viewAngle === 'rear'
          ? { x: 0.5, y: targetY, z: 5.5 - distance, yaw: 0 }
          : { x: 0.5 - distance, y: targetY, z: 5.5, yaw: -90 };
    return lowerDescriptor(representation, options, {
      ...descriptor,
      yaw: 0,
      pitch: 0,
      cameraPosition: playerFeet,
      expectedRenderCameraPosition: renderCamera,
      expectedRenderCameraYaw: renderCamera.yaw,
      expectedRenderCameraPitch: 0,
    });
  });
  return withMeasurementControls(scenes, [
    'head_steve_front_close',
    'first_person_vanilla--head_first_person',
    ...(representation.review.wideFov ? ['first_person_vanilla--head_first_person_wide'] : []),
    ...(representation.headwear.cameraOverlay !== undefined
      ? ['first_person_vanilla--head_camera_overlay']
      : []),
  ]);
}

function entityScenes(
  representation: EntityRepresentation,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  if (!('lowLight' in representation.review) || !('animationTicks' in representation.review)) {
    throw new Error('Entity representation is missing its strict review declaration.');
  }
  const review = representation.review;
  const stateIds = Object.keys(representation.states);
  const stateId = firstStateId(representation);
  const poseStates =
    representation.strategy === 'display_rig' ? representation.review.poseStates : undefined;
  if (representation.strategy === 'display_rig' && poseStates === undefined) {
    throw new Error('Simulated entity capture requires exact idle/walk/attack rig states.');
  }
  const fixture = (
    pose: 'idle' | 'walk' | 'attack',
    angle: number,
    showPlayerScale = false,
    animationTick = 0,
    selectedState = poseStates?.[pose] ?? stateId,
  ): ClientCaptureScene['fixture'] =>
    representation.strategy === 'native_entity'
      ? {
          kind: 'native_entity',
          stateId: selectedState,
          pose,
          angle,
          showPlayerScale,
          animationTick,
        }
      : {
          kind: 'display_rig',
          targetKind: 'entity',
          stateId: selectedState,
          pose,
          angle,
          showPlayerScale,
          animationTick,
        };
  const descriptors: SceneDescriptor[] = [];
  const angles = [
    ['front', 0],
    ['front_right', 45],
    ['right', 90],
    ['rear_right', 135],
    ['rear', 180],
    ['rear_left', 225],
    ['left', 270],
    ['front_left', 315],
  ] as const;
  for (const [name, angle] of angles) {
    descriptors.push({
      id: `entity_${name}`,
      yaw: 0,
      fixture: fixture('idle', angle),
      measurements: [measurement(`m_entity_${name}_frame`, 'frame_retention', 'percent')],
    });
  }
  const firstAnimationTick = review.animationTicks[0] ?? 0;
  for (const [pose, tick] of [
    ['idle', 0],
    ['walk', firstAnimationTick],
    ['attack', firstAnimationTick],
  ] as const) {
    descriptors.push({
      id: `entity_pose_${pose}`,
      yaw: 0,
      fixture: fixture(pose, 0, false, tick),
      measurements: [measurement(`m_entity_pose_${pose}`, 'self_intersection', 'percent')],
    });
  }
  descriptors.push(
    {
      id: 'entity_ground_shadow',
      yaw: 0,
      fixture: fixture('idle', 0),
      measurements: [measurement('m_entity_grounding', 'silhouette_grounding', 'pixels')],
    },
    {
      id: 'entity_player_scale',
      viewKind: 'world_scale_reference',
      yaw: 0,
      fixture: fixture('idle', 0, true),
      comparisonSceneIds: ['entity_front'],
      measurements: [measurement('m_entity_scale', 'player_scale', 'ratio')],
    },
  );
  for (const [index, animationTick] of review.animationTicks.entries()) {
    if (index === 0) continue;
    descriptors.push({
      id: `entity_walk_sample_${String(index)}`,
      yaw: 0,
      fixture: fixture('walk', 0, false, animationTick),
      comparisonSceneIds: ['entity_pose_walk'],
      measurements: [
        measurement(
          `m_entity_animation_${String(index)}`,
          'animation_stability',
          'percent',
          undefined,
          true,
        ),
      ],
    });
  }
  const poseStateIds = new Set(poseStates === undefined ? [] : Object.values(poseStates));
  for (const extraState of stateIds.slice(1).filter((id) => !poseStateIds.has(id))) {
    descriptors.push({
      id: `entity_state_${extraState}`,
      yaw: 0,
      fixture: fixture('idle', 0, false, 0, extraState),
      comparisonSceneIds: ['entity_front'],
      measurements: [
        measurement(
          `m_entity_state_${extraState}`,
          'texture_variant_resolution',
          'percent',
          undefined,
        ),
      ],
    });
  }
  if (review.lowLight) {
    descriptors.push({
      id: 'entity_low_light',
      yaw: 0,
      lowLight: true,
      fixture: fixture('idle', 0),
      comparisonSceneIds: ['entity_front'],
      measurements: [
        measurement('m_entity_low_light', 'pairwise_pixel_delta', 'percent', undefined, true),
      ],
    });
  }
  if (options.includeDebugHitboxViews === true) {
    for (const [baseSceneId, angle] of [
      ['entity_front', 0],
      ['entity_right', 90],
    ] as const) {
      const debugSceneId = `debug_hitbox_reference--${baseSceneId}`;
      const controlSceneId = `measurement_control--${baseSceneId}`;
      descriptors.push({
        id: baseSceneId,
        viewKind: 'debug_hitbox_reference',
        yaw: 0,
        fixture: fixture('idle', angle),
        comparisonSceneIds: [baseSceneId, controlSceneId],
        measurements: [
          measurement(`m_${baseSceneId}_hitbox`, 'hitbox_containment', 'percent', [
            debugSceneId,
            baseSceneId,
            controlSceneId,
          ]),
          measurement(`m_${baseSceneId}_empty`, 'hitbox_empty_space', 'percent', [
            debugSceneId,
            baseSceneId,
            controlSceneId,
          ]),
        ],
      });
    }
  }
  return withMeasurementControls(
    descriptors.map((descriptor) => lowerDescriptor(representation, options, descriptor)),
    ['entity_front', ...(options.includeDebugHitboxViews === true ? ['entity_right'] : [])],
  );
}

function placeableScenes(
  representation: PlaceableRepresentation,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  const stateIds = Object.keys(representation.states);
  if (
    !('orientations' in representation.review) ||
    !('attachments' in representation.review) ||
    !('placementStates' in representation.review)
  ) {
    throw new Error('Placeable representation is missing its strict review declaration.');
  }
  const orientations = representation.review.orientations;
  const attachments = representation.review.attachments;
  const placementStates = representation.review.placementStates;
  const orientationYaw = (orientation: 'north' | 'east' | 'south' | 'west'): number =>
    ({ north: 0, east: 90, south: 180, west: 270 })[orientation];
  const subjectPosition = (
    attachment: 'floor' | 'wall' | 'ceiling',
  ): Readonly<{ x: number; y: number; z: number }> => ({
    x: 0,
    y: attachment === 'floor' ? 80 : attachment === 'wall' ? 82 : 83,
    z: 5,
  });
  const fixture = (
    orientation: 'north' | 'east' | 'south' | 'west',
    attachment: 'floor' | 'wall' | 'ceiling',
    distance: 'close' | 'player_eye' | 'near' | 'mid',
    occluded = false,
    animationTick = 0,
    selectedState?: string,
    context: 'plain' | 'corner' | 'doorway' | 'occlusion' = 'plain',
  ): ClientCaptureScene['fixture'] => {
    const declaredState = placementStates.find(
      (entry) => entry.orientation === orientation && entry.attachment === attachment,
    )?.stateId;
    if (declaredState === undefined) {
      throw new Error(`Placeable review has no exact state for ${orientation}/${attachment}.`);
    }
    const common = {
      stateId: selectedState ?? declaredState,
      orientation,
      attachment,
      distance,
      occluded,
      animationTick,
      context,
      subjectPosition: subjectPosition(attachment),
    };
    if (representation.strategy === 'display_rig') {
      return { kind: 'display_rig', targetKind: 'placeable', ...common };
    }
    return { kind: representation.strategy, ...common };
  };
  const descriptors: SceneDescriptor[] = [];
  for (const orientation of orientations) {
    for (const distance of ['player_eye', 'close'] as const) {
      const id = `place_${orientation}_${distance}`;
      descriptors.push({
        id,
        yaw: distance === 'close' ? orientationYaw(orientation) + 45 : orientationYaw(orientation),
        cameraDistance: distance === 'close' ? 3.25 : 5,
        fixture: fixture(orientation, 'floor', distance),
        measurements: [measurement(`m_${id}_alignment`, 'orientation_alignment', 'dot')],
      });
    }
  }
  descriptors.push(
    {
      id: 'place_floor_contact',
      cameraDistance: 3.25,
      fixture: fixture('north', 'floor', 'close', false, 0, undefined, 'corner'),
      measurements: [
        measurement('m_place_floor_gap', 'attachment_gap', 'pixels'),
        measurement('m_place_floor_zfight', 'z_fighting', 'percent'),
        ...(representation.strategy === 'display_rig'
          ? [measurement('m_place_billboard', 'billboard_correctness', 'dot')]
          : []),
      ],
    },
    {
      id: 'place_footprint_corner',
      yaw: 45,
      cameraDistance: 3.75,
      fixture: fixture('north', 'floor', 'close', false, 0, undefined, 'corner'),
      measurements: [
        measurement('m_place_footprint', 'collision_interaction_footprint_delta', 'pixels'),
      ],
    },
    {
      id: 'place_doorway',
      fixture: fixture('east', 'floor', 'player_eye', false, 0, undefined, 'doorway'),
      measurements: [measurement('m_place_doorway', 'frame_retention', 'percent')],
    },
    {
      id: 'place_range_near',
      cameraDistance: 6,
      fixture: fixture('north', 'floor', 'near'),
      measurements: [],
    },
    {
      id: 'place_range_mid',
      cameraDistance: 12,
      fixture: fixture('north', 'floor', 'mid'),
      comparisonSceneIds: ['place_range_near'],
      measurements: [
        measurement('m_place_range', 'pairwise_pixel_delta', 'percent', [
          'place_range_mid',
          'place_range_near',
        ]),
      ],
    },
    {
      id: 'place_occluded',
      cameraDistance: 12,
      fixture: fixture('north', 'floor', 'mid', true, 0, undefined, 'occlusion'),
      comparisonSceneIds: ['place_range_mid', 'measurement_control--place_range_mid'],
      measurements: [
        measurement('m_place_occlusion', 'visibility_occlusion', 'percent', [
          'place_occluded',
          'place_range_mid',
          'measurement_control--place_range_mid',
        ]),
        measurement(
          'm_place_occlusion_delta',
          'pairwise_pixel_delta',
          'percent',
          ['place_occluded', 'place_range_mid'],
          true,
        ),
      ],
    },
  );
  for (const attachment of attachments.filter((value) => value !== 'floor')) {
    const origin = subjectPosition(attachment);
    const yaw = 45;
    const distance = 5;
    const yawRadians = (yaw * Math.PI) / 180;
    descriptors.push({
      id: `place_${attachment}_contact`,
      yaw,
      cameraPosition: {
        x: origin.x + 0.5 + Math.sin(yawRadians) * distance,
        y: origin.y + 2.25,
        z: origin.z + 0.5 - Math.cos(yawRadians) * distance,
      },
      fixture: fixture('north', attachment, 'close'),
      measurements: [measurement(`m_place_${attachment}_gap`, 'attachment_gap', 'pixels')],
    });
  }
  for (const extraState of stateIds.slice(1)) {
    const placement =
      placementStates.find(
        (entry) => entry.stateId === extraState && entry.attachment === 'floor',
      ) ?? placementStates.find((entry) => entry.stateId === extraState);
    if (placement === undefined) {
      throw new Error(
        `Placeable state '${extraState}' has no exact orientation/attachment binding.`,
      );
    }
    descriptors.push({
      id: `place_state_${extraState}`,
      fixture: fixture(placement.orientation, placement.attachment, 'close', false, 0, extraState),
      comparisonSceneIds: ['place_floor_contact'],
      measurements: [
        measurement(`m_place_state_${extraState}`, 'pairwise_pixel_delta', 'percent', undefined),
      ],
    });
  }
  if (
    options.includeDebugHitboxViews === true &&
    representation.strategy === 'display_rig' &&
    Object.values(representation.states).some((state) => state.displayRig.interaction !== undefined)
  ) {
    for (const baseSceneId of ['place_floor_contact', 'place_east_close'] as const) {
      const authoritative = descriptors.find(
        (descriptor) =>
          descriptor.id === baseSceneId &&
          (descriptor.viewKind === undefined || descriptor.viewKind === 'minecraft_vanilla'),
      );
      if (authoritative === undefined) {
        throw new Error(`Placeable hitbox QA has no authoritative '${baseSceneId}' scene.`);
      }
      const debugSceneId = `debug_hitbox_reference--${baseSceneId}`;
      const controlSceneId = `measurement_control--${baseSceneId}`;
      descriptors.push({
        ...authoritative,
        viewKind: 'debug_hitbox_reference',
        comparisonSceneIds: [baseSceneId, controlSceneId],
        measurements: [
          measurement(
            `m_${baseSceneId}_hitbox`,
            'collision_interaction_footprint_delta',
            'pixels',
            [debugSceneId, baseSceneId, controlSceneId],
          ),
        ],
      });
    }
  }
  return withMeasurementControls(
    descriptors.map((descriptor) => lowerDescriptor(representation, options, descriptor)),
    [
      'place_floor_contact',
      'place_range_mid',
      ...(options.includeDebugHitboxViews === true ? ['place_east_close'] : []),
    ],
  );
}

/** Lower a profile to exact Minecraft-client scenes; CPU renders never satisfy this contract. */
export function createVisualClientCaptureScenes(
  spec: ModelSpec,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  assertClientCaptureReviewSupport(spec.reviewProfile);
  const representation = representationForScenes(spec, options.representation);
  assertClientCaptureRepresentationForProfile(spec, representation);
  if (options.includeScaleReferenceViews === true && spec.reviewProfile !== 'held_item') {
    throw new Error(
      `Scale-reference QA views are valid only for held_item, not '${spec.reviewProfile}'.`,
    );
  }
  if (
    options.includeDebugHitboxViews === true &&
    representation.targetKind !== 'entity' &&
    representation.targetKind !== 'placeable'
  ) {
    throw new Error(`Debug-hitbox QA views are not supported for '${representation.targetKind}'.`);
  }
  switch (representation.targetKind) {
    case 'held_item':
    case 'gui_item':
      return itemScenes(spec, representation, options);
    case 'block':
      return blockScenes(representation, options);
    case 'headwear':
      return headwearScenes(representation, options);
    case 'entity':
      return entityScenes(representation as EntityRepresentation, options);
    case 'placeable':
      return placeableScenes(representation as PlaceableRepresentation, options);
  }
}

function representationForPlan(
  input: CreateVisualClientCapturePlanInput,
): ClientCaptureRepresentation {
  if (input.representation !== undefined)
    return ClientCaptureRepresentationSchema.parse(input.representation);
  if ('representation' in input.provenance) {
    return ClientCaptureRepresentationSchema.parse(input.provenance.representation);
  }
  const legacy = input.provenance.itemStack;
  const targetKind = input.spec.reviewProfile === 'gui_item' ? 'gui_item' : 'held_item';
  if (input.spec.reviewProfile !== 'held_item' && input.spec.reviewProfile !== 'gui_item') {
    throw new Error(
      `Review profile '${input.spec.reviewProfile}' requires an explicit protocol-v3 representation.`,
    );
  }
  return ClientCaptureRepresentationSchema.parse({
    targetKind,
    strategy: 'item_stack',
    capability: 'native',
    states: {
      default: {
        itemStack: {
          itemId: legacy.itemId,
          count: legacy.count,
          components: legacy.components,
        },
      },
    },
  });
}

export function createVisualClientCapturePlan(
  input: CreateVisualClientCapturePlanInput,
): ClientCapturePlan {
  const representation = representationForPlan(input);
  assertClientCaptureRepresentationForProfile(input.spec, representation);
  const cleanProvenance = { ...input.provenance } as Record<string, unknown>;
  delete cleanProvenance.itemStack;
  delete cleanProvenance.representation;
  delete cleanProvenance.representationSha256;
  const representationSha256 = computeClientCaptureRepresentationSha256(representation);
  return createClientCapturePlan({
    schemaVersion: 3,
    kind: 'packwright.client-capture-plan',
    minecraftVersion: '26.2',
    provenance: {
      ...cleanProvenance,
      packActivation: CLIENT_CAPTURE_PACK_ACTIVATION,
      representation,
      representationSha256,
    } as ClientCaptureProvenance,
    studio: ClientCaptureStudioSchema.parse(input.studio ?? DEFAULT_CLIENT_CAPTURE_STUDIO),
    scenes: createVisualClientCaptureScenes(input.spec, { ...input, representation }),
    execution: input.execution,
  });
}
