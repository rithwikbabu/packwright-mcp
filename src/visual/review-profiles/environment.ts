import type {
  OrthographicReviewCamera,
  PerspectiveReviewCamera,
  PlayerArmVariant,
  ReviewHand,
  ReviewPose,
  ReviewSceneDefinition,
} from '../review-profile.js';

/**
 * Review-profile definitions that need reference geometry beyond the held-item
 * player's arm/body rig. The common review-profile module deliberately owns
 * plan hashing; these factories only provide deterministic input data for that
 * finalizer.
 */
export const ENVIRONMENT_REVIEW_PROFILE_IDS = [
  'block',
  'placeable',
  'projectile',
  'gui_item',
] as const;

export type EnvironmentReviewProfileId = (typeof ENVIRONMENT_REVIEW_PROFILE_IDS)[number];

export type EnvironmentSceneCategory =
  | 'inventory'
  | 'world'
  | 'orthographic_face'
  | 'adjacency'
  | 'lighting'
  | 'culling'
  | 'attachment'
  | 'orientation'
  | 'collision'
  | 'in_hand'
  | 'in_flight'
  | 'impact'
  | 'hotbar'
  | 'overlay'
  | 'tooltip';

/**
 * Intent consumed by a renderer-owned reference-geometry provider. These are
 * original primitives and UI approximations, never bundled Minecraft assets.
 */
export type EnvironmentReferenceGeometryIntent =
  | Readonly<{
      kind: 'block_world';
      floorGrid: boolean;
      neighboringBlocks: readonly ('north' | 'south' | 'east' | 'west' | 'up' | 'down')[];
      showBounds: boolean;
    }>
  | Readonly<{
      kind: 'attachment_surface';
      surface: 'floor' | 'wall' | 'ceiling';
      showNormal: boolean;
    }>
  | Readonly<{
      kind: 'collision_footprint';
      showModelBounds: boolean;
      showDeclaredFootprint: boolean;
    }>
  | Readonly<{
      kind: 'projectile_path';
      direction: 'toward_camera' | 'away_from_camera' | 'left_to_right';
      showForwardAxis: boolean;
    }>
  | Readonly<{
      kind: 'impact_surface';
      surface: 'block' | 'entity';
      showSurfaceNormal: boolean;
    }>
  | Readonly<{
      kind: 'inventory_slot';
      targetPixels: 16 | 32 | 64;
      selected: boolean;
    }>
  | Readonly<{
      kind: 'hotbar_slot';
      targetPixels: 16 | 32;
      selected: boolean;
    }>
  | Readonly<{
      kind: 'item_overlay';
      overlay: 'count';
      count: number;
    }>
  | Readonly<{
      kind: 'item_overlay';
      overlay: 'durability' | 'glint';
    }>
  | Readonly<{
      kind: 'tooltip';
      maxWidthPixels: number;
    }>;

/**
 * Structurally remains a ReviewSceneDefinition, while carrying the reference
 * geometry and semantic category required by the new profiles.
 */
export interface EnvironmentReviewSceneDefinition extends ReviewSceneDefinition {
  readonly profileCategory: EnvironmentSceneCategory;
  readonly referenceGeometry?: readonly EnvironmentReferenceGeometryIntent[] | undefined;
}

type FrameRetentionRule = Readonly<{
  id: 'frame_retention';
  kind: 'frame_retention';
  warningBelow: number;
  failureBelow: number;
  unit: 'percent';
}>;

/**
 * Additive rule vocabulary for non-held profiles. Every rule is
 * explicitly advisory: these deterministic previews are useful QA evidence,
 * not proof that the Minecraft client will render identically.
 */
export type EnvironmentMeasurementRule =
  | FrameRetentionRule
  | Readonly<{
      id: 'face_visibility' | 'icon_occupancy' | 'lighting_separation' | 'state_difference';
      kind: 'minimum_ratio';
      warningBelow: number;
      failureBelow: number;
      unit: 'percent';
      authority: 'advisory';
    }>
  | Readonly<{
      id:
        | 'adjacency_seam'
        | 'attachment_gap'
        | 'collision_footprint_delta'
        | 'impact_depth_delta'
        | 'overlay_occlusion'
        | 'tooltip_overflow';
      kind: 'maximum_delta';
      warningAbove: number;
      failureAbove: number;
      unit: 'pixels' | 'percent' | 'model_pixels';
      authority: 'advisory';
    }>
  | Readonly<{
      id: 'orientation_alignment' | 'trajectory_alignment';
      kind: 'axis_alignment';
      warningBelow: number;
      failureBelow: number;
      unit: 'dot';
      authority: 'advisory';
    }>
  | Readonly<{
      id: 'unexpected_culled_face';
      kind: 'count_above';
      warningAbove: number;
      failureAbove: number;
      unit: 'faces';
      authority: 'advisory';
    }>;

