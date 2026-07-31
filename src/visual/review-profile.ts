import { createHash } from 'node:crypto';

import {
  REVIEW_PROFILE_IDS,
  type DisplayContext,
  type ModelSpec,
  type Vector3,
} from './model-spec.js';
import {
  ENVIRONMENT_PROFILE_FACTORIES,
  type EnvironmentMeasurementRule,
  type EnvironmentReferenceGeometryIntent,
  type EnvironmentReviewSceneDefinition,
} from './review-profiles/environment.js';
import {
  ARMOR_STAND_HEAD_ANCHOR,
  ARMOR_SLOT_ANCHORS,
  createArmorReviewPlan,
  createEntityModelReviewPlan,
  createHeadWearableReviewPlan,
  type CharacterAssetState,
  type CharacterReferenceGeometry,
  type CharacterReviewMeasurementRule,
  type CharacterSceneFraming,
} from './review-profiles/character.js';

export const REVIEW_PROFILE_RENDERER_VERSION = 'packwright-cpu-v2' as const;
export const HELD_ITEM_PROFILE_VERSION = 1 as const;
export const MAX_REVIEW_SCENES = 16;
export const MAX_REVIEW_MEASUREMENTS = MAX_REVIEW_SCENES * 12;

export type ReviewProfileId = (typeof REVIEW_PROFILE_IDS)[number];
export type PlayerArmVariant = 'steve' | 'alex';
export type ReviewHand = 'left' | 'right';
export type ReviewPose = 'neutral' | 'swing_midpoint' | 'active_use' | 'two_handed' | 'aiming';
export const REVIEW_SCENE_CATEGORIES = [
  'adjacency',
  'attachment',
  'character',
  'collision',
  'conditional',
  'culling',
  'first_person',
  'hotbar',
  'impact',
  'in_flight',
  'in_hand',
  'inventory',
  'lighting',
  'neutral',
  'orientation',
  'orthographic_face',
  'overlay',
  'pose',
  'reference',
  'scale',
  'slot',
  'third_person',
  'tooltip',
  'turntable',
  'world',
] as const;
export type ReviewSceneCategory = (typeof REVIEW_SCENE_CATEGORIES)[number];

export interface PerspectiveReviewCamera {
  readonly kind: 'perspective';
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly verticalFovDegrees: number;
  readonly cameraDistance: number;
  readonly nearPlane: number;
}

export interface OrthographicReviewCamera {
  readonly kind: 'orthographic';
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly scale: number;
}

export type ReviewCamera = PerspectiveReviewCamera | OrthographicReviewCamera;

export interface PlayerReferenceRig {
  readonly kind: 'player';
  readonly variant: PlayerArmVariant;
  readonly hands: readonly ReviewHand[];
  readonly includeBody: boolean;
  readonly pose: ReviewPose;
}

export interface ReviewItemPose {
  readonly rotation: Vector3;
  readonly translation: Vector3;
  readonly scale: Vector3;
}

export type ReviewReferenceGeometry =
  EnvironmentReferenceGeometryIntent | CharacterReferenceGeometry;

export interface ReviewSceneDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: ReviewSceneCategory;
  readonly required: boolean;
  readonly width: number;
  readonly height: number;
  readonly camera: ReviewCamera;
  readonly displayContext?: DisplayContext | undefined;
  readonly hand?: ReviewHand | undefined;
  readonly referenceRig?: PlayerReferenceRig | undefined;
  readonly referenceGeometry?: readonly ReviewReferenceGeometry[] | undefined;
  readonly itemPose?: ReviewItemPose | undefined;
  readonly framing?: CharacterSceneFraming | undefined;
  readonly assetState?: CharacterAssetState | undefined;
}

