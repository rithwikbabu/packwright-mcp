import { createHash } from 'node:crypto';

import type { ReviewCamera } from '../review-profile.js';

const MAX_REVIEW_SCENES = 16 as const;
const REVIEW_PROFILE_RENDERER_VERSION = 'packwright-cpu-v2' as const;

export const CHARACTER_REVIEW_PROFILE_VERSION = 1 as const;

export const CHARACTER_REVIEW_PROFILE_IDS = ['armor', 'head_wearable', 'entity_model'] as const;

export type CharacterReviewProfileId = (typeof CHARACTER_REVIEW_PROFILE_IDS)[number];
export type CharacterPlayerVariant = 'steve' | 'alex';
export type ArmorSlot = 'head' | 'chest' | 'legs' | 'feet';
export type CharacterBodyPose = 'neutral' | 'walking' | 'crouching';

/** Original review-rig anchors in the shared 16-unit model coordinate system. */
export const ARMOR_SLOT_ANCHORS = Object.freeze({
  head: [8, 19, 8],
  chest: [8, 10, 8],
  legs: [8, 0.5, 8],
  feet: [8, -6, 8],
} as const satisfies Readonly<Record<ArmorSlot, readonly [number, number, number]>>);

/** Original armor-stand reference rig's head attachment point. */
export const ARMOR_STAND_HEAD_ANCHOR = [8, 18, 8] as const;

export interface CharacterHitbox {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly offset?: readonly [number, number, number] | undefined;
}

export type CharacterReferenceGeometry =
  | Readonly<{
      kind: 'player';
      variant: CharacterPlayerVariant;
      scope: 'body' | 'head';
      pose: CharacterBodyPose;
      opacity: number;
      armorSlots?: readonly ArmorSlot[] | undefined;
    }>
  | Readonly<{
      kind: 'first_person_head';
      variant: CharacterPlayerVariant;
      eyeHeight: number;
      opacity: number;
    }>
  | Readonly<{
      kind: 'armor_stand';
      pose: 'neutral';
      showBasePlate: boolean;
      opacity: number;
    }>
  | Readonly<{
      kind: 'hitbox';
      source: 'declared' | 'computed';
      bounds?: CharacterHitbox | undefined;
      style: 'wireframe';
    }>
  | Readonly<{
      kind: 'ground_plane';
      gridSize: number;
      opacity: number;
    }>;

export type CharacterAssetState =
  | Readonly<{
      kind: 'armor';
      visibleSlots: readonly ArmorSlot[];
      isolateSlots: boolean;
      pose: CharacterBodyPose;
    }>
  | Readonly<{
      kind: 'head_wearable';
    }>
  | Readonly<{
      kind: 'entity_model';
      animationPose?: string | undefined;
      hitboxOverlay: boolean;
    }>;

export type CharacterSceneFraming =
  | Readonly<{
      kind: 'fit_reference';
      marginPercent: number;
    }>
  | Readonly<{
      kind: 'fit_subject';
      marginPercent: number;
    }>
  | Readonly<{
      kind: 'player_relative';
      marginPercent: number;
    }>
  | Readonly<{
      kind: 'first_person_eye';
      eye: 'left' | 'right' | 'center';
    }>;

export type CharacterSceneCategory =
  | 'character'
  | 'slot'
  | 'pose'
  | 'first_person'
  | 'reference'
  | 'neutral'
  | 'turntable'
  | 'scale'
  | 'overlay';

/** Renderer-neutral scene metadata consumed by the generic scene-profile adapter. */
export interface CharacterReviewSceneDefinition {
  readonly id: string;
  readonly title: string;
  readonly category: CharacterSceneCategory;
  readonly required: boolean;
  readonly width: number;
  readonly height: number;
  readonly camera: ReviewCamera;
  readonly framing: CharacterSceneFraming;
  readonly referenceGeometry: readonly CharacterReferenceGeometry[];
  readonly assetState: CharacterAssetState;
}

export type CharacterMeasurementThreshold =
  | Readonly<{
      comparison: 'above';
      warning: number;
      failure: number;
    }>
  | Readonly<{
      comparison: 'below';
      warning: number;
      failure: number;
    }>
  | Readonly<{
      comparison: 'outside';
      warningRange: readonly [number, number];
      failureRange: readonly [number, number];
    }>;

