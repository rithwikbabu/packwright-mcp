import { createHash } from 'node:crypto';

import type { DisplayContext, ModelSpec, Vector3 } from './model-spec.js';

export const REVIEW_PROFILE_RENDERER_VERSION = 'packwright-cpu-v2' as const;
export const HELD_ITEM_PROFILE_VERSION = 1 as const;
export const MAX_REVIEW_SCENES = 16;

export type ReviewProfileId = 'held_item';
export type PlayerArmVariant = 'steve' | 'alex';
export type ReviewHand = 'left' | 'right';
export type ReviewPose = 'neutral' | 'swing_midpoint' | 'active_use' | 'two_handed' | 'aiming';

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

export interface ReviewSceneDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: 'first_person' | 'third_person' | 'neutral' | 'conditional';
  readonly required: boolean;
  readonly width: number;
  readonly height: number;
  readonly camera: ReviewCamera;
  readonly displayContext?: DisplayContext | undefined;
  readonly hand?: ReviewHand | undefined;
  readonly referenceRig?: PlayerReferenceRig | undefined;
  readonly itemPose?: ReviewItemPose | undefined;
}

export type ReviewMeasurementRule =
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
  readonly metric: ReviewMeasurementRule['id'];
  readonly view?: string | undefined;
  readonly status: ReviewMeasurementStatus;
  readonly value?: number | undefined;
  readonly threshold?: number | undefined;
  readonly unit: ReviewMeasurementRule['unit'];
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

export const HELD_ITEM_PROFILE: SceneProfile = Object.freeze({
  id: 'held_item',
  version: HELD_ITEM_PROFILE_VERSION,
  createPlan(spec: ModelSpec, viewSize: number): SceneProfilePlan {
    const scenes = heldItemScenes(spec, viewSize);
    if (scenes.length > MAX_REVIEW_SCENES) {
      throw new Error(`Review profile exceeds the ${String(MAX_REVIEW_SCENES)}-scene limit.`);
    }
    const ids = new Set<string>();
    for (const scene of scenes) {
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(scene.id) || ids.has(scene.id)) {
        throw new Error(`Review profile contains an invalid or duplicate scene ID: ${scene.id}`);
      }
      ids.add(scene.id);
    }
    const base = {
      schemaVersion: 1 as const,
      profileId: 'held_item' as const,
      profileVersion: HELD_ITEM_PROFILE_VERSION,
      rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
      scenes,
      requiredViewIds: scenes.filter((scene) => scene.required).map((scene) => scene.id),
      measurements: HELD_ITEM_MEASUREMENTS,
    };
    return { ...base, planSha256: hashPlan(base) };
  },
});

export const REVIEW_PROFILES: Readonly<Record<ReviewProfileId, SceneProfile>> = Object.freeze({
  held_item: HELD_ITEM_PROFILE,
});

export function resolveReviewProfile(spec: ModelSpec, viewSize: number): SceneProfilePlan {
  const profile = REVIEW_PROFILES[spec.reviewProfile];
  return profile.createPlan(spec, viewSize);
}