export type HeldItemMeasurementRule =
  | Readonly<{
      id: 'primary_grip_distance';
      kind: 'anchor_distance';
      warningAbove: number;
      failureAbove: number;
      unit: 'model_pixels';
    }>
  | Readonly<{
      id: 'secondary_grip_distance';
      kind: 'secondary_anchor_distance';
      warningAbove: number;
      failureAbove: number;
      unit: 'model_pixels';
    }>
  | Readonly<{
      id: 'arm_intersection';
      kind: 'aabb_overlap';
      reference: 'arm';
      warningAbove: number;
      failureAbove: number;
      unit: 'percent';
    }>
  | Readonly<{
      id: 'torso_intersection';
      kind: 'aabb_overlap';
      reference: 'torso';
      warningAbove: number;
      failureAbove: number;
      unit: 'percent';
    }>
  | Readonly<{
      id: 'screen_obscuration';
      kind: 'screen_coverage';
      warningAbove: number;
      failureAbove: number;
      wideWarningAbove: number;
      wideFailureAbove: number;
      unit: 'percent';
    }>
  | Readonly<{
      id: 'forward_axis';
      kind: 'axis_alignment';
      warningBelow: number;
      failureBelow: number;
      unit: 'dot';
    }>
  | Readonly<{
      id: 'hand_symmetry';
      kind: 'mirror_delta';
      warningAbove: number;
      failureAbove: number;
      unit: 'model_pixels';
    }>
  | Readonly<{
      id: 'frame_retention';
      kind: 'frame_retention';
      warningBelow: number;
      failureBelow: number;
      unit: 'percent';
    }>;

export type ReviewMeasurementRule =
  HeldItemMeasurementRule | EnvironmentMeasurementRule | CharacterReviewMeasurementRule;

export const REVIEW_MEASUREMENT_IDS = [
  'primary_grip_distance',
  'secondary_grip_distance',
  'arm_intersection',
  'torso_intersection',
  'screen_obscuration',
  'forward_axis',
  'hand_symmetry',
  'frame_retention',
  'face_visibility',
  'icon_occupancy',
  'lighting_separation',
  'state_difference',
  'adjacency_seam',
  'attachment_gap',
  'collision_footprint_delta',
  'impact_depth_delta',
  'overlay_occlusion',
  'tooltip_overflow',
  'orientation_alignment',
  'trajectory_alignment',
  'unexpected_culled_face',
  'armor_body_intersection',
  'armor_surface_clearance',
  'armor_slot_alignment',
  'armor_variant_fit',
  'armor_pose_clipping',
  'armor_frame_retention',
  'head_player_intersection',
  'head_variant_fit',
  'head_first_person_obscuration',
  'head_armor_stand_alignment',
  'head_frame_retention',
  'entity_frame_retention',
  'entity_pose_intersection',
  'entity_player_scale',
  'entity_hitbox_containment',
  'entity_hitbox_empty_space',
  'entity_ground_contact',
] as const satisfies readonly ReviewMeasurementRule['id'][];

export type ReviewMeasurementId = (typeof REVIEW_MEASUREMENT_IDS)[number];
export const REVIEW_MEASUREMENT_UNITS = [
  'dot',
  'faces',
  'model_pixels',
  'percent',
  'pixels',
  'ratio',
  'screen_percent',
] as const;

export interface SceneProfilePlan {
  readonly schemaVersion: 1;
  readonly profileId: ReviewProfileId;
  readonly profileVersion: number;
  readonly rendererVersion: typeof REVIEW_PROFILE_RENDERER_VERSION;
  readonly scenes: readonly ReviewSceneDefinition[];
  readonly requiredViewIds: readonly string[];
  readonly measurements: readonly ReviewMeasurementRule[];
  readonly planSha256: string;
}

export type ReviewMeasurementStatus = 'passed' | 'warning' | 'failed' | 'skipped';

export interface ReviewMeasurementResult {
  readonly metric: ReviewMeasurementId;
  readonly view?: string | undefined;
  readonly status: ReviewMeasurementStatus;
  readonly value?: number | undefined;
  readonly threshold?: number | undefined;
  readonly unit: (typeof REVIEW_MEASUREMENT_UNITS)[number];
  readonly message: string;
  readonly partId?: string | undefined;
}

export interface SceneProfileEvaluation {
  readonly reviewReady: boolean;
  readonly measurements: readonly ReviewMeasurementResult[];
}

export interface SceneProfile {
  readonly id: ReviewProfileId;
  readonly version: number;
  createPlan(spec: ModelSpec, viewSize: number): SceneProfilePlan;
}

const perspective = (
  yaw: number,
  pitch: number,
  roll: number,
  verticalFovDegrees: number,
  cameraDistance = 36,
): PerspectiveReviewCamera => ({
  kind: 'perspective',
  yaw,
  pitch,
  roll,
  verticalFovDegrees,
  cameraDistance,
  nearPlane: 1,
});