export type CharacterMeasurementKind =
  | 'aabb_overlap'
  | 'anchor_distance'
  | 'frame_retention'
  | 'screen_coverage'
  | 'surface_clearance'
  | 'variant_delta'
  | 'pose_intersection'
  | 'scale_ratio_delta'
  | 'hitbox_containment'
  | 'hitbox_empty_space'
  | 'ground_contact';

export type CharacterMeasurementUnit = 'model_pixels' | 'percent' | 'ratio' | 'screen_percent';

export type CharacterReviewMeasurementId =
  | 'armor_body_intersection'
  | 'armor_frame_retention'
  | 'armor_pose_clipping'
  | 'armor_slot_alignment'
  | 'armor_surface_clearance'
  | 'armor_variant_fit'
  | 'entity_frame_retention'
  | 'entity_ground_contact'
  | 'entity_hitbox_containment'
  | 'entity_hitbox_empty_space'
  | 'entity_player_scale'
  | 'entity_pose_intersection'
  | 'head_armor_stand_alignment'
  | 'head_first_person_obscuration'
  | 'head_frame_retention'
  | 'head_player_intersection'
  | 'head_variant_fit';

/** All automated character measurements are advisory until client-capture calibration exists. */
export interface CharacterReviewMeasurementRule {
  readonly id: CharacterReviewMeasurementId;
  readonly kind: CharacterMeasurementKind;
  readonly authority: 'advisory';
  readonly description: string;
  readonly sceneIds: readonly string[];
  readonly unit: CharacterMeasurementUnit;
  readonly threshold: CharacterMeasurementThreshold;
}

export type CharacterReviewProfileMetadata =
  | Readonly<{
      kind: 'armor';
      slots: readonly ArmorSlot[];
    }>
  | Readonly<{
      kind: 'head_wearable';
      attachment: 'head';
    }>
  | Readonly<{
      kind: 'entity_model';
      animationPoses: readonly string[];
      expectedPlayerHeightRatio: number;
      hitboxSource: 'declared' | 'computed';
      hitbox?: CharacterHitbox | undefined;
    }>;

export interface CharacterSceneProfilePlan {
  readonly schemaVersion: 1;
  readonly profileId: CharacterReviewProfileId;
  readonly profileVersion: typeof CHARACTER_REVIEW_PROFILE_VERSION;
  readonly rendererVersion: typeof REVIEW_PROFILE_RENDERER_VERSION;
  readonly authority: 'advisory';
  readonly metadata: CharacterReviewProfileMetadata;
  readonly scenes: readonly CharacterReviewSceneDefinition[];
  readonly requiredViewIds: readonly string[];
  readonly optionalViewIds: readonly string[];
  readonly measurements: readonly CharacterReviewMeasurementRule[];
  readonly planSha256: string;
}

interface CharacterProfileInput {
  readonly viewSize: number;
  /** Optional scenes are included by default and still participate in advisory checks. */
  readonly includeOptionalViews?: boolean | undefined;
}

export interface ArmorReviewProfileInput extends CharacterProfileInput {
  /** Defaults to all vanilla equipment slots; input ordering is canonicalized. */
  readonly slots?: readonly ArmorSlot[] | undefined;
}

export type HeadWearableReviewProfileInput = CharacterProfileInput;

export interface EntityModelReviewProfileInput extends CharacterProfileInput {
  /** At most three stable semantic pose IDs. Defaults to idle, walk, and attack. */
  readonly animationPoses?: readonly string[] | undefined;
  /** Desired entity height divided by player height; defaults to 1. */
  readonly expectedPlayerHeightRatio?: number | undefined;
  /** Omit to request a renderer-computed visual bounds overlay. */
  readonly hitbox?: CharacterHitbox | undefined;
}

export interface CharacterSceneProfile<TInput extends CharacterProfileInput> {
  readonly id: CharacterReviewProfileId;
  readonly version: typeof CHARACTER_REVIEW_PROFILE_VERSION;
  readonly authority: 'advisory';
  readonly maxScenes: typeof MAX_REVIEW_SCENES;
  createPlan(input: TInput): CharacterSceneProfilePlan;
}