export interface EnvironmentProfileFactoryData {
  readonly id: EnvironmentReviewProfileId;
  readonly version: 1;
  readonly advisoryOnly: true;
  readonly measurements: readonly EnvironmentMeasurementRule[];
  createScenes(
    viewSize: number,
    options?: EnvironmentProfileOptions,
  ): readonly EnvironmentReviewSceneDefinition[];
}

export type EnvironmentProfileOption = boolean | readonly number[];
export type EnvironmentProfileOptions = Readonly<Record<string, EnvironmentProfileOption>>;

const perspective = (
  yaw: number,
  pitch: number,
  verticalFovDegrees = 50,
  cameraDistance = 36,
): PerspectiveReviewCamera => ({
  kind: 'perspective',
  yaw,
  pitch,
  roll: 0,
  verticalFovDegrees,
  cameraDistance,
  nearPlane: 1,
});

const orthographic = (yaw: number, pitch: number, scale = 0.96): OrthographicReviewCamera => ({
  kind: 'orthographic',
  yaw,
  pitch,
  roll: 0,
  scale,
});

const worldReference = (
  neighboringBlocks: readonly ('north' | 'south' | 'east' | 'west' | 'up' | 'down')[] = [],
  showBounds = false,
): EnvironmentReferenceGeometryIntent => ({
  kind: 'block_world',
  floorGrid: true,
  neighboringBlocks,
  showBounds,
});

function environmentScene(
  id: string,
  title: string,
  size: number,
  profileCategory: EnvironmentSceneCategory,
  camera: PerspectiveReviewCamera | OrthographicReviewCamera,
  referenceGeometry: readonly EnvironmentReferenceGeometryIntent[] = [],
  overrides: Partial<Omit<ReviewSceneDefinition, 'referenceGeometry'>> = {},
): EnvironmentReviewSceneDefinition {
  return {
    id,
    title,
    category: 'neutral',
    required: true,
    width: size,
    height: size,
    camera,
    profileCategory,
    referenceGeometry,
    ...overrides,
  };
}

function playerReference(
  hand: ReviewHand,
  variant: PlayerArmVariant = 'steve',
  pose: ReviewPose = 'neutral',
): NonNullable<ReviewSceneDefinition['referenceRig']> {
  return { kind: 'player', variant, hands: [hand], includeBody: false, pose };
}

export const BLOCK_MEASUREMENTS: readonly EnvironmentMeasurementRule[] = Object.freeze([
  {
    id: 'frame_retention',
    kind: 'frame_retention',
    warningBelow: 98,
    failureBelow: 85,
    unit: 'percent',
  },
  {
    id: 'face_visibility',
    kind: 'minimum_ratio',
    warningBelow: 2,
    failureBelow: 0.25,
    unit: 'percent',
    authority: 'advisory',
  },
  {
    id: 'adjacency_seam',
    kind: 'maximum_delta',
    warningAbove: 0.5,
    failureAbove: 1,
    unit: 'model_pixels',
    authority: 'advisory',
  },
  {
    id: 'lighting_separation',
    kind: 'minimum_ratio',
    warningBelow: 8,
    failureBelow: 3,
    unit: 'percent',
    authority: 'advisory',
  },
  {
    id: 'unexpected_culled_face',
    kind: 'count_above',
    warningAbove: 0,
    failureAbove: 1,
    unit: 'faces',
    authority: 'advisory',
  },
]);