const orthographic = (
  yaw: number,
  pitch: number,
  roll: number,
  scale: number,
): OrthographicReviewCamera => ({ kind: 'orthographic', yaw, pitch, roll, scale });

const player = (
  variant: PlayerArmVariant,
  hands: readonly ReviewHand[],
  includeBody: boolean,
  pose: ReviewPose = 'neutral',
): PlayerReferenceRig => ({ kind: 'player', variant, hands, includeBody, pose });

function firstPerson(
  id: string,
  title: string,
  size: number,
  hand: ReviewHand,
  variant: PlayerArmVariant,
  wide = false,
): ReviewSceneDefinition {
  return {
    id,
    title,
    category: 'first_person',
    required: true,
    width: size,
    height: Math.max(32, Math.round((size * 9) / 16)),
    camera: perspective(
      hand === 'right' ? -22 : 22,
      -8,
      hand === 'right' ? -5 : 5,
      wide ? 100 : 70,
      16,
    ),
    displayContext: hand === 'right' ? 'firstperson_righthand' : 'firstperson_lefthand',
    hand,
    referenceRig: player(variant, [hand], false),
  };
}

function thirdPerson(
  id: string,
  title: string,
  size: number,
  hand: ReviewHand,
  variant: PlayerArmVariant,
  yaw: number,
): ReviewSceneDefinition {
  return {
    id,
    title,
    category: 'third_person',
    required: true,
    width: size,
    height: size,
    camera: perspective(yaw, -8, 0, 50),
    displayContext: hand === 'right' ? 'thirdperson_righthand' : 'thirdperson_lefthand',
    hand,
    referenceRig: player(variant, [hand], true),
  };
}

const activeUsePoses = new Set([
  'block',
  'bow',
  'crossbow',
  'spear',
  'horn',
  'food',
  'drink',
  'spyglass',
  'brush',
  'aim',
]);

function heldItemScenes(spec: ModelSpec, size: number): readonly ReviewSceneDefinition[] {
  const base: ReviewSceneDefinition[] = [
    firstPerson('fp_right_steve', 'First person, right hand, Steve arm', size, 'right', 'steve'),
    firstPerson('fp_right_alex', 'First person, right hand, Alex arm', size, 'right', 'alex'),
    firstPerson('fp_left_steve', 'First person, left/offhand, Steve arm', size, 'left', 'steve'),
    firstPerson('fp_left_alex', 'First person, left/offhand, Alex arm', size, 'left', 'alex'),
    firstPerson(
      'fp_right_wide',
      'First person, right hand, wide FOV',
      size,
      'right',
      'steve',
      true,
    ),
    thirdPerson(
      'tp_rear_right_steve',
      'Third person rear three-quarter, right, Steve',
      size,
      'right',
      'steve',
      145,
    ),
    thirdPerson(
      'tp_rear_right_alex',
      'Third person rear three-quarter, right, Alex',
      size,
      'right',
      'alex',
      145,
    ),
    thirdPerson(
      'tp_front_right_steve',
      'Third person front three-quarter, right, Steve',
      size,
      'right',
      'steve',
      -35,
    ),
    thirdPerson(
      'tp_front_right_alex',
      'Third person front three-quarter, right, Alex',
      size,
      'right',
      'alex',
      -35,
    ),
    thirdPerson(
      'tp_rear_left_steve',
      'Third person rear three-quarter, left, Steve',
      size,
      'left',
      'steve',
      215,
    ),
    thirdPerson(
      'tp_rear_left_alex',
      'Third person rear three-quarter, left, Alex',
      size,
      'left',
      'alex',
      215,
    ),
    {
      id: 'item_neutral',
      title: 'Neutral item-only comparison',
      category: 'neutral',
      required: true,
      width: size,
      height: size,
      camera: orthographic(30, -18, 0, 0.96),
    },
  ];
  const held = spec.heldItem;
  if (held === undefined) return base;
  const actionHand: ReviewHand = held.handedness === 'left' ? 'left' : 'right';
  const oppositeHand: ReviewHand = actionHand === 'right' ? 'left' : 'right';
  const mirrored = actionHand === 'left' ? -1 : 1;
  if (held.itemKind === 'weapon' || held.itemKind === 'tool' || held.usePose === 'swing') {
    base.push({
      ...firstPerson(
        'swing_midpoint',
        `Swing midpoint, ${actionHand} hand`,
        size,
        actionHand,
        'steve',
      ),
      category: 'conditional',
      referenceRig: player('steve', [actionHand], false, 'swing_midpoint'),
      itemPose: {
        rotation: [0, 0, -32 * mirrored],
        translation: [-1 * mirrored, -1, 0],
        scale: [1, 1, 1],
      },
    });
  }
  if (activeUsePoses.has(held.usePose)) {
    base.push({
      ...firstPerson(
        'active_use',
        `Active-use pose: ${held.usePose}, ${actionHand} hand`,
        size,
        actionHand,
        'steve',
      ),
      category: 'conditional',
      referenceRig: player('steve', [actionHand], false, 'active_use'),
      itemPose: {
        rotation: [18, 0, 12 * mirrored],
        translation: [0, 1, -1],
        scale: [1, 1, 1],
      },
    });
  }
  if (held.secondaryGrip !== undefined) {
    base.push({
      ...firstPerson(
        'two_handed',
        `Two-handed grip, ${actionHand} primary`,
        size,
        actionHand,
        'steve',
      ),
      category: 'conditional',
      referenceRig: player('steve', [actionHand, oppositeHand], false, 'two_handed'),
    });
  }
  if (held.forwardAxis !== undefined || held.muzzle !== undefined) {
    base.push({
      ...firstPerson(
        'aiming',
        `Aiming/forward-axis view, ${actionHand} hand`,
        size,
        actionHand,
        'steve',
      ),
      category: 'conditional',
      referenceRig: player('steve', [actionHand], false, 'aiming'),
      itemPose: { rotation: [0, 0, 0], translation: [0, 0, -2], scale: [1, 1, 1] },
    });
  }
  return base;
}