const ARMOR_SLOT_ORDER: readonly ArmorSlot[] = ['head', 'chest', 'legs', 'feet'];
const PLAYER_VARIANTS: readonly CharacterPlayerVariant[] = ['steve', 'alex'];
const VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/u;
const POSE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/u;
const MIN_VIEW_SIZE = 32;
const MAX_VIEW_SIZE = 256;

const perspective = (
  yaw: number,
  pitch: number,
  verticalFovDegrees: number,
  cameraDistance: number,
): ReviewCamera => ({
  kind: 'perspective',
  yaw,
  pitch,
  roll: 0,
  verticalFovDegrees,
  cameraDistance,
  nearPlane: 0.25,
});

const orthographic = (yaw: number, pitch: number, scale: number): ReviewCamera => ({
  kind: 'orthographic',
  yaw,
  pitch,
  roll: 0,
  scale,
});

function validateViewSize(viewSize: number): number {
  if (!Number.isSafeInteger(viewSize) || viewSize < MIN_VIEW_SIZE || viewSize > MAX_VIEW_SIZE) {
    throw new Error(
      `Character review view size must be an integer from ${String(MIN_VIEW_SIZE)} through ${String(MAX_VIEW_SIZE)}.`,
    );
  }
  return viewSize;
}

function playerReference(
  variant: CharacterPlayerVariant,
  scope: 'body' | 'head',
  pose: CharacterBodyPose,
  armorSlots?: readonly ArmorSlot[],
): CharacterReferenceGeometry {
  return {
    kind: 'player',
    variant,
    scope,
    pose,
    opacity: 0.7,
    ...(armorSlots === undefined ? {} : { armorSlots }),
  };
}

function characterView(
  id: string,
  title: string,
  size: number,
  yaw: number,
  referenceGeometry: readonly CharacterReferenceGeometry[],
  assetState: CharacterAssetState,
  options: Readonly<{
    required?: boolean;
    category?: CharacterSceneCategory;
    pitch?: number;
    scale?: number;
    framing?: CharacterSceneFraming;
  }> = {},
): CharacterReviewSceneDefinition {
  return {
    id,
    title,
    category: options.category ?? 'character',
    required: options.required ?? true,
    width: size,
    height: size,
    camera: orthographic(yaw, options.pitch ?? -5, options.scale ?? 0.72),
    framing: options.framing ?? { kind: 'fit_reference', marginPercent: 8 },
    referenceGeometry,
    assetState,
  };
}

function filterOptionalScenes(
  scenes: readonly CharacterReviewSceneDefinition[],
  includeOptionalViews: boolean | undefined,
): readonly CharacterReviewSceneDefinition[] {
  return includeOptionalViews === false ? scenes.filter((scene) => scene.required) : scenes;
}

function filterMeasurements(
  measurements: readonly CharacterReviewMeasurementRule[],
  scenes: readonly CharacterReviewSceneDefinition[],
): readonly CharacterReviewMeasurementRule[] {
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  return measurements.flatMap((measurement) => {
    const applicable = measurement.sceneIds.filter((id) => sceneIds.has(id));
    return applicable.length === 0 ? [] : [{ ...measurement, sceneIds: applicable }];
  });
}