export function createBlockReviewScenes(
  viewSize: number,
  options: EnvironmentProfileOptions = {},
): readonly EnvironmentReviewSceneDefinition[] {
  const scenes: EnvironmentReviewSceneDefinition[] = [
    environmentScene(
      'block_inventory',
      'Inventory icon',
      viewSize,
      'inventory',
      orthographic(30, -18),
      [],
      {
        displayContext: 'gui',
      },
    ),
    environmentScene('block_world', 'Placed in world', viewSize, 'world', perspective(45, -28), [
      worldReference(),
    ]),
    environmentScene(
      'block_north',
      'North face',
      viewSize,
      'orthographic_face',
      orthographic(180, 0),
    ),
    environmentScene(
      'block_south',
      'South face',
      viewSize,
      'orthographic_face',
      orthographic(0, 0),
    ),
    environmentScene(
      'block_east',
      'East face',
      viewSize,
      'orthographic_face',
      orthographic(-90, 0),
    ),
    environmentScene('block_west', 'West face', viewSize, 'orthographic_face', orthographic(90, 0)),
    environmentScene('block_up', 'Top face', viewSize, 'orthographic_face', orthographic(0, -90)),
    environmentScene(
      'block_down',
      'Bottom face',
      viewSize,
      'orthographic_face',
      orthographic(0, 90),
    ),
    environmentScene(
      'block_adjacent',
      'Adjacent-block seams',
      viewSize,
      'adjacency',
      perspective(45, -24),
      [worldReference(['north', 'east'])],
    ),
    environmentScene(
      'block_lighting',
      'World-lighting response',
      viewSize,
      'lighting',
      perspective(35, -20),
      [worldReference()],
    ),
    environmentScene(
      'block_culling',
      'Occluded-face and culling review',
      viewSize,
      'culling',
      perspective(45, -28),
      [worldReference(['north', 'east', 'down'])],
    ),
  ];
  if (options.multipart === true) {
    scenes.push(
      environmentScene(
        'block_multipart',
        'Multipart/state composition',
        viewSize,
        'world',
        perspective(-45, -28),
        [worldReference()],
        { category: 'conditional' },
      ),
    );
  }
  if (options.transparency === true) {
    scenes.push(
      environmentScene(
        'block_transparency',
        'Transparency and internal-face stress view',
        viewSize,
        'culling',
        perspective(45, -20),
        [worldReference(['south'])],
        { category: 'conditional' },
      ),
    );
  }
  return Object.freeze(scenes);
}

export const PLACEABLE_MEASUREMENTS: readonly EnvironmentMeasurementRule[] = Object.freeze([
  {
    id: 'frame_retention',
    kind: 'frame_retention',
    warningBelow: 98,
    failureBelow: 85,
    unit: 'percent',
  },
  {
    id: 'orientation_alignment',
    kind: 'axis_alignment',
    warningBelow: 0.98,
    failureBelow: 0.9,
    unit: 'dot',
    authority: 'advisory',
  },
  {
    id: 'attachment_gap',
    kind: 'maximum_delta',
    warningAbove: 0.25,
    failureAbove: 1,
    unit: 'model_pixels',
    authority: 'advisory',
  },
  {
    id: 'collision_footprint_delta',
    kind: 'maximum_delta',
    warningAbove: 0.5,
    failureAbove: 2,
    unit: 'model_pixels',
    authority: 'advisory',
  },
]);

export function createPlaceableReviewScenes(
  viewSize: number,
  options: EnvironmentProfileOptions = {},
): readonly EnvironmentReviewSceneDefinition[] {
  const scenes: EnvironmentReviewSceneDefinition[] = [
    environmentScene(
      'placeable_neutral',
      'Neutral placeable comparison',
      viewSize,
      'world',
      perspective(35, -22),
      [worldReference([], true)],
    ),
    environmentScene(
      'placeable_north',
      'North-facing placement',
      viewSize,
      'orientation',
      perspective(180, -20),
      [worldReference()],
    ),
    environmentScene(
      'placeable_east',
      'East-facing placement',
      viewSize,
      'orientation',
      perspective(-90, -20),
      [worldReference()],
    ),
    environmentScene(
      'placeable_south',
      'South-facing placement',
      viewSize,
      'orientation',
      perspective(0, -20),
      [worldReference()],
    ),
    environmentScene(
      'placeable_west',
      'West-facing placement',
      viewSize,
      'orientation',
      perspective(90, -20),
      [worldReference()],
    ),
    environmentScene(
      'placeable_floor',
      'Floor attachment',
      viewSize,
      'attachment',
      perspective(35, -30),
      [{ kind: 'attachment_surface', surface: 'floor', showNormal: true }],
    ),
    environmentScene(
      'placeable_collision',
      'Collision footprint overlay',
      viewSize,
      'collision',
      perspective(35, -45),
      [{ kind: 'collision_footprint', showModelBounds: true, showDeclaredFootprint: true }],
    ),
  ];
  if (options.wall !== false) {
    scenes.push(
      environmentScene(
        'placeable_wall',
        'Wall attachment',
        viewSize,
        'attachment',
        perspective(30, -10),
        [{ kind: 'attachment_surface', surface: 'wall', showNormal: true }],
      ),
    );
  }
  if (options.ceiling !== false) {
    scenes.push(
      environmentScene(
        'placeable_ceiling',
        'Ceiling attachment',
        viewSize,
        'attachment',
        perspective(35, 30),
        [{ kind: 'attachment_surface', surface: 'ceiling', showNormal: true }],
      ),
    );
  }
  return Object.freeze(scenes);
}