export const HELD_ITEM_MEASUREMENTS: readonly ReviewMeasurementRule[] = Object.freeze([
  {
    id: 'primary_grip_distance',
    kind: 'anchor_distance',
    warningAbove: 0.75,
    failureAbove: 2,
    unit: 'model_pixels',
  },
  {
    id: 'secondary_grip_distance',
    kind: 'secondary_anchor_distance',
    warningAbove: 0.75,
    failureAbove: 2,
    unit: 'model_pixels',
  },
  {
    id: 'arm_intersection',
    kind: 'aabb_overlap',
    reference: 'arm',
    warningAbove: 12,
    failureAbove: 65,
    unit: 'percent',
  },
  {
    id: 'torso_intersection',
    kind: 'aabb_overlap',
    reference: 'torso',
    warningAbove: 1,
    failureAbove: 35,
    unit: 'percent',
  },
  {
    id: 'screen_obscuration',
    kind: 'screen_coverage',
    warningAbove: 30,
    failureAbove: 45,
    wideWarningAbove: 22,
    wideFailureAbove: 35,
    unit: 'percent',
  },
  {
    id: 'forward_axis',
    kind: 'axis_alignment',
    warningBelow: 0.866025,
    failureBelow: 0,
    unit: 'dot',
  },
  {
    id: 'hand_symmetry',
    kind: 'mirror_delta',
    warningAbove: 0.5,
    failureAbove: 1,
    unit: 'model_pixels',
  },
  {
    id: 'frame_retention',
    kind: 'frame_retention',
    warningBelow: 98,
    failureBelow: 85,
    unit: 'percent',
  },
]);

