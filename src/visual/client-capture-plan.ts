import {
  ClientCaptureSceneSchema,
  type ClientCaptureExecution,
  type ClientCapturePlan,
  type ClientCaptureProvenance,
  type ClientCaptureScene,
  createClientCapturePlan,
} from '../minecraft/client-capture-protocol.js';
import type { ItemBindingProposal } from './compiler.js';
import type { ModelSpec } from './model-spec.js';
import { assertClientCaptureReviewSupport } from './client-capture-support.js';
import { resolveReviewProfile, type ReviewSceneDefinition } from './review-profile.js';

export interface ClientCaptureSceneOptions {
  readonly width: number;
  readonly height: number;
  readonly guiScale: number;
  readonly includeScaleReferenceViews?: boolean | undefined;
}

export interface CreateVisualClientCapturePlanInput extends ClientCaptureSceneOptions {
  readonly spec: ModelSpec;
  readonly provenance: ClientCaptureProvenance;
  readonly execution: ClientCaptureExecution;
}

/**
 * The proposal keeps component values in their semantic JSON form, while the
 * client protocol independently reparses a command-literal map. Quote the
 * resource location exactly as Minecraft's item parser expects so the two
 * representations can be compared without trusting the give command alone.
 */
export function clientCaptureComponentLiterals(
  binding: ItemBindingProposal,
): Readonly<Record<'minecraft:item_model', string>> {
  return Object.freeze({
    'minecraft:item_model': JSON.stringify(binding.itemStack.components['minecraft:item_model']),
  });
}

function cameraForScene(scene: ReviewSceneDefinition): ClientCaptureScene['camera'] {
  // Held-item action scenes retain a first-person player rig but use the
  // generic `conditional` category in the portable review plan. Preserve the
  // actual camera identity in the client protocol instead of relabeling those
  // frames as neutral.
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

function contextForScene(scene: ReviewSceneDefinition): ClientCaptureScene['context'] {
  if (scene.category === 'inventory' || scene.category === 'overlay') return 'inventory';
  if (scene.category === 'hotbar' || scene.id.includes('hotbar')) return 'hotbar';
  if (scene.category === 'tooltip') return 'tooltip';
  if (scene.category === 'neutral') return 'item_inspection';
  return 'world';
}

function animationForScene(
  spec: ModelSpec,
  scene: ReviewSceneDefinition,
): ClientCaptureScene['animationState'] {
  if (scene.id.includes('swing')) return 'swing';
  // A declared muzzle/forward axis adds an aiming composition even when the
  // vanilla carrier has no active-use behavior. Only request Minecraft's
  // native use animation when the semantic spec explicitly asks for it;
  // otherwise a stick-like carrier would fail capture merely for declaring
  // its forward direction.
  if (scene.id.includes('aim')) return spec.heldItem?.usePose === 'aim' ? 'aim' : 'idle';
  if (scene.id.includes('active_use')) {
    return spec.heldItem?.usePose === 'aim' ? 'aim' : 'use';
  }
  return 'idle';
}

function presentationForScene(
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

function sceneFov(scene: ReviewSceneDefinition): number {
  if (scene.camera.kind !== 'perspective') return 70;
  return Math.max(30, Math.min(120, Math.round(scene.camera.verticalFovDegrees)));
}

function sceneGuiScale(
  spec: ModelSpec,
  scene: ReviewSceneDefinition,
  requestedScale: number,
): number {
  if (spec.reviewProfile !== 'gui_item') return requestedScale;
  // Minecraft's inventory renderer draws an item at 16 logical pixels. These
  // canonical scenes therefore need distinct real GUI scales to exercise the
  // requested 32- and 64-physical-pixel cases instead of capturing the same
  // inventory presentation twice under different labels.
  if (scene.id === 'gui_inventory_32') return 2;
  if (scene.id === 'gui_inventory_64') return 4;
  return requestedScale;
}

/**
 * Lower a model-specific review profile to scenes the bundled capture mod can
 * execute through Minecraft's own renderer. Unsupported compiler/profile
 * combinations fail explicitly instead of being substituted with CPU images.
 */
export function createVisualClientCaptureScenes(
  spec: ModelSpec,
  options: ClientCaptureSceneOptions,
): readonly ClientCaptureScene[] {
  assertClientCaptureReviewSupport(spec.reviewProfile);
  if (spec.reviewProfile === 'held_item' && spec.heldItem?.secondaryGrip !== undefined) {
    throw new Error(
      'Official-client capture for two-handed held items is not yet authoritative because the capture mod does not pose and verify the gameplay hand at secondaryGrip.',
    );
  }
  const reviewPlan = resolveReviewProfile(spec, 128);
  return reviewPlan.scenes.flatMap((scene) => {
    const camera = cameraForScene(scene);
    const context = contextForScene(scene);
    const isFirstPersonWorld = camera === 'first_person' && context === 'world';
    const viewKinds: readonly ClientCaptureScene['viewKind'][] = isFirstPersonWorld
      ? options.includeScaleReferenceViews === true
        ? ['first_person_vanilla', 'first_person_scale_reference']
        : ['first_person_vanilla']
      : ['minecraft_vanilla'];
    return viewKinds.map((viewKind) => {
      const presentation = presentationForScene(spec, scene, viewKind);
      return ClientCaptureSceneSchema.parse({
        id: isFirstPersonWorld ? `${viewKind}--${scene.id}` : scene.id,
        baseSceneId: scene.id,
        viewKind,
        requiredForAuthority: viewKind !== 'first_person_scale_reference',
        camera,
        context,
        hand: scene.hand ?? 'right',
        playerModel: scene.referenceRig?.variant ?? 'steve',
        fov: sceneFov(scene),
        resolution: { width: options.width, height: options.height },
        guiScale: sceneGuiScale(spec, scene, options.guiScale),
        animationState: animationForScene(spec, scene),
        frame: scene.id.includes('swing') ? 4 : scene.id.includes('active_use') ? 10 : 0,
        ...(presentation === undefined ? {} : { presentation }),
      });
    });
  });
}

export function createVisualClientCapturePlan(
  input: CreateVisualClientCapturePlanInput,
): ClientCapturePlan {
  return createClientCapturePlan({
    schemaVersion: 2,
    kind: 'packwright.client-capture-plan',
    minecraftVersion: '26.2',
    provenance: input.provenance,
    scenes: createVisualClientCaptureScenes(input.spec, input),
    execution: input.execution,
  });
}