export const PROJECTILE_MEASUREMENTS: readonly EnvironmentMeasurementRule[] = Object.freeze([
  {
    id: 'frame_retention',
    kind: 'frame_retention',
    warningBelow: 98,
    failureBelow: 85,
    unit: 'percent',
  },
  {
    id: 'trajectory_alignment',
    kind: 'axis_alignment',
    warningBelow: 0.95,
    failureBelow: 0.8,
    unit: 'dot',
    authority: 'advisory',
  },
  {
    id: 'impact_depth_delta',
    kind: 'maximum_delta',
    warningAbove: 0.5,
    failureAbove: 2,
    unit: 'model_pixels',
    authority: 'advisory',
  },
]);

export function createProjectileReviewScenes(
  viewSize: number,
  options: EnvironmentProfileOptions = {},
): readonly EnvironmentReviewSceneDefinition[] {
  const hand: ReviewHand = options.leftHanded === true ? 'left' : 'right';
  const displayContext = hand === 'right' ? 'firstperson_righthand' : 'firstperson_lefthand';
  const scenes: EnvironmentReviewSceneDefinition[] = [
    environmentScene(
      'projectile_in_hand',
      `In-hand launch pose, ${hand} hand`,
      viewSize,
      'in_hand',
      perspective(hand === 'right' ? -22 : 22, -8, 70, 16),
      [],
      {
        category: 'first_person',
        displayContext,
        hand,
        referenceRig: playerReference(hand, 'steve', 'aiming'),
      },
    ),
    environmentScene(
      'projectile_flight_side',
      'In flight, side orientation',
      viewSize,
      'in_flight',
      perspective(90, 0),
      [{ kind: 'projectile_path', direction: 'left_to_right', showForwardAxis: true }],
    ),
    environmentScene(
      'projectile_flight_front',
      'In flight, approaching camera',
      viewSize,
      'in_flight',
      perspective(180, 0),
      [{ kind: 'projectile_path', direction: 'toward_camera', showForwardAxis: true }],
    ),
    environmentScene(
      'projectile_flight_rear',
      'In flight, moving away',
      viewSize,
      'in_flight',
      perspective(0, 0),
      [{ kind: 'projectile_path', direction: 'away_from_camera', showForwardAxis: true }],
    ),
    environmentScene(
      'projectile_impact',
      'Impact orientation',
      viewSize,
      'impact',
      perspective(45, -15),
      [{ kind: 'impact_surface', surface: 'block', showSurfaceNormal: true }],
    ),
    environmentScene(
      'projectile_stuck',
      'Embedded/stuck orientation',
      viewSize,
      'impact',
      perspective(-45, -15),
      [{ kind: 'impact_surface', surface: 'block', showSurfaceNormal: true }],
    ),
  ];
  if (options.entityImpact === true) {
    scenes.push(
      environmentScene(
        'projectile_entity_impact',
        'Entity-impact orientation',
        viewSize,
        'impact',
        perspective(35, -10),
        [{ kind: 'impact_surface', surface: 'entity', showSurfaceNormal: true }],
        { category: 'conditional' },
      ),
    );
  }
  if (options.spinning === true) {
    scenes.push(
      environmentScene(
        'projectile_spin_midpoint',
        'Mid-flight spin orientation',
        viewSize,
        'in_flight',
        perspective(90, -12),
        [{ kind: 'projectile_path', direction: 'left_to_right', showForwardAxis: true }],
        {
          category: 'conditional',
          itemPose: { rotation: [0, 0, 90], translation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ),
    );
  }
  return Object.freeze(scenes);
}

export const GUI_ITEM_MEASUREMENTS: readonly EnvironmentMeasurementRule[] = Object.freeze([
  {
    id: 'frame_retention',
    kind: 'frame_retention',
    warningBelow: 98,
    failureBelow: 85,
    unit: 'percent',
  },
  {
    id: 'icon_occupancy',
    kind: 'minimum_ratio',
    warningBelow: 30,
    failureBelow: 15,
    unit: 'percent',
    authority: 'advisory',
  },
  {
    id: 'overlay_occlusion',
    kind: 'maximum_delta',
    warningAbove: 12,
    failureAbove: 25,
    unit: 'percent',
    authority: 'advisory',
  },
  {
    id: 'tooltip_overflow',
    kind: 'maximum_delta',
    warningAbove: 0,
    failureAbove: 8,
    unit: 'pixels',
    authority: 'advisory',
  },
  {
    id: 'state_difference',
    kind: 'minimum_ratio',
    warningBelow: 2,
    failureBelow: 0.5,
    unit: 'percent',
    authority: 'advisory',
  },
]);

export function createGuiItemReviewScenes(
  viewSize: number,
  options: EnvironmentProfileOptions = {},
): readonly EnvironmentReviewSceneDefinition[] {
  const guiOverrides: Partial<ReviewSceneDefinition> = { displayContext: 'gui' };
  const requestedCounts = options.counts;
  const counts =
    requestedCounts === undefined || typeof requestedCounts === 'boolean'
      ? ([1, 64] as const)
      : requestedCounts;
  const scenes: EnvironmentReviewSceneDefinition[] = [
    environmentScene(
      'gui_inventory_64',
      'Inventory icon at 64-pixel review scale',
      viewSize,
      'inventory',
      orthographic(30, -18),
      [{ kind: 'inventory_slot', targetPixels: 64, selected: false }],
      { ...guiOverrides, width: 64, height: 64 },
    ),
    environmentScene(
      'gui_inventory_32',
      'Inventory icon at 32-pixel review scale',
      viewSize,
      'inventory',
      orthographic(30, -18),
      [{ kind: 'inventory_slot', targetPixels: 32, selected: false }],
      { ...guiOverrides, width: 32, height: 32 },
    ),
    environmentScene(
      'gui_hotbar',
      'Hotbar icon at native logical size',
      viewSize,
      'hotbar',
      orthographic(30, -18),
      [{ kind: 'hotbar_slot', targetPixels: 16, selected: false }],
      { ...guiOverrides, width: 32, height: 32 },
    ),
    ...counts.map((count) =>
      environmentScene(
        `gui_count_${String(count)}`,
        `Stack-count overlay: ${String(count)}`,
        viewSize,
        'overlay',
        orthographic(30, -18),
        [{ kind: 'item_overlay', overlay: 'count', count }],
        { ...guiOverrides, width: 32, height: 32 },
      ),
    ),
    environmentScene(
      'gui_durability',
      'Durability-bar overlay',
      viewSize,
      'overlay',
      orthographic(30, -18),
      [{ kind: 'item_overlay', overlay: 'durability' }],
      { ...guiOverrides, width: 32, height: 32 },
    ),
    environmentScene(
      'gui_glint',
      'Enchantment-glint approximation',
      viewSize,
      'overlay',
      orthographic(30, -18),
      [{ kind: 'item_overlay', overlay: 'glint' }],
      { ...guiOverrides, width: 32, height: 32 },
    ),
    environmentScene(
      'gui_tooltip',
      'Tooltip and icon relationship',
      viewSize,
      'tooltip',
      orthographic(30, -18),
      [{ kind: 'tooltip', maxWidthPixels: Math.max(128, viewSize * 2) }],
      guiOverrides,
    ),
  ];
  if (options.selectedHotbar === true) {
    scenes.push(
      environmentScene(
        'gui_hotbar_selected',
        'Selected hotbar slot',
        viewSize,
        'hotbar',
        orthographic(30, -18),
        [{ kind: 'hotbar_slot', targetPixels: 16, selected: true }],
        { ...guiOverrides, category: 'conditional', width: 32, height: 32 },
      ),
    );
  }
  return Object.freeze(scenes);
}

export const ENVIRONMENT_PROFILE_FACTORIES: Readonly<
  Record<EnvironmentReviewProfileId, EnvironmentProfileFactoryData>
> = Object.freeze({
  block: Object.freeze({
    id: 'block',
    version: 1,
    advisoryOnly: true,
    measurements: BLOCK_MEASUREMENTS,
    createScenes: createBlockReviewScenes,
  }),
  placeable: Object.freeze({
    id: 'placeable',
    version: 1,
    advisoryOnly: true,
    measurements: PLACEABLE_MEASUREMENTS,
    createScenes: createPlaceableReviewScenes,
  }),
  projectile: Object.freeze({
    id: 'projectile',
    version: 1,
    advisoryOnly: true,
    measurements: PROJECTILE_MEASUREMENTS,
    createScenes: createProjectileReviewScenes,
  }),
  gui_item: Object.freeze({
    id: 'gui_item',
    version: 1,
    advisoryOnly: true,
    measurements: GUI_ITEM_MEASUREMENTS,
    createScenes: createGuiItemReviewScenes,
  }),
});

export function requiredEnvironmentViewIds(
  scenes: readonly EnvironmentReviewSceneDefinition[],
): readonly string[] {
  return scenes.filter((scene) => scene.required).map((scene) => scene.id);
}