function hashPlan(value: Omit<SceneProfilePlan, 'planSha256'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function finalizeReviewPlan(
  profileId: ReviewProfileId,
  scenes: readonly ReviewSceneDefinition[],
  measurements: readonly ReviewMeasurementRule[],
): SceneProfilePlan {
  if (scenes.length === 0 || scenes.length > MAX_REVIEW_SCENES) {
    throw new Error(
      `Review profile '${profileId}' requires between one and ${String(MAX_REVIEW_SCENES)} scenes.`,
    );
  }
  const ids = new Set<string>();
  for (const scene of scenes) {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(scene.id) || ids.has(scene.id)) {
      throw new Error(`Review profile contains an invalid or duplicate scene ID: ${scene.id}`);
    }
    if (
      !Number.isSafeInteger(scene.width) ||
      !Number.isSafeInteger(scene.height) ||
      scene.width < 32 ||
      scene.height < 32 ||
      scene.width > 256 ||
      scene.height > 256
    ) {
      throw new Error(`Review scene '${scene.id}' has dimensions outside 32 through 256 pixels.`);
    }
    ids.add(scene.id);
  }
  const measurementIds = new Set<string>();
  for (const measurement of measurements) {
    if (measurementIds.has(measurement.id)) {
      throw new Error(`Review profile contains duplicate measurement '${measurement.id}'.`);
    }
    measurementIds.add(measurement.id);
    if ('sceneIds' in measurement) {
      for (const sceneId of measurement.sceneIds) {
        if (!ids.has(sceneId)) {
          throw new Error(
            `Review measurement '${measurement.id}' references missing scene '${sceneId}'.`,
          );
        }
      }
    }
  }
  const base = {
    schemaVersion: 1 as const,
    profileId,
    profileVersion: 1,
    rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
    scenes,
    requiredViewIds: scenes.filter((scene) => scene.required).map((scene) => scene.id),
    measurements,
  };
  return { ...base, planSha256: hashPlan(base) };
}

export const HELD_ITEM_PROFILE: SceneProfile = Object.freeze({
  id: 'held_item',
  version: HELD_ITEM_PROFILE_VERSION,
  createPlan(spec: ModelSpec, viewSize: number): SceneProfilePlan {
    return finalizeReviewPlan('held_item', heldItemScenes(spec, viewSize), HELD_ITEM_MEASUREMENTS);
  },
});

function environmentScenes(
  scenes: readonly EnvironmentReviewSceneDefinition[],
): readonly ReviewSceneDefinition[] {
  return scenes.map(({ profileCategory, ...scene }) => ({
    ...scene,
    category: profileCategory,
  }));
}

function environmentProfile(id: 'block' | 'gui_item' | 'placeable' | 'projectile'): SceneProfile {
  const factory = ENVIRONMENT_PROFILE_FACTORIES[id];
  return Object.freeze({
    id,
    version: factory.version,
    createPlan(spec: ModelSpec, viewSize: number): SceneProfilePlan {
      let scenes: readonly EnvironmentReviewSceneDefinition[];
      switch (id) {
        case 'block': {
          const options = spec.blockReview ?? {
            adjacentBlocks: true,
            lightingChecks: true,
            cullingChecks: true,
          };
          scenes = factory
            .createScenes(viewSize, {
              multipart: spec.states.length > 0,
              transparency: Object.values(spec.materials).some((material) => material.transparent),
            })
            .filter(
              (scene) =>
                (options.adjacentBlocks || scene.id !== 'block_adjacent') &&
                (options.lightingChecks || scene.id !== 'block_lighting') &&
                (options.cullingChecks || !scene.id.startsWith('block_culling')),
            );
          break;
        }
        case 'placeable': {
          const options = spec.placeableReview ?? {
            orientations: ['north', 'east', 'south', 'west'],
            attachments: ['floor', 'wall', 'ceiling'],
            footprint: [16, 16],
          };
          scenes = factory
            .createScenes(viewSize, {
              wall: options.attachments.includes('wall'),
              ceiling: options.attachments.includes('ceiling'),
            })
            .filter((scene) => {
              const orientation = /^placeable_(north|east|south|west)$/u.exec(scene.id)?.[1];
              if (
                orientation !== undefined &&
                !options.orientations.includes(orientation as (typeof options.orientations)[number])
              ) {
                return false;
              }
              const attachment = /^placeable_(floor|wall|ceiling)$/u.exec(scene.id)?.[1];
              return (
                attachment === undefined ||
                options.attachments.includes(attachment as (typeof options.attachments)[number])
              );
            });
          break;
        }
        case 'projectile': {
          const options = spec.projectileReview ?? {
            forwardAxis: [0, 0, -1],
            inHand: true,
            impact: true,
            stuckDepth: 2,
          };
          scenes = factory
            .createScenes(viewSize)
            .filter(
              (scene) =>
                (options.inHand || scene.id !== 'projectile_in_hand') &&
                (options.impact || !/^projectile_(impact|stuck)$/u.test(scene.id)),
            );
          break;
        }
        case 'gui_item': {
          const options = spec.guiItemReview ?? {
            counts: [1, 64],
            durability: true,
            glint: true,
          };
          scenes = factory
            .createScenes(viewSize, { counts: options.counts, selectedHotbar: true })
            .filter(
              (scene) =>
                (options.durability || scene.id !== 'gui_durability') &&
                (options.glint || scene.id !== 'gui_glint'),
            );
          break;
        }
      }
      return finalizeReviewPlan(id, environmentScenes(scenes), factory.measurements);
    },
  });
}