function planHash(plan: Omit<CharacterSceneProfilePlan, 'planSha256'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function createPlan(
  profileId: CharacterReviewProfileId,
  metadata: CharacterReviewProfileMetadata,
  scenes: readonly CharacterReviewSceneDefinition[],
  measurements: readonly CharacterReviewMeasurementRule[],
): CharacterSceneProfilePlan {
  if (scenes.length === 0 || scenes.length > MAX_REVIEW_SCENES) {
    throw new Error(
      `Character review profile '${profileId}' requires between 1 and ${String(MAX_REVIEW_SCENES)} scenes.`,
    );
  }
  const sceneIds = new Set<string>();
  for (const scene of scenes) {
    if (!VIEW_ID_PATTERN.test(scene.id) || sceneIds.has(scene.id)) {
      throw new Error(
        `Character review profile '${profileId}' has invalid scene ID '${scene.id}'.`,
      );
    }
    sceneIds.add(scene.id);
  }
  for (const measurement of measurements) {
    if (measurement.sceneIds.some((id) => !sceneIds.has(id))) {
      throw new Error(
        `Character review measurement '${measurement.id}' references a missing scene.`,
      );
    }
  }
  const base = {
    schemaVersion: 1 as const,
    profileId,
    profileVersion: CHARACTER_REVIEW_PROFILE_VERSION,
    rendererVersion: REVIEW_PROFILE_RENDERER_VERSION,
    authority: 'advisory' as const,
    metadata,
    scenes,
    requiredViewIds: scenes.filter((scene) => scene.required).map((scene) => scene.id),
    optionalViewIds: scenes.filter((scene) => !scene.required).map((scene) => scene.id),
    measurements,
  };
  return { ...base, planSha256: planHash(base) };
}

function normalizeArmorSlots(slots: readonly ArmorSlot[] | undefined): readonly ArmorSlot[] {
  const requested = new Set(slots ?? ARMOR_SLOT_ORDER);
  if (requested.size === 0) throw new Error('Armor review requires at least one equipment slot.');
  if ((slots?.length ?? requested.size) !== requested.size) {
    throw new Error('Armor review slots must not contain duplicates.');
  }
  const normalized = ARMOR_SLOT_ORDER.filter((slot) => requested.has(slot));
  if (normalized.length !== requested.size) {
    throw new Error('Armor review contains an unknown equipment slot.');
  }
  return normalized;
}

function armorState(
  slots: readonly ArmorSlot[],
  pose: CharacterBodyPose = 'neutral',
  isolateSlots = false,
): CharacterAssetState {
  return { kind: 'armor', visibleSlots: slots, isolateSlots, pose };
}

function armorMeasurements(scenes: readonly CharacterReviewSceneDefinition[]) {
  const all = scenes.map((scene) => scene.id);
  const slotViews = scenes.filter((scene) => scene.category === 'slot').map((scene) => scene.id);
  const posed = scenes.filter((scene) => scene.category === 'pose').map((scene) => scene.id);
  const variantViews = scenes
    .filter((scene) => scene.category === 'character')
    .map((scene) => scene.id);
  return [
    {
      id: 'armor_body_intersection',
      kind: 'aabb_overlap',
      authority: 'advisory',
      description: 'Volume of the armor mesh penetrating its player reference body.',
      sceneIds: all,
      unit: 'percent',
      threshold: { comparison: 'above', warning: 5, failure: 20 },
    },
    {
      id: 'armor_surface_clearance',
      kind: 'surface_clearance',
      authority: 'advisory',
      description: 'Armor-to-skin clearance; negative values indicate penetration.',
      sceneIds: all,
      unit: 'model_pixels',
      threshold: {
        comparison: 'outside',
        warningRange: [0, 1],
        failureRange: [-0.5, 2],
      },
    },
    {
      id: 'armor_slot_alignment',
      kind: 'anchor_distance',
      authority: 'advisory',
      description: 'Distance between each isolated equipment slot and its vanilla body anchor.',
      sceneIds: slotViews,
      unit: 'model_pixels',
      threshold: { comparison: 'above', warning: 0.75, failure: 2 },
    },
    {
      id: 'armor_variant_fit',
      kind: 'variant_delta',
      authority: 'advisory',
      description: 'Fit difference between corresponding Steve and Alex silhouette views.',
      sceneIds: variantViews,
      unit: 'model_pixels',
      threshold: { comparison: 'above', warning: 0.5, failure: 1.5 },
    },
    {
      id: 'armor_pose_clipping',
      kind: 'pose_intersection',
      authority: 'advisory',
      description: 'Armor intersections introduced by walking or crouching articulation.',
      sceneIds: posed,
      unit: 'percent',
      threshold: { comparison: 'above', warning: 2, failure: 10 },
    },
    {
      id: 'armor_frame_retention',
      kind: 'frame_retention',
      authority: 'advisory',
      description: 'Projected armor geometry retained within each review frame.',
      sceneIds: all,
      unit: 'percent',
      threshold: { comparison: 'below', warning: 98, failure: 85 },
    },
  ] as const satisfies readonly CharacterReviewMeasurementRule[];
}

export function createArmorReviewPlan(input: ArmorReviewProfileInput): CharacterSceneProfilePlan {
  const size = validateViewSize(input.viewSize);
  const slots = normalizeArmorSlots(input.slots);
  const scenes: CharacterReviewSceneDefinition[] = [];
  const angles = [
    ['front', 0],
    ['rear', 180],
    ['right', -90],
    ['left', 90],
  ] as const;
  for (const variant of PLAYER_VARIANTS) {
    for (const [angle, yaw] of angles) {
      scenes.push(
        characterView(
          `armor_${variant}_${angle}`,
          `Armor on ${variant === 'steve' ? 'Steve' : 'Alex'}, ${angle}`,
          size,
          yaw,
          [playerReference(variant, 'body', 'neutral', slots)],
          armorState(slots),
        ),
      );
    }
  }
  for (const slot of slots) {
    scenes.push(
      characterView(
        `armor_slot_${slot}`,
        `Isolated ${slot} armor slot`,
        size,
        -25,
        [playerReference('steve', 'body', 'neutral', [slot])],
        armorState([slot], 'neutral', true),
        { category: 'slot', scale: 0.82 },
      ),
    );
  }
  for (const variant of PLAYER_VARIANTS) {
    scenes.push(
      characterView(
        `armor_${variant}_walking`,
        `Armor on ${variant === 'steve' ? 'Steve' : 'Alex'}, walking`,
        size,
        -25,
        [playerReference(variant, 'body', 'walking', slots)],
        armorState(slots, 'walking'),
        { category: 'pose', required: false },
      ),
      characterView(
        `armor_${variant}_crouching`,
        `Armor on ${variant === 'steve' ? 'Steve' : 'Alex'}, crouching side`,
        size,
        -90,
        [playerReference(variant, 'body', 'crouching', slots)],
        armorState(slots, 'crouching'),
        { category: 'pose', required: false },
      ),
    );
  }
  const selected = filterOptionalScenes(scenes, input.includeOptionalViews);
  return createPlan(
    'armor',
    { kind: 'armor', slots },
    selected,
    filterMeasurements(armorMeasurements(scenes), selected),
  );
}

function headMeasurements(scenes: readonly CharacterReviewSceneDefinition[]) {
  const all = scenes.map((scene) => scene.id);
  const player = scenes.filter((scene) => scene.category === 'character').map((scene) => scene.id);
  const firstPerson = scenes
    .filter((scene) => scene.category === 'first_person')
    .map((scene) => scene.id);
  const stands = scenes.filter((scene) => scene.category === 'reference').map((scene) => scene.id);
  return [
    {
      id: 'head_player_intersection',
      kind: 'aabb_overlap',
      authority: 'advisory',
      description: 'Wearable volume penetrating the player head reference.',
      sceneIds: player,
      unit: 'percent',
      threshold: { comparison: 'above', warning: 10, failure: 35 },
    },
    {
      id: 'head_variant_fit',
      kind: 'variant_delta',
      authority: 'advisory',
      description: 'Fit difference between Steve and Alex head silhouettes.',
      sceneIds: player,
      unit: 'model_pixels',
      threshold: { comparison: 'above', warning: 0.5, failure: 1.5 },
    },
    {
      id: 'head_first_person_obscuration',
      kind: 'screen_coverage',
      authority: 'advisory',
      description: 'Opaque wearable pixels obstructing the first-person eye plane.',
      sceneIds: firstPerson,
      unit: 'screen_percent',
      threshold: { comparison: 'above', warning: 15, failure: 30 },
    },
    {
      id: 'head_armor_stand_alignment',
      kind: 'anchor_distance',
      authority: 'advisory',
      description: 'Distance from the wearable attachment anchor to the armor-stand head anchor.',
      sceneIds: stands,
      unit: 'model_pixels',
      threshold: { comparison: 'above', warning: 0.75, failure: 2 },
    },
    {
      id: 'head_frame_retention',
      kind: 'frame_retention',
      authority: 'advisory',
      description: 'Projected wearable geometry retained within each review frame.',
      sceneIds: all,
      unit: 'percent',
      threshold: { comparison: 'below', warning: 98, failure: 85 },
    },
  ] as const satisfies readonly CharacterReviewMeasurementRule[];
}

export function createHeadWearableReviewPlan(
  input: HeadWearableReviewProfileInput,
): CharacterSceneProfilePlan {
  const size = validateViewSize(input.viewSize);
  const state: CharacterAssetState = { kind: 'head_wearable' };
  const scenes: CharacterReviewSceneDefinition[] = [];
  const angles = [
    ['front', 0],
    ['rear', 180],
    ['right', -90],
    ['left', 90],
  ] as const;
  for (const variant of PLAYER_VARIANTS) {
    for (const [angle, yaw] of angles) {
      scenes.push(
        characterView(
          `head_${variant}_${angle}`,
          `Head wearable on ${variant === 'steve' ? 'Steve' : 'Alex'}, ${angle}`,
          size,
          yaw,
          [playerReference(variant, 'head', 'neutral')],
          state,
          { scale: 1.4 },
        ),
      );
    }
  }
  scenes.push(
    {
      id: 'head_fp_standard',
      title: 'First-person head obstruction, standard FOV',
      category: 'first_person',
      required: true,
      width: size,
      height: Math.max(MIN_VIEW_SIZE, Math.round((size * 9) / 16)),
      camera: perspective(0, 0, 70, 8),
      framing: { kind: 'first_person_eye', eye: 'center' },
      referenceGeometry: [
        { kind: 'first_person_head', variant: 'steve', eyeHeight: 1.62, opacity: 0.25 },
      ],
      assetState: state,
    },
    {
      id: 'head_fp_wide',
      title: 'First-person head obstruction, wide FOV',
      category: 'first_person',
      required: false,
      width: size,
      height: Math.max(MIN_VIEW_SIZE, Math.round((size * 9) / 16)),
      camera: perspective(0, 0, 100, 8),
      framing: { kind: 'first_person_eye', eye: 'center' },
      referenceGeometry: [
        { kind: 'first_person_head', variant: 'steve', eyeHeight: 1.62, opacity: 0.25 },
      ],
      assetState: state,
    },
  );
  for (const [angle, yaw, required] of [
    ['front', 0, true],
    ['rear', 180, false],
    ['right', -90, true],
    ['left', 90, false],
  ] as const) {
    scenes.push(
      characterView(
        `head_stand_${angle}`,
        `Head wearable on armor stand, ${angle}`,
        size,
        yaw,
        [{ kind: 'armor_stand', pose: 'neutral', showBasePlate: true, opacity: 0.7 }],
        state,
        { category: 'reference', required, scale: 0.78 },
      ),
    );
  }
  scenes.push(
    characterView('head_neutral', 'Neutral head-wearable comparison', size, -30, [], state, {
      category: 'neutral',
      required: false,
      scale: 1.3,
      framing: { kind: 'fit_subject', marginPercent: 10 },
    }),
  );
  const selected = filterOptionalScenes(scenes, input.includeOptionalViews);
  return createPlan(
    'head_wearable',
    { kind: 'head_wearable', attachment: 'head' },
    selected,
    filterMeasurements(headMeasurements(scenes), selected),
  );
}

function validateHitbox(hitbox: CharacterHitbox | undefined): CharacterHitbox | undefined {
  if (hitbox === undefined) return undefined;
  for (const [dimension, value] of Object.entries({
    width: hitbox.width,
    height: hitbox.height,
    depth: hitbox.depth,
  })) {
    if (!Number.isFinite(value) || value <= 0 || value > 128) {
      throw new Error(`Entity ${dimension} must be greater than zero and at most 128 model units.`);
    }
  }
  if (hitbox.offset?.some((value) => !Number.isFinite(value) || Math.abs(value) > 128) === true) {
    throw new Error('Entity hitbox offsets must be finite and within 128 model units of origin.');
  }
  return {
    width: hitbox.width,
    height: hitbox.height,
    depth: hitbox.depth,
    ...(hitbox.offset === undefined
      ? {}
      : { offset: [hitbox.offset[0], hitbox.offset[1], hitbox.offset[2]] }),
  };
}

function normalizeAnimationPoses(poses: readonly string[] | undefined): readonly string[] {
  const values = poses ?? ['idle', 'walk', 'attack'];
  if (values.length > 3) throw new Error('Entity review supports at most three animation poses.');
  const unique = new Set(values);
  if (unique.size !== values.length) throw new Error('Entity animation pose IDs must be unique.');
  for (const pose of unique) {
    if (!POSE_ID_PATTERN.test(pose)) {
      throw new Error(`Invalid entity animation pose ID '${pose}'.`);
    }
  }
  return [...unique].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function entityMeasurements(scenes: readonly CharacterReviewSceneDefinition[]) {
  const all = scenes.map((scene) => scene.id);
  const poses = scenes.filter((scene) => scene.category === 'pose').map((scene) => scene.id);
  const scales = scenes.filter((scene) => scene.category === 'scale').map((scene) => scene.id);
  const overlays = scenes.filter((scene) => scene.category === 'overlay').map((scene) => scene.id);
  return [
    {
      id: 'entity_frame_retention',
      kind: 'frame_retention',
      authority: 'advisory',
      description: 'Projected entity geometry retained within each review frame.',
      sceneIds: all,
      unit: 'percent',
      threshold: { comparison: 'below', warning: 98, failure: 85 },
    },
    {
      id: 'entity_pose_intersection',
      kind: 'pose_intersection',
      authority: 'advisory',
      description: 'Self-intersection introduced by a semantic animation pose.',
      sceneIds: poses,
      unit: 'percent',
      threshold: { comparison: 'above', warning: 5, failure: 25 },
    },
    {
      id: 'entity_player_scale',
      kind: 'scale_ratio_delta',
      authority: 'advisory',
      description: 'Difference from the declared player-relative height ratio.',
      sceneIds: scales,
      unit: 'ratio',
      threshold: { comparison: 'above', warning: 0.1, failure: 0.25 },
    },
    {
      id: 'entity_hitbox_containment',
      kind: 'hitbox_containment',
      authority: 'advisory',
      description: 'Rendered entity volume contained by the declared or computed hitbox.',
      sceneIds: overlays,
      unit: 'percent',
      threshold: { comparison: 'below', warning: 95, failure: 80 },
    },
    {
      id: 'entity_hitbox_empty_space',
      kind: 'hitbox_empty_space',
      authority: 'advisory',
      description: 'Hitbox volume not occupied by rendered entity geometry.',
      sceneIds: overlays,
      unit: 'percent',
      threshold: { comparison: 'above', warning: 40, failure: 70 },
    },
    {
      id: 'entity_ground_contact',
      kind: 'ground_contact',
      authority: 'advisory',
      description: 'Vertical distance between the lowest entity point and the review ground plane.',
      sceneIds: [...poses, ...scales],
      unit: 'model_pixels',
      threshold: { comparison: 'above', warning: 0.5, failure: 2 },
    },
  ] as const satisfies readonly CharacterReviewMeasurementRule[];
}

export function createEntityModelReviewPlan(
  input: EntityModelReviewProfileInput,
): CharacterSceneProfilePlan {
  const size = validateViewSize(input.viewSize);
  const animationPoses = normalizeAnimationPoses(input.animationPoses);
  const expectedPlayerHeightRatio = input.expectedPlayerHeightRatio ?? 1;
  if (
    !Number.isFinite(expectedPlayerHeightRatio) ||
    expectedPlayerHeightRatio <= 0 ||
    expectedPlayerHeightRatio > 32
  ) {
    throw new Error('Expected player-height ratio must be greater than zero and at most 32.');
  }
  const hitbox = validateHitbox(input.hitbox);
  const neutral: CharacterAssetState = { kind: 'entity_model', hitboxOverlay: false };
  const scenes: CharacterReviewSceneDefinition[] = [];
  for (const [id, title, yaw] of [
    ['front', 'Front', 0],
    ['front_right', 'Front-right', -45],
    ['right', 'Right', -90],
    ['rear_right', 'Rear-right', -135],
    ['rear', 'Rear', 180],
    ['rear_left', 'Rear-left', 135],
    ['left', 'Left', 90],
    ['front_left', 'Front-left', 45],
  ] as const) {
    scenes.push(
      characterView(
        `entity_${id}`,
        `Entity turntable: ${title}`,
        size,
        yaw,
        [{ kind: 'ground_plane', gridSize: 16, opacity: 0.35 }],
        neutral,
        {
          category: 'turntable',
          framing: { kind: 'fit_subject', marginPercent: 10 },
          scale: 0.85,
        },
      ),
    );
  }
  for (const pose of animationPoses) {
    scenes.push(
      characterView(
        `entity_pose_${pose}`,
        `Entity animation pose: ${pose}`,
        size,
        -30,
        [{ kind: 'ground_plane', gridSize: 16, opacity: 0.35 }],
        { kind: 'entity_model', animationPose: pose, hitboxOverlay: false },
        {
          category: 'pose',
          required: false,
          framing: { kind: 'fit_subject', marginPercent: 10 },
          scale: 0.85,
        },
      ),
    );
  }
  for (const variant of PLAYER_VARIANTS) {
    scenes.push(
      characterView(
        `entity_scale_${variant}`,
        `Entity scale against ${variant === 'steve' ? 'Steve' : 'Alex'}`,
        size,
        -25,
        [
          playerReference(variant, 'body', 'neutral'),
          { kind: 'ground_plane', gridSize: 16, opacity: 0.35 },
        ],
        neutral,
        {
          category: 'scale',
          required: variant === 'steve',
          framing: { kind: 'player_relative', marginPercent: 8 },
          scale: 0.68,
        },
      ),
    );
  }
  for (const [angle, yaw, required] of [
    ['front', 0, true],
    ['side', -90, false],
  ] as const) {
    scenes.push(
      characterView(
        `entity_hitbox_${angle}`,
        `Entity hitbox overlay, ${angle}`,
        size,
        yaw,
        [
          {
            kind: 'hitbox',
            source: hitbox === undefined ? 'computed' : 'declared',
            ...(hitbox === undefined ? {} : { bounds: hitbox }),
            style: 'wireframe',
          },
          { kind: 'ground_plane', gridSize: 16, opacity: 0.35 },
        ],
        { kind: 'entity_model', hitboxOverlay: true },
        {
          category: 'overlay',
          required,
          framing: { kind: 'fit_subject', marginPercent: 12 },
          scale: 0.82,
        },
      ),
    );
  }
  const selected = filterOptionalScenes(scenes, input.includeOptionalViews);
  return createPlan(
    'entity_model',
    {
      kind: 'entity_model',
      animationPoses,
      expectedPlayerHeightRatio,
      hitboxSource: hitbox === undefined ? 'computed' : 'declared',
      ...(hitbox === undefined ? {} : { hitbox }),
    },
    selected,
    filterMeasurements(entityMeasurements(scenes), selected),
  );
}

export const ARMOR_REVIEW_PROFILE: CharacterSceneProfile<ArmorReviewProfileInput> = Object.freeze({
  id: 'armor',
  version: CHARACTER_REVIEW_PROFILE_VERSION,
  authority: 'advisory',
  maxScenes: MAX_REVIEW_SCENES,
  createPlan: createArmorReviewPlan,
});

export const HEAD_WEARABLE_REVIEW_PROFILE: CharacterSceneProfile<HeadWearableReviewProfileInput> =
  Object.freeze({
    id: 'head_wearable',
    version: CHARACTER_REVIEW_PROFILE_VERSION,
    authority: 'advisory',
    maxScenes: MAX_REVIEW_SCENES,
    createPlan: createHeadWearableReviewPlan,
  });

export const ENTITY_MODEL_REVIEW_PROFILE: CharacterSceneProfile<EntityModelReviewProfileInput> =
  Object.freeze({
    id: 'entity_model',
    version: CHARACTER_REVIEW_PROFILE_VERSION,
    authority: 'advisory',
    maxScenes: MAX_REVIEW_SCENES,
    createPlan: createEntityModelReviewPlan,
  });