function characterItemPose(
  scene: Readonly<{ id: string; assetState: CharacterAssetState }>,
): ReviewItemPose | undefined {
  if (scene.assetState.kind === 'head_wearable') {
    return scene.id.startsWith('head_stand_')
      ? {
          rotation: [0, 0, 0],
          translation: [
            ARMOR_STAND_HEAD_ANCHOR[0] - 8,
            ARMOR_STAND_HEAD_ANCHOR[1] - 8,
            ARMOR_STAND_HEAD_ANCHOR[2] - 8,
          ],
          scale: [1, 1, 1],
        }
      : undefined;
  }
  if (scene.assetState.kind === 'armor') {
    const isolatedSlot =
      scene.assetState.isolateSlots || scene.assetState.visibleSlots.length === 1
        ? scene.assetState.visibleSlots[0]
        : undefined;
    const anchor = isolatedSlot === undefined ? undefined : ARMOR_SLOT_ANCHORS[isolatedSlot];
    const translation: Vector3 =
      anchor === undefined ? [0, 0, 0] : [anchor[0] - 8, anchor[1] - 8, anchor[2] - 8];
    if (scene.assetState.pose === 'walking') {
      return { rotation: [0, 0, 5], translation, scale: [1, 1, 1] };
    }
    if (scene.assetState.pose === 'crouching') {
      return {
        rotation: [12, 0, 0],
        translation: [translation[0], translation[1] - 1, translation[2] + 1],
        scale: [1, 1, 1],
      };
    }
    if (anchor !== undefined) {
      return { rotation: [0, 0, 0], translation, scale: [1, 1, 1] };
    }
  }
  if (scene.assetState.kind === 'entity_model' && scene.assetState.animationPose !== undefined) {
    const pose = scene.assetState.animationPose;
    return {
      rotation:
        pose === 'attacking' || pose === 'attack'
          ? [0, 15, -10]
          : pose === 'walking' || pose === 'walk'
            ? [0, 0, 6]
            : [0, 0, 0],
      translation: [0, 0, 0],
      scale: [1, 1, 1],
    };
  }
  return undefined;
}

function characterScenes(
  scenes: readonly Readonly<{
    id: string;
    title: string;
    category: ReviewSceneCategory;
    required: boolean;
    width: number;
    height: number;
    camera: ReviewCamera;
    referenceGeometry: readonly CharacterReferenceGeometry[];
    framing: CharacterSceneFraming;
    assetState: CharacterAssetState;
  }>[],
): readonly ReviewSceneDefinition[] {
  return scenes.map((scene) => {
    const itemPose = characterItemPose(scene);
    return {
      ...scene,
      ...(itemPose === undefined ? {} : { itemPose }),
    };
  });
}

function filterCharacterMeasurements(
  measurements: readonly CharacterReviewMeasurementRule[],
  sceneIds: ReadonlySet<string>,
  preserveAsSkipped: ReadonlySet<CharacterReviewMeasurementRule['id']> = new Set(),
): readonly CharacterReviewMeasurementRule[] {
  return measurements.flatMap((measurement) => {
    if (preserveAsSkipped.has(measurement.id)) return [{ ...measurement, sceneIds: [] }];
    const applicable = measurement.sceneIds.filter((sceneId) => sceneIds.has(sceneId));
    if (applicable.length > 0) return [{ ...measurement, sceneIds: applicable }];
    return [];
  });
}

function characterProfile(id: 'armor' | 'entity_model' | 'head_wearable'): SceneProfile {
  return Object.freeze({
    id,
    version: 1,
    createPlan(spec: ModelSpec, viewSize: number): SceneProfilePlan {
      let raw;
      const preserveAsSkipped = new Set<CharacterReviewMeasurementRule['id']>();
      switch (id) {
        case 'armor': {
          const options = spec.armorReview ?? {
            slots: ['head', 'chest', 'legs', 'feet'],
            bodyVariants: ['steve', 'alex'],
            poses: ['neutral', 'walking', 'crouching'],
          };
          raw = createArmorReviewPlan({ viewSize, slots: options.slots });
          if (options.bodyVariants.length < 2) preserveAsSkipped.add('armor_variant_fit');
          raw = {
            ...raw,
            scenes: raw.scenes.filter((scene) => {
              const variant = /armor_(steve|alex)_/u.exec(scene.id)?.[1];
              if (
                variant !== undefined &&
                !options.bodyVariants.includes(variant as 'steve' | 'alex')
              ) {
                return false;
              }
              if (scene.id.endsWith('_walking')) return options.poses.includes('walking');
              if (scene.id.endsWith('_crouching')) return options.poses.includes('crouching');
              return options.poses.includes('neutral') || scene.id.startsWith('armor_slot_');
            }),
          };
          break;
        }
        case 'head_wearable': {
          const options = spec.headWearableReview ?? {
            bodyVariants: ['steve', 'alex'],
            firstPersonObstruction: true,
            armorStand: true,
          };
          raw = createHeadWearableReviewPlan({ viewSize });
          if (options.bodyVariants.length < 2) preserveAsSkipped.add('head_variant_fit');
          raw = {
            ...raw,
            scenes: raw.scenes.filter((scene) => {
              const variant = /^head_(steve|alex)_/u.exec(scene.id)?.[1];
              return (
                (variant === undefined ||
                  options.bodyVariants.includes(variant as 'steve' | 'alex')) &&
                (options.firstPersonObstruction || !scene.id.startsWith('head_fp_')) &&
                (options.armorStand || !scene.id.startsWith('head_stand_'))
              );
            }),
          };
          break;
        }
        case 'entity_model': {
          const options = spec.entityModelReview ?? {
            hitbox: [8, 16, 8],
            animationPoses: ['idle', 'walking', 'attacking'],
            playerScaleReference: true,
          };
          raw = createEntityModelReviewPlan({
            viewSize,
            animationPoses: options.animationPoses,
            hitbox: {
              width: options.hitbox[0],
              height: options.hitbox[1],
              depth: options.hitbox[2],
            },
          });
          if (!options.playerScaleReference) {
            raw = {
              ...raw,
              scenes: raw.scenes.filter((scene) => !scene.id.startsWith('entity_scale_')),
            };
          }
          break;
        }
      }
      const ids = new Set(raw.scenes.map((scene) => scene.id));
      return finalizeReviewPlan(
        id,
        characterScenes(raw.scenes),
        filterCharacterMeasurements(raw.measurements, ids, preserveAsSkipped),
      );
    },
  });
}

export const BLOCK_PROFILE = environmentProfile('block');
export const PLACEABLE_PROFILE = environmentProfile('placeable');
export const PROJECTILE_PROFILE = environmentProfile('projectile');
export const GUI_ITEM_PROFILE = environmentProfile('gui_item');
export const ARMOR_PROFILE = characterProfile('armor');
export const HEAD_WEARABLE_PROFILE = characterProfile('head_wearable');
export const ENTITY_MODEL_PROFILE = characterProfile('entity_model');

export const REVIEW_PROFILES: Readonly<Record<ReviewProfileId, SceneProfile>> = Object.freeze({
  held_item: HELD_ITEM_PROFILE,
  block: BLOCK_PROFILE,
  placeable: PLACEABLE_PROFILE,
  armor: ARMOR_PROFILE,
  head_wearable: HEAD_WEARABLE_PROFILE,
  projectile: PROJECTILE_PROFILE,
  gui_item: GUI_ITEM_PROFILE,
  entity_model: ENTITY_MODEL_PROFILE,
});

export function isReviewProfileId(value: unknown): value is ReviewProfileId {
  return typeof value === 'string' && (REVIEW_PROFILE_IDS as readonly string[]).includes(value);
}

export function reviewProfileVersion(profileId: ReviewProfileId): number {
  return REVIEW_PROFILES[profileId].version;
}

export function reviewProfileMeasurementIds(
  plan: SceneProfilePlan,
): ReadonlySet<ReviewMeasurementId> {
  return new Set<ReviewMeasurementId>(plan.measurements.map((measurement) => measurement.id));
}

export function resolveReviewProfile(spec: ModelSpec, viewSize: number): SceneProfilePlan {
  const profile = REVIEW_PROFILES[spec.reviewProfile];
  return profile.createPlan(spec, viewSize);
}
