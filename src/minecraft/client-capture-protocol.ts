import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import { z } from 'zod/v4';

import { sha256Buffer } from '../core/hash.js';
import { readStableFile } from '../core/stable-file.js';
import { decodePng } from '../visual/png.js';
import { canonicalJsonBytes } from '../visual/run-store.js';

export const CLIENT_CAPTURE_PROTOCOL_VERSION = 3 as const;
export const CLIENT_CAPTURE_MINECRAFT_VERSION = '26.2' as const;
export const CLIENT_CAPTURE_MIN_SETTLE_FRAMES = 3 as const;
export const CLIENT_CAPTURE_CAMERA_POSITION_TOLERANCE = 0.05 as const;
export const CLIENT_CAPTURE_CAMERA_ANGLE_TOLERANCE = 0.25 as const;
export const CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH =
  'packwright/provenance/datapack-proposal.zip' as const;
export const CLIENT_CAPTURE_RESOURCEPACK_PATH = 'resourcepacks/packwright-proposal.zip' as const;
export const CLIENT_CAPTURE_RESOURCEPACK_ID = 'file/packwright-proposal.zip' as const;
export const CLIENT_CAPTURE_PACK_ACTIVATION = Object.freeze({
  datapack: 'hash_bound_not_loaded' as const,
  resourcepack: 'active' as const,
});

export const CLIENT_CAPTURE_LIMITS = Object.freeze({
  maxScenes: 64,
  maxPlanBytes: 1024 * 1024,
  maxItemCommandBytes: 256 * 1024,
  maxComponentValueBytes: 128 * 1024,
  maxComponentsBytes: 512 * 1024,
  maxReportBytes: 2 * 1024 * 1024,
  maxSentinelBytes: 64 * 1024,
  maxPngBytes: 8 * 1024 * 1024,
  maxLogBytes: 16 * 1024 * 1024,
  maxWidth: 4096,
  maxHeight: 4096,
  maxPixels: 16 * 1024 * 1024,
  maxFov: 120,
  minFov: 30,
  maxGuiScale: 8,
  maxFrame: 72_000,
});

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const EXECUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RESOURCE_ID_PATTERN = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u;
const MOD_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const ARTIFACT_PATH_PATTERN =
  /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})*$/u;
const MAX_RUNTIME_FIELD_LENGTH = 512;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const COMPONENT_VALUE_MAX_BYTES = 16 * 1024;

const Sha1Schema = z.string().regex(SHA1_PATTERN, 'Expected a lowercase SHA-1 hash');
const Sha256Schema = z.string().regex(SHA256_PATTERN, 'Expected a lowercase SHA-256 hash');
const SafeIdSchema = z.string().regex(SAFE_ID_PATTERN, 'Expected a canonical capture id');
const ContentIdSchema = Sha256Schema;
const ResourceIdSchema = z.string().regex(RESOURCE_ID_PATTERN, 'Expected a namespaced resource id');

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isAsciiSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function isNumericSortedUnique(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? value) < value);
}

function isCanonicalHostPath(value: string): boolean {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) return false;
  if (path.posix.isAbsolute(value)) {
    return value !== '/' && path.posix.normalize(value) === value;
  }
  if (path.win32.isAbsolute(value)) {
    const normalized = path.win32.normalize(value);
    const root = path.win32.parse(value).root;
    return value !== root && normalized === value;
  }
  return false;
}

function hostPathContains(parent: string, child: string): boolean {
  const implementation = path.win32.isAbsolute(parent) ? path.win32 : path.posix;
  if (!implementation.isAbsolute(child)) return false;
  const relative = implementation.relative(parent, child);
  return (
    relative.length > 0 && relative !== '..' && !relative.startsWith(`..${implementation.sep}`)
  );
}

function isCanonicalRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r') ||
    path.posix.isAbsolute(value) ||
    !ARTIFACT_PATH_PATTERN.test(value)
  ) {
    return false;
  }
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '..' && !normalized.startsWith('../');
}

const HostPathSchema = z
  .string()
  .max(4096)
  .refine(isCanonicalHostPath, 'Expected a canonical absolute host path outside a filesystem root');

export const ClientCaptureArtifactPathSchema = z
  .string()
  .refine(isCanonicalRelativePath, 'Expected a canonical relative POSIX artifact path');

export const ClientCaptureResolutionSchema = z
  .object({
    width: z.number().int().min(64).max(CLIENT_CAPTURE_LIMITS.maxWidth),
    height: z.number().int().min(64).max(CLIENT_CAPTURE_LIMITS.maxHeight),
  })
  .strict()
  .refine(
    ({ width, height }) => width * height <= CLIENT_CAPTURE_LIMITS.maxPixels,
    'Capture resolution exceeds the decoded pixel budget',
  );

const BoundedScalarSchema = z.number().min(-30_000_000).max(30_000_000);
const WorldPositionSchema = z.tuple([
  BoundedScalarSchema,
  BoundedScalarSchema,
  BoundedScalarSchema,
]);
const PositiveScaleSchema = z.tuple([
  z.number().min(0.001).max(64),
  z.number().min(0.001).max(64),
  z.number().min(0.001).max(64),
]);

export const ClientCaptureBlockStateSchema = z
  .object({
    id: ResourceIdSchema,
    properties: z.record(z.string().regex(PROPERTY_NAME_PATTERN), z.string().min(1).max(128)),
  })
  .strict();

const DeclarativeComponentValueSchema = z
  .string()
  .refine(
    (value) =>
      !value.includes('\0') &&
      !value.includes('\n') &&
      !value.includes('\r') &&
      utf8Length(value) <= COMPONENT_VALUE_MAX_BYTES,
    'Declarative component value is unsafe or exceeds its byte budget',
  );

export const ClientCaptureDeclarativeItemStackSchema = z
  .object({
    itemId: ResourceIdSchema,
    count: z.number().int().min(1).max(99),
    components: z.record(ResourceIdSchema, DeclarativeComponentValueSchema),
  })
  .strict()
  .refine(
    ({ components }) =>
      canonicalJsonBytes(components).length <= CLIENT_CAPTURE_LIMITS.maxComponentsBytes,
    'Declarative item components exceed the capture protocol budget',
  );

const EulerRotationSchema = z.tuple([
  z.number().min(-360).max(360),
  z.number().min(-360).max(360),
  z.number().min(-360).max(360),
]);

export const ClientCaptureDisplayTransformSchema = z
  .object({
    translation: WorldPositionSchema,
    leftRotation: EulerRotationSchema,
    scale: PositiveScaleSchema,
    rightRotation: EulerRotationSchema,
  })
  .strict();

const DisplayNodeBase = {
  id: SafeIdSchema,
  position: WorldPositionSchema,
  yaw: z.number().min(-360).max(360),
  pitch: z.number().min(-90).max(90),
  transform: ClientCaptureDisplayTransformSchema,
  billboard: z.enum(['fixed', 'vertical', 'horizontal', 'center']),
  brightness: z
    .object({ block: z.number().int().min(0).max(15), sky: z.number().int().min(0).max(15) })
    .strict(),
  shadow: z
    .object({ radius: z.number().min(0).max(64), strength: z.number().min(0).max(1) })
    .strict(),
  interpolation: z
    .object({
      duration: z.number().int().min(0).max(1200),
      startDelta: z.number().int().min(-1200).max(1200),
    })
    .strict(),
} as const;

export const ClientCaptureItemDisplayNodeSchema = z
  .object({
    ...DisplayNodeBase,
    kind: z.literal('item_display'),
    itemStack: ClientCaptureDeclarativeItemStackSchema,
    itemDisplayContext: z.enum([
      'none',
      'thirdperson_lefthand',
      'thirdperson_righthand',
      'firstperson_lefthand',
      'firstperson_righthand',
      'head',
      'gui',
      'ground',
      'fixed',
    ]),
  })
  .strict();
export const ClientCaptureBlockDisplayNodeSchema = z
  .object({
    ...DisplayNodeBase,
    kind: z.literal('block_display'),
    blockState: ClientCaptureBlockStateSchema,
  })
  .strict();
export const ClientCaptureDisplayNodeSchema = z.discriminatedUnion('kind', [
  ClientCaptureItemDisplayNodeSchema,
  ClientCaptureBlockDisplayNodeSchema,
]);

export const ClientCaptureInteractionNodeSchema = z
  .object({
    position: WorldPositionSchema,
    width: z.number().positive().max(64),
    height: z.number().positive().max(64),
    response: z.literal(false),
  })
  .strict();

export const ClientCaptureDisplayRigSchema = z
  .object({
    nodes: z.array(ClientCaptureDisplayNodeSchema).min(1).max(32),
    interaction: ClientCaptureInteractionNodeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, node] of value.nodes.entries()) {
      if (ids.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `Duplicate display node id '${node.id}'`,
        });
      }
      ids.add(node.id);
    }
  });

const NativeEntityTypes = [
  'minecraft:armor_stand',
  'minecraft:cat',
  'minecraft:chicken',
  'minecraft:cow',
  'minecraft:frog',
  'minecraft:pig',
  'minecraft:sheep',
  'minecraft:wolf',
  'minecraft:zombie',
] as const;
const VariantEntityTypes = new Set<string>([
  'minecraft:cat',
  'minecraft:chicken',
  'minecraft:cow',
  'minecraft:frog',
  'minecraft:pig',
  'minecraft:wolf',
]);
const EntityEquipmentSchema = z
  .object({
    head: ClientCaptureDeclarativeItemStackSchema.optional(),
    chest: ClientCaptureDeclarativeItemStackSchema.optional(),
    legs: ClientCaptureDeclarativeItemStackSchema.optional(),
    feet: ClientCaptureDeclarativeItemStackSchema.optional(),
    mainhand: ClientCaptureDeclarativeItemStackSchema.optional(),
    offhand: ClientCaptureDeclarativeItemStackSchema.optional(),
  })
  .strict();
export const ClientCaptureNativeEntitySchema = z
  .object({
    entityType: z.enum(NativeEntityTypes),
    variant: ResourceIdSchema.optional(),
    baby: z.boolean(),
    equipment: EntityEquipmentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (VariantEntityTypes.has(value.entityType) && value.variant === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['variant'],
        message: `Entity type '${value.entityType}' requires an exact data-driven capture variant`,
      });
    }
    if (value.variant !== undefined && !VariantEntityTypes.has(value.entityType)) {
      context.addIssue({
        code: 'custom',
        path: ['variant'],
        message: `Entity type '${value.entityType}' does not support a data-driven capture variant`,
      });
    }
    if (value.entityType === 'minecraft:armor_stand' && value.baby) {
      context.addIssue({
        code: 'custom',
        path: ['baby'],
        message: 'Armor stands do not expose a native baby state',
      });
    }
  });

const ItemStateSchema = z.object({ itemStack: ClientCaptureDeclarativeItemStackSchema }).strict();
const BlockStateCaptureSchema = z.object({ blockState: ClientCaptureBlockStateSchema }).strict();
const BlockDisplayStateSchema = z
  .object({ blockDisplay: ClientCaptureBlockDisplayNodeSchema })
  .strict();
const EntityStateSchema = z.object({ entity: ClientCaptureNativeEntitySchema }).strict();
const DisplayRigStateSchema = z.object({ displayRig: ClientCaptureDisplayRigSchema }).strict();
const StateMap = <T extends z.ZodType>(state: T) => z.record(SafeIdSchema, state);

const BlockReviewDeclarationSchema = z
  .object({
    inventoryItemStack: ClientCaptureDeclarativeItemStackSchema.optional(),
    transparency: z.boolean(),
    biomeTintBiomes: z.array(ResourceIdSchema).max(4),
    animatedTextureTicks: z
      .array(z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxFrame))
      .max(8),
  })
  .strict();
const HeadwearReviewDeclarationSchema = z
  .object({
    wideFov: z.boolean(),
    armorStand: z.literal(true),
    statePoses: z.record(SafeIdSchema, z.enum(['idle', 'walk', 'crouch', 'swim', 'glide'])),
    chestArmorItemStack: ClientCaptureDeclarativeItemStackSchema.optional(),
  })
  .strict();
const EntityReviewDeclarationSchema = z
  .object({
    lowLight: z.boolean(),
    animationTicks: z.array(z.number().int().min(0).max(1200)).max(8),
    poseStates: z
      .object({ idle: SafeIdSchema, walk: SafeIdSchema, attack: SafeIdSchema })
      .strict()
      .optional(),
  })
  .strict();
const PlaceableReviewDeclarationSchema = z
  .object({
    orientations: z
      .array(z.enum(['north', 'east', 'south', 'west']))
      .min(1)
      .max(4),
    attachments: z
      .array(z.enum(['floor', 'wall', 'ceiling']))
      .min(1)
      .max(3),
    placementStates: z
      .array(
        z
          .object({
            orientation: z.enum(['north', 'east', 'south', 'west']),
            attachment: z.enum(['floor', 'wall', 'ceiling']),
            stateId: SafeIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

const RepresentationBase = {
  capability: z.enum(['native', 'replacement', 'simulated']),
} as const;

const ItemRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.enum(['held_item', 'gui_item']),
    strategy: z.literal('item_stack'),
    capability: z.literal('native'),
    states: StateMap(ItemStateSchema),
  })
  .strict();
const NativeBlockRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.literal('block'),
    strategy: z.literal('native_block_state'),
    capability: z.literal('replacement'),
    states: StateMap(BlockStateCaptureSchema),
    review: BlockReviewDeclarationSchema,
  })
  .strict();
const BlockDisplayRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.literal('block'),
    strategy: z.literal('block_display'),
    capability: z.literal('simulated'),
    states: StateMap(BlockDisplayStateSchema),
    review: BlockReviewDeclarationSchema,
  })
  .strict();
const HeadwearRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.literal('headwear'),
    strategy: z.literal('equippable_head'),
    capability: z.enum(['native', 'replacement']),
    states: StateMap(ItemStateSchema),
    headwear: z
      .object({
        renderMode: z.enum(['fallback_item', 'equipment_model']),
        cameraOverlay: ResourceIdSchema.optional(),
      })
      .strict(),
    review: HeadwearReviewDeclarationSchema,
  })
  .strict();
const NativeEntityRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.literal('entity'),
    strategy: z.literal('native_entity'),
    capability: z.literal('replacement'),
    states: StateMap(EntityStateSchema),
    review: EntityReviewDeclarationSchema,
  })
  .strict();
const DisplayRigRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.enum(['entity', 'placeable']),
    strategy: z.literal('display_rig'),
    capability: z.literal('simulated'),
    states: StateMap(DisplayRigStateSchema),
    review: z.union([EntityReviewDeclarationSchema, PlaceableReviewDeclarationSchema]),
  })
  .strict();
const NativePlaceableBlockRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.literal('placeable'),
    strategy: z.literal('native_placeable_block'),
    capability: z.enum(['native', 'replacement']),
    states: StateMap(BlockStateCaptureSchema),
    review: PlaceableReviewDeclarationSchema,
  })
  .strict();
const NativePlaceableEntityRepresentationSchema = z
  .object({
    ...RepresentationBase,
    targetKind: z.literal('placeable'),
    strategy: z.literal('native_placeable_entity'),
    capability: z.literal('native'),
    states: StateMap(EntityStateSchema),
    review: PlaceableReviewDeclarationSchema,
  })
  .strict();

export const ClientCaptureRepresentationSchema = z
  .discriminatedUnion('strategy', [
    ItemRepresentationSchema,
    NativeBlockRepresentationSchema,
    BlockDisplayRepresentationSchema,
    HeadwearRepresentationSchema,
    NativeEntityRepresentationSchema,
    DisplayRigRepresentationSchema,
    NativePlaceableBlockRepresentationSchema,
    NativePlaceableEntityRepresentationSchema,
  ])
  .superRefine((value, context) => {
    const ids = Object.keys(value.states);
    if (ids.length < 1 || ids.length > 32) {
      context.addIssue({
        code: 'custom',
        path: ['states'],
        message: 'A capture representation requires between 1 and 32 bounded states',
      });
    }
    if (value.strategy === 'item_stack' && ids.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['states'],
        message:
          'An item-stack capture requires exactly one canonical proposal-bound rendered state',
      });
    }
    if (ids.some((id, index) => index > 0 && (ids[index - 1] ?? '') >= id)) {
      context.addIssue({
        code: 'custom',
        path: ['states'],
        message: 'Capture representation state IDs must be sorted in ASCII order',
      });
    }
    if (value.targetKind === 'headwear') {
      const poseIds = Object.keys(value.review.statePoses);
      if (!isAsciiSortedUnique(poseIds)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'statePoses'],
          message: 'Headwear review state poses must be unique and ASCII sorted',
        });
      }
      if (
        poseIds.length !== ids.length ||
        poseIds.some((stateId) => !(stateId in value.states)) ||
        ids.some((stateId) => !(stateId in value.review.statePoses))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'statePoses'],
          message:
            'Headwear review poses must classify every declared item-stack state exactly once',
        });
      }
      for (const stateId of Object.keys(value.review.statePoses)) {
        if (!(stateId in value.states)) {
          context.addIssue({
            code: 'custom',
            path: ['review', 'statePoses', stateId],
            message: `Headwear review pose references undeclared state '${stateId}'`,
          });
        }
      }
      for (const [stateId, state] of Object.entries(value.states)) {
        const equippable = state.itemStack.components['minecraft:equippable'];
        const hasAssetId = equippable?.includes('asset_id:') === true;
        const hasCameraOverlay = equippable?.includes('camera_overlay:') === true;
        if (!equippable?.includes('slot:"head"')) {
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'itemStack', 'components', 'minecraft:equippable'],
            message: 'Headwear capture requires an exact minecraft:equippable head-slot component',
          });
        }
        if (value.headwear.renderMode === 'equipment_model' && !hasAssetId) {
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'itemStack', 'components', 'minecraft:equippable'],
            message: 'Equipment-model headwear requires an explicit equippable asset_id',
          });
        }
        if (value.headwear.renderMode === 'fallback_item' && hasAssetId) {
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'itemStack', 'components', 'minecraft:equippable'],
            message: 'Fallback-item headwear cannot declare an equipment-model asset_id',
          });
        }
        const expectedOverlay = value.headwear.cameraOverlay;
        if (
          (expectedOverlay === undefined && hasCameraOverlay) ||
          (expectedOverlay !== undefined &&
            !equippable?.includes(`camera_overlay:"${expectedOverlay}"`))
        ) {
          context.addIssue({
            code: 'custom',
            path: ['states', stateId, 'itemStack', 'components', 'minecraft:equippable'],
            message:
              'Headwear cameraOverlay must exactly match the minecraft:equippable camera_overlay field',
          });
        }
      }
    }
    if (value.targetKind === 'block') {
      if (!isAsciiSortedUnique(value.review.biomeTintBiomes)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'biomeTintBiomes'],
          message: 'Block biome-tint declarations must be unique and ASCII sorted',
        });
      }
      if (!isNumericSortedUnique(value.review.animatedTextureTicks)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'animatedTextureTicks'],
          message: 'Animated texture ticks must be unique and sorted in chronological order',
        });
      }
      if (value.review.animatedTextureTicks.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'animatedTextureTicks'],
          message:
            'Protocol v3 cannot authoritatively reset Minecraft global atlas animation phase; animated texture tick samples are unsupported',
        });
      }
    }
    if (value.targetKind === 'placeable') {
      if (!('orientations' in value.review) || !('attachments' in value.review)) {
        context.addIssue({
          code: 'custom',
          path: ['review'],
          message: 'Placeable representations require placeable review declarations',
        });
        return;
      }
      const placeableReview = value.review;
      const orientationOrder = ['north', 'east', 'south', 'west'] as const;
      const attachmentOrder = ['floor', 'wall', 'ceiling'] as const;
      const expectedOrientationOrder = orientationOrder.filter((entry) =>
        placeableReview.orientations.includes(entry),
      );
      const expectedAttachmentOrder = attachmentOrder.filter((entry) =>
        placeableReview.attachments.includes(entry),
      );
      if (!sameCanonicalValue(placeableReview.orientations, expectedOrientationOrder)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'orientations'],
          message: 'Placeable orientations must use canonical north/east/south/west order',
        });
      }
      if (!sameCanonicalValue(placeableReview.orientations, orientationOrder)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'orientations'],
          message: 'Placeable authority requires north/east/south/west floor orientations',
        });
      }
      if (!placeableReview.attachments.includes('floor')) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'attachments'],
          message: 'Placeable authority requires a floor attachment profile',
        });
      }
      if (!sameCanonicalValue(placeableReview.attachments, expectedAttachmentOrder)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'attachments'],
          message: 'Placeable attachments must use canonical floor/wall/ceiling order',
        });
      }
      if (new Set(placeableReview.orientations).size !== placeableReview.orientations.length) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'orientations'],
          message: 'Placeable review orientations must be unique',
        });
      }
      if (new Set(placeableReview.attachments).size !== placeableReview.attachments.length) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'attachments'],
          message: 'Placeable review attachments must be unique',
        });
      }
      const expectedPlacements = new Set(
        placeableReview.orientations.flatMap((orientation) =>
          placeableReview.attachments.map((attachment) => `${orientation}/${attachment}`),
        ),
      );
      const seenPlacements = new Set<string>();
      const canonicalPlacementOrder = expectedOrientationOrder.flatMap((orientation) =>
        expectedAttachmentOrder.map((attachment) => `${orientation}/${attachment}`),
      );
      for (const [index, placement] of placeableReview.placementStates.entries()) {
        const key = `${placement.orientation}/${placement.attachment}`;
        if (seenPlacements.has(key)) {
          context.addIssue({
            code: 'custom',
            path: ['review', 'placementStates', index],
            message: `Duplicate placeable review placement '${key}'`,
          });
        }
        seenPlacements.add(key);
        if (!(placement.stateId in value.states)) {
          context.addIssue({
            code: 'custom',
            path: ['review', 'placementStates', index, 'stateId'],
            message: `Placeable placement references undeclared state '${placement.stateId}'`,
          });
        }
      }
      const actualPlacementOrder = placeableReview.placementStates.map(
        (placement) => `${placement.orientation}/${placement.attachment}`,
      );
      if (!sameCanonicalValue(actualPlacementOrder, canonicalPlacementOrder)) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'placementStates'],
          message:
            'Placeable placement-state bindings must use canonical orientation/attachment order',
        });
      }
      if (
        seenPlacements.size !== expectedPlacements.size ||
        [...expectedPlacements].some((placement) => !seenPlacements.has(placement))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'placementStates'],
          message:
            'Placeable review must bind every declared orientation/attachment pair to an exact state',
        });
      }
      if (
        (value.strategy === 'native_placeable_block' ||
          value.strategy === 'native_placeable_entity') &&
        !sameCanonicalValue(placeableReview.attachments, ['floor'])
      ) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'attachments'],
          message:
            'Native placeable capture supports floor attachment only; wall and ceiling require an exact display-rig attachment compiler',
        });
      }
      if (value.strategy === 'native_placeable_block') {
        for (const [index, placement] of placeableReview.placementStates.entries()) {
          const state = value.states[placement.stateId];
          if (state?.blockState.properties.facing !== placement.orientation) {
            context.addIssue({
              code: 'custom',
              path: ['review', 'placementStates', index, 'stateId'],
              message:
                'Native placeable block orientation requires an exact block-state facing property matching the declared orientation',
            });
          }
        }
      }
    }
    if (
      value.targetKind === 'entity' &&
      (!('lowLight' in value.review) || !('animationTicks' in value.review))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['review'],
        message: 'Entity representations require entity review declarations',
      });
    }
    if (
      value.strategy === 'native_entity' &&
      (value.review.animationTicks.length === 0 || (value.review.animationTicks[0] ?? 0) < 2)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['review', 'animationTicks'],
        message:
          'Native entity walk and attack evidence requires a first deterministic animation tick of at least two',
      });
    }
    if (
      value.strategy === 'native_entity' &&
      value.states.default?.entity.entityType !== 'minecraft:zombie'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['states', 'default'],
        message:
          'Native entity authority requires a canonical default zombie state whose walk and attack poses are renderer-observable; other supported entities are bounded variant-matrix states',
      });
    }
    if (value.strategy === 'display_rig' && value.targetKind === 'entity') {
      if (!('poseStates' in value.review) || value.review.poseStates === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'poseStates'],
          message:
            'Simulated entity rigs require exact idle/walk/attack state bindings; Packwright does not synthesize poses',
        });
      } else {
        for (const [pose, stateId] of Object.entries(value.review.poseStates)) {
          if (!(stateId in value.states)) {
            context.addIssue({
              code: 'custom',
              path: ['review', 'poseStates', pose],
              message: `Entity rig pose '${pose}' references undeclared state '${stateId}'`,
            });
          }
        }
      }
      if ('animationTicks' in value.review && value.review.animationTicks.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['review', 'animationTicks'],
          message:
            'Protocol v3 simulated entity rigs use exact pose states and cannot claim tick-driven animation samples',
        });
      }
    }
    if (value.strategy === 'block_display' || value.strategy === 'display_rig') {
      const nodes =
        value.strategy === 'block_display'
          ? Object.values(value.states).map((state) => state.blockDisplay)
          : Object.values(value.states).flatMap((state) => state.displayRig.nodes);
      if (
        nodes.some(
          (node) => node.interpolation.duration !== 0 || node.interpolation.startDelta !== 0,
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['states'],
          message:
            'Protocol v3 accepts only static display nodes; interpolation duration and startDelta must both be zero',
        });
      }
    }
    if (
      value.targetKind === 'entity' &&
      'animationTicks' in value.review &&
      !isNumericSortedUnique(value.review.animationTicks)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['review', 'animationTicks'],
        message: 'Entity animation ticks must be unique and sorted in chronological order',
      });
    }
  });

export type ClientCaptureRepresentation = z.infer<typeof ClientCaptureRepresentationSchema>;
export type ClientCaptureTargetKind = ClientCaptureRepresentation['targetKind'];

export function computeClientCaptureRepresentationSha256(value: unknown): string {
  return sha256Buffer(canonicalJsonBytes(ClientCaptureRepresentationSchema.parse(value)));
}

export const ClientCaptureStudioScaleReferenceSchema = z
  .object({
    kind: z.literal('ordinary_block_floor_ruler'),
    origin: z
      .object({
        x: z.literal(-2),
        y: z.literal(79),
        z: z.literal(7),
      })
      .strict(),
    lengthBlocks: z.literal(2),
    firstBlock: z
      .object({
        id: z.literal('minecraft:black_concrete'),
        properties: z.object({}).strict(),
      })
      .strict(),
    secondBlock: z
      .object({
        id: z.literal('minecraft:white_concrete'),
        properties: z.object({}).strict(),
      })
      .strict(),
  })
  .strict();

export type ClientCaptureStudioScaleReference = z.infer<
  typeof ClientCaptureStudioScaleReferenceSchema
>;

export function computeClientCaptureStudioScaleReferenceSha256(value: unknown): string {
  return sha256Buffer(canonicalJsonBytes(ClientCaptureStudioScaleReferenceSchema.parse(value)));
}

export const ClientCaptureStudioSchema = z
  .object({
    preset: z.literal('void_matte'),
    rendererBackend: z.literal('opengl'),
    renderDistance: z.number().int().min(2).max(16),
    simulationDistance: z.number().int().min(2).max(12),
    graphicsMode: z.literal('custom'),
    clouds: z.literal('off'),
    particles: z.literal('minimal'),
    entityShadows: z.literal(true),
    viewBobbing: z.literal(false),
    debugUi: z.literal(false),
    floorBlock: ClientCaptureBlockStateSchema,
    backdropBlock: ClientCaptureBlockStateSchema,
    scaleReference: ClientCaptureStudioScaleReferenceSchema,
  })
  .strict();

export type ClientCaptureStudio = z.infer<typeof ClientCaptureStudioSchema>;

export function computeClientCaptureStudioSha256(value: unknown): string {
  return sha256Buffer(canonicalJsonBytes(ClientCaptureStudioSchema.parse(value)));
}

export const CLIENT_CAPTURE_MEASUREMENT_METRICS = [
  'frame_retention',
  'visible_faces',
  'screen_coverage',
  'pairwise_pixel_delta',
  'adjacency_seam',
  'unexpected_culling',
  'lighting_separation',
  'alpha_order_artifacts',
  'face_eye_clearance',
  'head_penetration',
  'variant_fit_delta',
  'first_person_obstruction',
  'overlay_coverage',
  'armor_stand_alignment',
  'silhouette_grounding',
  'player_scale',
  'self_intersection',
  'texture_variant_resolution',
  'hitbox_containment',
  'hitbox_empty_space',
  'animation_stability',
  'orientation_alignment',
  'attachment_gap',
  'z_fighting',
  'collision_interaction_footprint_delta',
  'billboard_correctness',
  'visibility_occlusion',
  'interpolation_determinism',
] as const;

export const ClientCaptureMeasurementMetricSchema = z.enum(CLIENT_CAPTURE_MEASUREMENT_METRICS);
const CLIENT_CAPTURE_READINESS_MEASUREMENT_METRICS = new Set<
  (typeof CLIENT_CAPTURE_MEASUREMENT_METRICS)[number]
>([
  'animation_stability',
  'lighting_separation',
  'pairwise_pixel_delta',
  'texture_variant_resolution',
]);
const ClientCaptureMeasurementThresholdSchema = z
  .object({
    comparison: z.enum(['above', 'below']),
    warning: z.number(),
    failure: z.number(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.comparison === 'above' && value.failure < value.warning) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Above-threshold failure must be greater than or equal to warning',
      });
    }
    if (value.comparison === 'below' && value.failure > value.warning) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Below-threshold failure must be less than or equal to warning',
      });
    }
  });
export const ClientCaptureMeasurementIntentSchema = z
  .object({
    id: SafeIdSchema,
    metric: ClientCaptureMeasurementMetricSchema,
    authority: z.literal('client_pixels'),
    unit: z.enum(['percent', 'pixels', 'ratio', 'count', 'dot']),
    requiredForReadiness: z.boolean(),
    threshold: ClientCaptureMeasurementThresholdSchema.optional(),
    sourceSceneIds: z
      .array(SafeIdSchema)
      .min(1)
      .max(16)
      .refine(isAsciiSortedUnique, 'Measurement source scene IDs must be unique and ASCII sorted')
      .optional(),
  })
  .strict();

export const ClientCaptureCameraPoseSchema = z
  .object({
    x: z.number().min(-64).max(64),
    y: z.number().min(64).max(96),
    z: z.number().min(-64).max(64),
    yaw: z.number().min(-360).max(360),
    pitch: z.number().min(-90).max(90),
  })
  .strict();

const ItemFixtureSchema = z
  .object({ kind: z.literal('item_stack'), stateId: SafeIdSchema })
  .strict();
const BlockFixtureFields = {
  stateId: SafeIdSchema,
  layout: z.enum([
    'single',
    'adjacency',
    'culling',
    'inventory',
    'transparency_light',
    'transparency_dark',
    'transparency_overlap',
  ]),
  backdrop: z.enum(['studio', 'light', 'dark']),
  overlapCopies: z.union([z.literal(1), z.literal(2)]),
  orientation: z.enum(['north', 'south', 'east', 'west', 'up', 'down', 'three_quarter']),
  animationTick: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxFrame),
  blockPosition: z
    .object({
      x: z.number().int().min(-32).max(32),
      y: z.number().int().min(64).max(96),
      z: z.number().int().min(-32).max(32),
    })
    .strict(),
} as const;
const NativeBlockFixtureSchema = z
  .object({ kind: z.literal('native_block_state'), ...BlockFixtureFields })
  .strict();
const BlockDisplayFixtureSchema = z
  .object({ kind: z.literal('block_display'), ...BlockFixtureFields })
  .strict();
const HeadwearFixtureSchema = z
  .object({
    kind: z.literal('equippable_head'),
    stateId: SafeIdSchema,
    subject: z.enum(['player', 'armor_stand', 'bare_control']),
    framing: z.enum(['head', 'full_body', 'first_person']),
    pose: z.enum(['idle', 'walk', 'crouch', 'swim', 'glide']),
    subjectYaw: z.literal(0),
    viewAngle: z.enum(['front', 'side', 'rear']),
    cameraDistance: z.number().min(0).max(12),
    chestArmor: z.boolean(),
  })
  .strict();
const EntityFixtureFields = {
  stateId: SafeIdSchema,
  pose: z.enum(['idle', 'walk', 'attack']),
  angle: z
    .number()
    .int()
    .min(0)
    .max(315)
    .refine((value) => value % 45 === 0),
  showPlayerScale: z.boolean(),
  animationTick: z.number().int().min(0).max(1200),
} as const;
const NativeEntityFixtureSchema = z
  .object({ kind: z.literal('native_entity'), ...EntityFixtureFields })
  .strict();
const EntityDisplayRigFixtureSchema = z
  .object({
    kind: z.literal('display_rig'),
    targetKind: z.literal('entity'),
    ...EntityFixtureFields,
  })
  .strict();
const PlaceableFixtureFields = {
  stateId: SafeIdSchema,
  orientation: z.enum(['north', 'east', 'south', 'west']),
  attachment: z.enum(['floor', 'wall', 'ceiling']),
  distance: z.enum(['close', 'player_eye', 'near', 'mid']),
  occluded: z.boolean(),
  animationTick: z.number().int().min(0).max(1200),
  context: z.enum(['plain', 'corner', 'doorway', 'occlusion']),
  subjectPosition: z
    .object({
      x: z.number().int().min(-32).max(32),
      y: z.number().int().min(64).max(96),
      z: z.number().int().min(-32).max(32),
    })
    .strict(),
} as const;
const NativePlaceableBlockFixtureSchema = z
  .object({ kind: z.literal('native_placeable_block'), ...PlaceableFixtureFields })
  .strict();
const NativePlaceableEntityFixtureSchema = z
  .object({ kind: z.literal('native_placeable_entity'), ...PlaceableFixtureFields })
  .strict();
const PlaceableDisplayRigFixtureSchema = z
  .object({
    kind: z.literal('display_rig'),
    targetKind: z.literal('placeable'),
    ...PlaceableFixtureFields,
  })
  .strict();
const MeasurementControlFixtureSchema = z
  .object({
    kind: z.literal('measurement_control'),
    targetKind: z.enum(['block', 'headwear', 'entity', 'placeable']),
    stateId: SafeIdSchema,
    control: z.literal('empty_subject'),
  })
  .strict();

export const ClientCaptureFixtureSchema = z.union([
  ItemFixtureSchema,
  NativeBlockFixtureSchema,
  BlockDisplayFixtureSchema,
  HeadwearFixtureSchema,
  NativeEntityFixtureSchema,
  EntityDisplayRigFixtureSchema,
  NativePlaceableBlockFixtureSchema,
  NativePlaceableEntityFixtureSchema,
  PlaceableDisplayRigFixtureSchema,
  MeasurementControlFixtureSchema,
]);

export const ClientCaptureEnvironmentSchema = z
  .object({
    biome: ResourceIdSchema,
    time: z.union([z.literal(6000), z.literal(18000)]),
    weather: z.literal('clear'),
    lightProfile: z.enum(['day', 'low']),
    skyLight: z.number().int().min(0).max(15),
    blockLight: z.number().int().min(0).max(15),
    lightSource: z
      .object({
        level: z.number().int().min(0).max(15),
        offset: z
          .object({
            x: z.number().int().min(-16).max(16),
            y: z.number().int().min(-16).max(16),
            z: z.number().int().min(-16).max(16),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedSourceLevel = value.lightProfile === 'low' ? 11 : 0;
    const expectedBlockLight = value.lightProfile === 'low' ? 4 : 0;
    if (
      value.lightSource.level !== expectedSourceLevel ||
      !sameCanonicalValue(value.lightSource.offset, { x: 0, y: 5, z: -2 }) ||
      value.blockLight !== expectedBlockLight
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lightSource'],
        message:
          'Capture light profile must bind the canonical source and observed subject block-light level',
      });
    }
  });

export const ClientCaptureSceneSchema = z
  .object({
    id: SafeIdSchema,
    baseSceneId: SafeIdSchema,
    targetKind: z.enum(['held_item', 'gui_item', 'block', 'headwear', 'entity', 'placeable']),
    representationSha256: Sha256Schema,
    viewKind: z.enum([
      'minecraft_vanilla',
      'first_person_vanilla',
      'first_person_scale_reference',
      'debug_hitbox_reference',
      'comparison_reference',
      'world_scale_reference',
      'measurement_control',
    ]),
    requiredForAuthority: z.boolean(),
    camera: z.enum(['first_person', 'third_person_back', 'third_person_front', 'neutral']),
    context: z.enum(['world', 'inventory', 'hotbar', 'tooltip', 'item_inspection']),
    hand: z.enum(['right', 'left']),
    playerModel: z.enum(['steve', 'alex']),
    fov: z.number().int().min(CLIENT_CAPTURE_LIMITS.minFov).max(CLIENT_CAPTURE_LIMITS.maxFov),
    resolution: ClientCaptureResolutionSchema,
    guiScale: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxGuiScale),
    animationState: z.enum(['idle', 'swing', 'use', 'fire', 'aim', 'release', 'impact']),
    frame: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxFrame),
    cameraPoseSemantics: z.literal('player_feet_anchor'),
    cameraPose: ClientCaptureCameraPoseSchema,
    expectedRenderCameraPose: ClientCaptureCameraPoseSchema,
    environment: ClientCaptureEnvironmentSchema,
    settlingTicks: z.number().int().min(0).max(40),
    fixture: ClientCaptureFixtureSchema,
    measurementIntents: z.array(ClientCaptureMeasurementIntentSchema).max(16),
    comparisonSceneIds: z.array(SafeIdSchema).max(16),
    presentation: z
      .object({
        stackCount: z.number().int().min(1).max(99).optional(),
        selectedHotbar: z.boolean().optional(),
        showGlint: z.boolean().optional(),
        durabilityFraction: z.number().min(0).max(1).optional(),
        referenceArm: z.boolean().optional(),
        referenceArmPurpose: z.literal('scale_only').optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((scene, context) => {
    const isFirstPersonWorld = scene.camera === 'first_person' && scene.context === 'world';
    const isVanillaFirstPerson = scene.viewKind === 'first_person_vanilla';
    const isScaleReference = scene.viewKind === 'first_person_scale_reference';
    const isDebugReference = scene.viewKind === 'debug_hitbox_reference';
    const isComparisonReference = scene.viewKind === 'comparison_reference';
    const isWorldScaleReference = scene.viewKind === 'world_scale_reference';
    const isMeasurementControl = scene.viewKind === 'measurement_control';
    const isSupplemental =
      isScaleReference ||
      isDebugReference ||
      isComparisonReference ||
      isWorldScaleReference ||
      isMeasurementControl;
    if (isFirstPersonWorld && !isVanillaFirstPerson && !isScaleReference && !isMeasurementControl) {
      context.addIssue({
        code: 'custom',
        path: ['viewKind'],
        message:
          'First-person world captures must be explicitly classified as vanilla gameplay or a scale reference',
      });
    }
    if (
      !isFirstPersonWorld &&
      scene.viewKind !== 'minecraft_vanilla' &&
      scene.viewKind !== 'debug_hitbox_reference' &&
      scene.viewKind !== 'comparison_reference' &&
      scene.viewKind !== 'world_scale_reference' &&
      scene.viewKind !== 'measurement_control'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['viewKind'],
        message: 'First-person view kinds are only valid for first-person world captures',
      });
    }
    const expectedId =
      scene.viewKind === 'first_person_vanilla'
        ? `first_person_vanilla--${scene.baseSceneId}`
        : scene.viewKind === 'first_person_scale_reference'
          ? `first_person_scale_reference--${scene.baseSceneId}`
          : scene.viewKind === 'debug_hitbox_reference'
            ? `debug_hitbox_reference--${scene.baseSceneId}`
            : scene.viewKind === 'comparison_reference'
              ? `comparison_reference--${scene.baseSceneId}`
              : scene.viewKind === 'world_scale_reference'
                ? `world_scale_reference--${scene.baseSceneId}`
                : scene.viewKind === 'measurement_control'
                  ? `measurement_control--${scene.baseSceneId}`
                  : scene.baseSceneId;
    if (scene.id !== expectedId) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Capture scene id does not match its hash-bound view kind and base scene id',
      });
    }
    if (scene.requiredForAuthority === isSupplemental) {
      context.addIssue({
        code: 'custom',
        path: ['requiredForAuthority'],
        message:
          'Exact gameplay views are required for authority and augmented scale/debug views are supplemental',
      });
    }
    if (
      isScaleReference &&
      (scene.presentation?.referenceArm !== true ||
        scene.presentation.referenceArmPurpose !== 'scale_only')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['presentation'],
        message:
          'Scale-reference captures must explicitly declare the Minecraft-rendered scale-only reference-arm augmentation',
      });
    }
    if (
      !isScaleReference &&
      (scene.presentation?.referenceArm !== undefined ||
        scene.presentation?.referenceArmPurpose !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['presentation'],
        message: 'Reference-arm fields are only valid for first-person scale-reference captures',
      });
    }
    if (isDebugReference && !['entity', 'placeable'].includes(scene.targetKind)) {
      context.addIssue({
        code: 'custom',
        path: ['targetKind'],
        message: 'Debug hitbox references are only valid for entity and placeable captures',
      });
    }
    if (isComparisonReference && scene.targetKind !== 'headwear') {
      context.addIssue({
        code: 'custom',
        path: ['targetKind'],
        message: 'Comparison-reference captures are only valid for headwear controls',
      });
    }
    if (
      scene.fixture.kind === 'equippable_head' &&
      scene.fixture.subject === 'bare_control' &&
      !isComparisonReference
    ) {
      context.addIssue({
        code: 'custom',
        path: ['viewKind'],
        message:
          'A bare-head control is a supplemental comparison_reference and cannot satisfy authority',
      });
    }
    if (isWorldScaleReference && scene.targetKind !== 'entity') {
      context.addIssue({
        code: 'custom',
        path: ['targetKind'],
        message: 'World-scale references are only valid for entity captures',
      });
    }
    const injectsEntityScaleMannequin =
      (scene.fixture.kind === 'native_entity' ||
        (scene.fixture.kind === 'display_rig' && scene.fixture.targetKind === 'entity')) &&
      scene.fixture.showPlayerScale;
    if (isWorldScaleReference !== injectsEntityScaleMannequin) {
      context.addIssue({
        code: 'custom',
        path: ['viewKind'],
        message:
          'An injected entity scale mannequin is valid only in a supplemental world_scale_reference scene',
      });
    }
    if (
      isMeasurementControl &&
      (scene.fixture.kind !== 'measurement_control' ||
        scene.fixture.targetKind !== scene.targetKind ||
        scene.presentation !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fixture'],
        message:
          'Measurement-control scenes must use the exact empty-subject fixture and cannot inject presentation content',
      });
    }
    if (!isMeasurementControl && scene.fixture.kind === 'measurement_control') {
      context.addIssue({
        code: 'custom',
        path: ['fixture'],
        message: 'Empty-subject fixtures are supplemental measurement controls only',
      });
    }
    if (
      (scene.fixture.kind === 'native_block_state' || scene.fixture.kind === 'block_display') &&
      (() => {
        const expected =
          scene.fixture.layout === 'transparency_light'
            ? { backdrop: 'light', overlapCopies: 1 }
            : scene.fixture.layout === 'transparency_dark'
              ? { backdrop: 'dark', overlapCopies: 1 }
              : scene.fixture.layout === 'transparency_overlap'
                ? { backdrop: 'light', overlapCopies: 2 }
                : { backdrop: 'studio', overlapCopies: 1 };
        return (
          scene.fixture.backdrop !== expected.backdrop ||
          scene.fixture.overlapCopies !== expected.overlapCopies
        );
      })()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fixture', 'backdrop'],
        message: 'Block layout must use its exact hash-bound backdrop and overlap-copy count',
      });
    }
    if (
      (scene.fixture.kind === 'native_placeable_block' ||
        scene.fixture.kind === 'native_placeable_entity' ||
        (scene.fixture.kind === 'display_rig' && scene.fixture.targetKind === 'placeable')) &&
      (() => {
        const expectedY =
          scene.fixture.attachment === 'floor' ? 80 : scene.fixture.attachment === 'wall' ? 82 : 83;
        return !sameCanonicalValue(scene.fixture.subjectPosition, {
          x: 0,
          y: expectedY,
          z: 5,
        });
      })()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fixture', 'subjectPosition'],
        message: 'Placeable attachment must use its canonical hash-bound studio origin',
      });
    }
    if (
      scene.fixture.kind === 'equippable_head' &&
      scene.fixture.chestArmor &&
      (scene.fixture.subject !== 'player' || scene.fixture.framing !== 'full_body')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fixture', 'chestArmor'],
        message: 'Chest-armor compatibility is only valid on full-body player headwear scenes',
      });
    }
    if (isFirstPersonWorld) {
      const anchor = scene.cameraPose;
      const expected = scene.expectedRenderCameraPose;
      if (
        Math.abs(expected.x - anchor.x) > 0.000_001 ||
        Math.abs(expected.y - (anchor.y + 1.62)) > 0.000_001 ||
        Math.abs(expected.z - anchor.z) > 0.000_001 ||
        Math.abs(expected.yaw - anchor.yaw) > 0.000_001 ||
        Math.abs(expected.pitch - anchor.pitch) > 0.000_001
      ) {
        context.addIssue({
          code: 'custom',
          path: ['expectedRenderCameraPose'],
          message:
            'First-person world captures must use the exact vanilla eye camera derived from the player-feet anchor',
        });
      }
    }
    if (
      (scene.fixture.kind === 'display_rig' || scene.fixture.kind === 'block_display') &&
      scene.settlingTicks < 2
    ) {
      context.addIssue({
        code: 'custom',
        path: ['settlingTicks'],
        message: 'Display entities require at least two deterministic client settling ticks',
      });
    }
    if (
      (scene.fixture.kind === 'display_rig' ||
        scene.fixture.kind === 'block_display' ||
        scene.fixture.kind === 'native_block_state') &&
      scene.fixture.animationTick !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['fixture', 'animationTick'],
        message:
          'This protocol cannot attest a nonzero display or global texture-atlas animation phase',
      });
    }
    if (
      scene.fixture.kind !== 'display_rig' &&
      scene.fixture.kind !== 'block_display' &&
      scene.settlingTicks !== 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['settlingTicks'],
        message: 'Native fixtures must not claim a display-entity settling interval',
      });
    }
    if (scene.comparisonSceneIds.includes(scene.id)) {
      context.addIssue({
        code: 'custom',
        path: ['comparisonSceneIds'],
        message: 'A capture scene cannot compare itself to itself',
      });
    }
    if (!isAsciiSortedUnique(scene.comparisonSceneIds)) {
      context.addIssue({
        code: 'custom',
        path: ['comparisonSceneIds'],
        message: 'Capture comparison scene IDs must be unique and ASCII sorted',
      });
    }
    if (!isAsciiSortedUnique(scene.measurementIntents.map((intent) => intent.id))) {
      context.addIssue({
        code: 'custom',
        path: ['measurementIntents'],
        message: 'Capture measurement intents must be unique and ASCII sorted by id',
      });
    }
  });

const ItemCommandSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !value.includes('\n') &&
      !value.includes('\r') &&
      utf8Length(value) <= CLIENT_CAPTURE_LIMITS.maxItemCommandBytes,
    'Item command is unsafe or exceeds the capture protocol budget',
  );

const ComponentValueSchema = z
  .string()
  .refine(
    (value) =>
      !value.includes('\0') && utf8Length(value) <= CLIENT_CAPTURE_LIMITS.maxComponentValueBytes,
    'Item component value is unsafe or exceeds the capture protocol budget',
  );

export const ClientCaptureItemStackSchema = z
  .object({
    itemId: ResourceIdSchema,
    count: z.number().int().min(1).max(99),
    command: ItemCommandSchema,
    components: z.record(ResourceIdSchema, ComponentValueSchema),
  })
  .strict()
  .refine(
    ({ components }) =>
      canonicalJsonBytes(components).length <= CLIENT_CAPTURE_LIMITS.maxComponentsBytes,
    'Item components exceed the capture protocol budget',
  )
  .superRefine(({ itemId, count, command }, context) => {
    const prefix = 'give @s ';
    const suffix = ` ${String(count)}`;
    if (!command.startsWith(prefix) || !command.endsWith(suffix)) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: "Item command must use the exact 'give @s <item> <count>' capture form",
      });
      return;
    }
    const itemSyntax = command.slice(prefix.length, -suffix.length);
    if (itemSyntax !== itemId && !itemSyntax.startsWith(`${itemId}[`)) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'Item command does not begin with the provenance item identifier',
      });
    }
  });

export const ClientCaptureProvenanceSchema = z
  .object({
    projectId: SafeIdSchema,
    runId: ContentIdSchema,
    revisionId: ContentIdSchema,
    specSha256: Sha256Schema,
    compiledArtifactId: ContentIdSchema,
    proposalArtifactId: ContentIdSchema,
    projectManifestSha256: Sha256Schema,
    datapackContentSha256: Sha256Schema,
    resourcepackContentSha256: Sha256Schema,
    packActivation: z
      .object({
        datapack: z.literal(CLIENT_CAPTURE_PACK_ACTIVATION.datapack),
        resourcepack: z.literal(CLIENT_CAPTURE_PACK_ACTIVATION.resourcepack),
      })
      .strict(),
    runtimeManifestSha256: Sha256Schema,
    representation: ClientCaptureRepresentationSchema,
    representationSha256: Sha256Schema,
    client: z
      .object({
        jarSha1: Sha1Schema,
        jarSha256: Sha256Schema,
      })
      .strict(),
    captureMod: z
      .object({
        id: z.string().regex(MOD_ID_PATTERN, 'Expected a canonical Fabric mod id'),
        version: z.string().regex(VERSION_PATTERN, 'Expected a bounded capture mod version'),
        sha256: Sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.representationSha256 !== computeClientCaptureRepresentationSha256(value.representation)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['representationSha256'],
        message: 'Capture representation hash does not match its canonical representation',
      });
    }
  });

export const ClientCaptureExecutionSchema = z
  .object({
    executionId: z.string().regex(EXECUTION_ID_PATTERN, 'Expected a canonical execution id'),
    gameDirectory: HostPathSchema,
    outputDirectory: HostPathSchema,
  })
  .strict()
  .refine(
    ({ gameDirectory, outputDirectory }) => hostPathContains(gameDirectory, outputDirectory),
    'Capture output directory must be a strict descendant of the disposable game directory',
  );

function addUniqueSortedSceneChecks(
  scenes: readonly z.infer<typeof ClientCaptureSceneSchema>[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  const vanillaFirstPerson = new Map<string, (typeof scenes)[number]>();
  const vanillaByBaseId = new Map<string, (typeof scenes)[number]>();
  const scaleReferences: (typeof scenes)[number][] = [];
  const debugReferences: (typeof scenes)[number][] = [];
  const measurementControls: (typeof scenes)[number][] = [];
  for (const [index, scene] of scenes.entries()) {
    if (seen.has(scene.id)) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'id'],
        message: `Duplicate capture scene id '${scene.id}'`,
      });
    }
    seen.add(scene.id);
    if (scene.viewKind === 'first_person_vanilla') {
      vanillaFirstPerson.set(scene.baseSceneId, scene);
      vanillaByBaseId.set(scene.baseSceneId, scene);
    } else if (scene.viewKind === 'first_person_scale_reference') {
      scaleReferences.push(scene);
    } else if (scene.viewKind === 'minecraft_vanilla') {
      vanillaByBaseId.set(scene.baseSceneId, scene);
    } else if (scene.viewKind === 'debug_hitbox_reference') {
      debugReferences.push(scene);
    } else if (scene.viewKind === 'measurement_control') {
      measurementControls.push(scene);
    }
    if (index > 0 && (scenes[index - 1]?.id ?? '') >= scene.id) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'id'],
        message: 'Capture scenes must be sorted by id',
      });
    }
  }
  for (const scene of scaleReferences) {
    const vanilla = vanillaFirstPerson.get(scene.baseSceneId);
    if (vanilla === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Scale-reference scene '${scene.id}' has no matching vanilla first-person scene`,
      });
      continue;
    }
    const comparable = (value: (typeof scenes)[number]): unknown => {
      const presentation = { ...(value.presentation ?? {}) };
      delete presentation.referenceArm;
      delete presentation.referenceArmPurpose;
      return {
        targetKind: value.targetKind,
        representationSha256: value.representationSha256,
        camera: value.camera,
        context: value.context,
        hand: value.hand,
        playerModel: value.playerModel,
        fov: value.fov,
        resolution: value.resolution,
        guiScale: value.guiScale,
        animationState: value.animationState,
        frame: value.frame,
        cameraPoseSemantics: value.cameraPoseSemantics,
        cameraPose: value.cameraPose,
        expectedRenderCameraPose: value.expectedRenderCameraPose,
        environment: value.environment,
        settlingTicks: value.settlingTicks,
        fixture: value.fixture,
        ...(Object.keys(presentation).length === 0 ? {} : { presentation }),
      };
    };
    if (!canonicalJsonBytes(comparable(scene)).equals(canonicalJsonBytes(comparable(vanilla)))) {
      context.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Scale-reference scene '${scene.id}' does not match its vanilla first-person pair`,
      });
    }
  }
  for (const scene of debugReferences) {
    const vanilla = vanillaByBaseId.get(scene.baseSceneId);
    if (vanilla === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Debug hitbox scene '${scene.id}' has no matching authoritative vanilla scene`,
      });
      continue;
    }
    const comparable = (value: (typeof scenes)[number]): unknown => ({
      targetKind: value.targetKind,
      representationSha256: value.representationSha256,
      camera: value.camera,
      context: value.context,
      hand: value.hand,
      playerModel: value.playerModel,
      fov: value.fov,
      resolution: value.resolution,
      guiScale: value.guiScale,
      animationState: value.animationState,
      frame: value.frame,
      cameraPoseSemantics: value.cameraPoseSemantics,
      cameraPose: value.cameraPose,
      expectedRenderCameraPose: value.expectedRenderCameraPose,
      environment: value.environment,
      settlingTicks: value.settlingTicks,
      fixture: value.fixture,
    });
    if (!canonicalJsonBytes(comparable(scene)).equals(canonicalJsonBytes(comparable(vanilla)))) {
      context.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Debug hitbox scene '${scene.id}' does not match its authoritative gameplay pair`,
      });
    }
  }
  for (const scene of measurementControls) {
    const vanilla = vanillaByBaseId.get(scene.baseSceneId);
    if (vanilla === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Measurement control '${scene.id}' has no matching authoritative vanilla scene`,
      });
      continue;
    }
    const comparable = (value: (typeof scenes)[number]): unknown => ({
      targetKind: value.targetKind,
      representationSha256: value.representationSha256,
      camera: value.camera,
      context: value.context,
      hand: value.hand,
      playerModel: value.playerModel,
      fov: value.fov,
      resolution: value.resolution,
      guiScale: value.guiScale,
      animationState: value.animationState,
      frame: value.frame,
      cameraPoseSemantics: value.cameraPoseSemantics,
      cameraPose: value.cameraPose,
      expectedRenderCameraPose: value.expectedRenderCameraPose,
      environment: value.environment,
    });
    if (
      !canonicalJsonBytes(comparable(scene)).equals(canonicalJsonBytes(comparable(vanilla))) ||
      scene.fixture.kind !== 'measurement_control' ||
      scene.fixture.stateId !== vanilla.fixture.stateId ||
      !sameCanonicalValue(scene.comparisonSceneIds, [vanilla.id]) ||
      !vanilla.comparisonSceneIds.includes(scene.id)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scenes'],
        message: `Measurement control '${scene.id}' does not match its authoritative empty-subject pair`,
      });
    }
  }
}

function addPlanBindingChecks(
  value: {
    readonly provenance: z.infer<typeof ClientCaptureProvenanceSchema>;
    readonly scenes: readonly z.infer<typeof ClientCaptureSceneSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const representation = value.provenance.representation;
  const stateIds = new Set(Object.keys(representation.states));
  const knownSceneIds = new Set(value.scenes.map((entry) => entry.id));
  const scenesById = new Map(value.scenes.map((entry) => [entry.id, entry]));
  const measurementIds = new Set<string>();
  for (const [index, scene] of value.scenes.entries()) {
    if (scene.targetKind !== representation.targetKind) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'targetKind'],
        message: 'Capture scene target kind does not match the bound representation',
      });
    }
    if (scene.representationSha256 !== value.provenance.representationSha256) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'representationSha256'],
        message: 'Capture scene representation hash does not match provenance',
      });
    }
    if (
      scene.fixture.kind !== 'measurement_control' &&
      scene.fixture.kind !== representation.strategy
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'fixture', 'kind'],
        message: 'Capture fixture strategy does not match the exact representation strategy',
      });
    }
    if (!stateIds.has(scene.fixture.stateId)) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'fixture', 'stateId'],
        message: `Capture fixture selects undeclared representation state '${scene.fixture.stateId}'`,
      });
    }
    if (
      representation.strategy === 'equippable_head' &&
      scene.fixture.kind === 'equippable_head' &&
      scene.fixture.chestArmor &&
      representation.review.chestArmorItemStack === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'fixture', 'chestArmor'],
        message: 'Headwear scene requests chest armor without an exact declared chest item stack',
      });
    }
    for (const comparison of scene.comparisonSceneIds) {
      if (!knownSceneIds.has(comparison)) {
        context.addIssue({
          code: 'custom',
          path: ['scenes', index, 'comparisonSceneIds'],
          message: `Capture scene compares against missing scene '${comparison}'`,
        });
      }
    }
    if (
      (scene.viewKind === 'comparison_reference' ||
        scene.viewKind === 'world_scale_reference' ||
        scene.viewKind === 'measurement_control') &&
      (scene.comparisonSceneIds.length === 0 ||
        scene.comparisonSceneIds.some(
          (comparison) => scenesById.get(comparison)?.requiredForAuthority !== true,
        ))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scenes', index, 'comparisonSceneIds'],
        message:
          'Augmented comparison, world-scale, and measurement-control views must name an authoritative control',
      });
    }
    for (const intent of scene.measurementIntents) {
      if (measurementIds.has(intent.id)) {
        context.addIssue({
          code: 'custom',
          path: ['scenes', index, 'measurementIntents'],
          message: `Duplicate capture measurement intent '${intent.id}'`,
        });
      }
      measurementIds.add(intent.id);
      const resolvedSourceSceneIds = intent.sourceSceneIds ?? [
        scene.id,
        ...scene.comparisonSceneIds,
      ];
      if (intent.requiredForReadiness) {
        if (!scene.requiredForAuthority) {
          context.addIssue({
            code: 'custom',
            path: ['scenes', index, 'measurementIntents', intent.id, 'requiredForReadiness'],
            message: `Critical measurement '${intent.id}' must be owned by an authoritative required scene`,
          });
        }
        if (intent.threshold === undefined) {
          context.addIssue({
            code: 'custom',
            path: ['scenes', index, 'measurementIntents', intent.id, 'threshold'],
            message: `Critical measurement '${intent.id}' requires a calibrated decision threshold`,
          });
        }
        if (!CLIENT_CAPTURE_READINESS_MEASUREMENT_METRICS.has(intent.metric)) {
          context.addIssue({
            code: 'custom',
            path: ['scenes', index, 'measurementIntents', intent.id, 'metric'],
            message: `Metric '${intent.metric}' is not calibrated for capture readiness`,
          });
        }
        if (
          resolvedSourceSceneIds.length !== 2 ||
          resolvedSourceSceneIds.some(
            (sourceSceneId) => scenesById.get(sourceSceneId)?.requiredForAuthority !== true,
          )
        ) {
          context.addIssue({
            code: 'custom',
            path: ['scenes', index, 'measurementIntents', intent.id, 'sourceSceneIds'],
            message:
              'Critical measurements require exactly two authoritative required framebuffer sources; supplemental controls and debug frames can never gate readiness',
          });
        }
      }
      if (intent.sourceSceneIds !== undefined) {
        if (!intent.sourceSceneIds.includes(scene.id)) {
          context.addIssue({
            code: 'custom',
            path: ['scenes', index, 'measurementIntents', intent.id, 'sourceSceneIds'],
            message: `Measurement '${intent.id}' must include its owning scene as a source`,
          });
        }
        for (const sourceSceneId of intent.sourceSceneIds) {
          if (!knownSceneIds.has(sourceSceneId)) {
            context.addIssue({
              code: 'custom',
              path: ['scenes', index, 'measurementIntents', intent.id, 'sourceSceneIds'],
              message: `Measurement '${intent.id}' references missing source scene '${sourceSceneId}'`,
            });
          } else if (
            sourceSceneId !== scene.id &&
            !scene.comparisonSceneIds.includes(sourceSceneId)
          ) {
            context.addIssue({
              code: 'custom',
              path: ['scenes', index, 'measurementIntents', intent.id, 'sourceSceneIds'],
              message: `Measurement '${intent.id}' source '${sourceSceneId}' is not an exact comparison binding`,
            });
          }
        }
      }
    }
  }
  if (
    representation.strategy === 'equippable_head' &&
    representation.review.chestArmorItemStack !== undefined
  ) {
    for (const playerModel of ['steve', 'alex'] as const) {
      const sceneId = `head_chest_${playerModel}`;
      const scene = scenesById.get(sceneId);
      const isExactChestScene =
        scene?.playerModel === playerModel &&
        scene.fixture.kind === 'equippable_head' &&
        scene.fixture.chestArmor &&
        scene.fixture.subject === 'player' &&
        scene.fixture.framing === 'full_body' &&
        scene.comparisonSceneIds.includes(`head_${playerModel}_front_full`);
      if (!isExactChestScene) {
        context.addIssue({
          code: 'custom',
          path: ['scenes'],
          message: `Declared chest armor requires exact '${sceneId}' compatibility evidence`,
        });
      }
    }
  }
  if (representation.strategy === 'equippable_head') {
    const stateId = Object.keys(representation.states)[0];
    for (const [sceneId, viewAngle] of [
      ['head_stand_front', 'front'],
      ['head_stand_side', 'side'],
    ] as const) {
      const scene = scenesById.get(sceneId);
      const expectedRenderCameraPose =
        viewAngle === 'front'
          ? { x: 0.5, y: 80.95, z: 11.5, yaw: 180 }
          : { x: -5.5, y: 80.95, z: 5.5, yaw: -90 };
      const isExactArmorStandScene =
        stateId !== undefined &&
        scene?.camera === 'neutral' &&
        scene.context === 'world' &&
        scene.cameraPose.x === 0.5 &&
        scene.cameraPose.y === 80 &&
        scene.cameraPose.z === 5.5 &&
        scene.cameraPose.yaw === 0 &&
        scene.expectedRenderCameraPose.x === expectedRenderCameraPose.x &&
        scene.expectedRenderCameraPose.y === expectedRenderCameraPose.y &&
        scene.expectedRenderCameraPose.z === expectedRenderCameraPose.z &&
        scene.expectedRenderCameraPose.yaw === expectedRenderCameraPose.yaw &&
        scene.fixture.kind === 'equippable_head' &&
        scene.fixture.stateId === stateId &&
        scene.fixture.subject === 'armor_stand' &&
        scene.fixture.framing === 'full_body' &&
        scene.fixture.pose === 'idle' &&
        scene.fixture.viewAngle === viewAngle &&
        scene.fixture.cameraDistance === 6 &&
        !scene.fixture.chestArmor;
      if (!isExactArmorStandScene) {
        context.addIssue({
          code: 'custom',
          path: ['scenes'],
          message: `Equippable headwear requires exact '${sceneId}' armor-stand evidence`,
        });
      }
    }
  }
}

const ClientCapturePlanBodySchema = z
  .object({
    schemaVersion: z.literal(CLIENT_CAPTURE_PROTOCOL_VERSION),
    kind: z.literal('packwright.client-capture-plan'),
    minecraftVersion: z.literal(CLIENT_CAPTURE_MINECRAFT_VERSION),
    provenance: ClientCaptureProvenanceSchema,
    studio: ClientCaptureStudioSchema,
    scenes: z.array(ClientCaptureSceneSchema).min(1).max(CLIENT_CAPTURE_LIMITS.maxScenes),
    execution: ClientCaptureExecutionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueSortedSceneChecks(value.scenes, context);
    addPlanBindingChecks(value, context);
  });

export const ClientCapturePlanSchema = z
  .object({
    schemaVersion: z.literal(CLIENT_CAPTURE_PROTOCOL_VERSION),
    kind: z.literal('packwright.client-capture-plan'),
    minecraftVersion: z.literal(CLIENT_CAPTURE_MINECRAFT_VERSION),
    provenance: ClientCaptureProvenanceSchema,
    studio: ClientCaptureStudioSchema,
    scenes: z.array(ClientCaptureSceneSchema).min(1).max(CLIENT_CAPTURE_LIMITS.maxScenes),
    execution: ClientCaptureExecutionSchema,
    planSha256: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueSortedSceneChecks(value.scenes, context);
    addPlanBindingChecks(value, context);
  });

export type ClientCaptureScene = z.infer<typeof ClientCaptureSceneSchema>;
export type ClientCaptureViewKind = ClientCaptureScene['viewKind'];
export type ClientCaptureViewAuthority =
  'authoritative_environment_capture' | 'augmented_qa_reference';

export function clientCaptureViewAuthority(
  scene: Pick<ClientCaptureScene, 'viewKind'>,
): ClientCaptureViewAuthority {
  return scene.viewKind === 'first_person_scale_reference' ||
    scene.viewKind === 'debug_hitbox_reference' ||
    scene.viewKind === 'comparison_reference' ||
    scene.viewKind === 'world_scale_reference' ||
    scene.viewKind === 'measurement_control'
    ? 'augmented_qa_reference'
    : 'authoritative_environment_capture';
}
export type ClientCaptureItemStack = z.infer<typeof ClientCaptureItemStackSchema>;
export type ClientCaptureProvenance = z.infer<typeof ClientCaptureProvenanceSchema>;
export type ClientCaptureExecution = z.infer<typeof ClientCaptureExecutionSchema>;
export type ClientCapturePlan = z.infer<typeof ClientCapturePlanSchema>;
type ClientCapturePlanBodyInput = z.input<typeof ClientCapturePlanBodySchema>;
export type ClientCapturePlanInput = Omit<ClientCapturePlanBodyInput, 'scenes'> & {
  readonly scenes: readonly z.input<typeof ClientCaptureSceneSchema>[];
};

function stablePlanValue(plan: z.infer<typeof ClientCapturePlanBodySchema>): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    minecraftVersion: plan.minecraftVersion,
    provenance: plan.provenance,
    studio: plan.studio,
    scenes: plan.scenes,
  };
}

export function computeClientCapturePlanSha256(
  plan: ClientCapturePlan | z.infer<typeof ClientCapturePlanBodySchema>,
): string {
  return sha256Buffer(canonicalJsonBytes(stablePlanValue(plan)));
}

export function computeClientCaptureSceneSha256(scene: ClientCaptureScene): string {
  const parsed = ClientCaptureSceneSchema.parse(scene);
  return sha256Buffer(canonicalJsonBytes(parsed));
}

/**
 * Stable identity for the exact declarative state and scene fixture the client
 * executor says it applied. This is intentionally narrower than the full
 * representation hash and wider than a logical state id: entity components and
 * equipment, display-node transforms, the equipped item stack, and target
 * fixture parameters all participate.
 */
export function computeClientCaptureAppliedFixtureSha256(
  representationValue: unknown,
  sceneValue: unknown,
): string {
  const representation = ClientCaptureRepresentationSchema.parse(representationValue);
  const scene = ClientCaptureSceneSchema.parse(sceneValue);
  const state = representation.states[scene.fixture.stateId];
  if (
    state === undefined ||
    representation.targetKind !== scene.targetKind ||
    (scene.fixture.kind !== 'measurement_control' && representation.strategy !== scene.fixture.kind)
  ) {
    throw new Error('Cannot hash a fixture that is not bound to its exact representation state.');
  }
  return sha256Buffer(
    canonicalJsonBytes({
      targetKind: representation.targetKind,
      strategy: scene.fixture.kind,
      capability: representation.capability,
      stateId: scene.fixture.stateId,
      representationState: state,
      sceneFixture: scene.fixture,
      ...(scene.presentation === undefined ? {} : { scenePresentation: scene.presentation }),
      ...('review' in representation ? { review: representation.review } : {}),
      ...(representation.strategy === 'equippable_head'
        ? { headwear: representation.headwear }
        : {}),
    }),
  );
}

export function createClientCapturePlan(input: ClientCapturePlanInput): ClientCapturePlan {
  const candidate = {
    ...input,
    scenes: [...input.scenes].sort((left, right) => compareAscii(left.id, right.id)),
  };
  const body = ClientCapturePlanBodySchema.parse(candidate);
  const plan = ClientCapturePlanSchema.parse({
    ...body,
    planSha256: computeClientCapturePlanSha256(body),
  });
  if (canonicalJsonBytes(plan).length > CLIENT_CAPTURE_LIMITS.maxPlanBytes) {
    throw new Error('Client capture plan exceeds the protocol byte budget.');
  }
  return plan;
}

export function parseClientCapturePlan(value: unknown): ClientCapturePlan {
  if (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 2
  ) {
    throw new Error(
      'Client capture protocol-v2 evidence is immutable legacy evidence and cannot be interpreted as v3; inspect it with parseLegacyClientCapturePlanMetadata and recapture for current authority.',
    );
  }
  const plan = ClientCapturePlanSchema.parse(value);
  if (canonicalJsonBytes(plan).length > CLIENT_CAPTURE_LIMITS.maxPlanBytes) {
    throw new Error('Client capture plan exceeds the protocol byte budget.');
  }
  const expected = computeClientCapturePlanSha256(plan);
  if (plan.planSha256 !== expected) {
    throw new Error('Client capture plan hash does not match its stable identity.');
  }
  return plan;
}

const LegacyClientCapturePlanEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal('packwright.client-capture-plan'),
    minecraftVersion: z.literal(CLIENT_CAPTURE_MINECRAFT_VERSION),
    provenance: z.record(z.string(), z.unknown()),
    scenes: z.array(z.unknown()).min(1).max(32),
    execution: ClientCaptureExecutionSchema,
    planSha256: Sha256Schema,
  })
  .strict();

export interface LegacyClientCapturePlanMetadata {
  readonly schemaVersion: 2;
  readonly minecraftVersion: typeof CLIENT_CAPTURE_MINECRAFT_VERSION;
  readonly planSha256: string;
  readonly sceneCount: number;
  readonly recaptureRequired: true;
}

/**
 * Read and hash-check immutable v0.4/protocol-v2 evidence without broadening
 * its authority or feeding it to the v3 runtime. A current capture must be
 * produced before the evidence can satisfy v3 target/profile requirements.
 */
export function parseLegacyClientCapturePlanMetadata(
  value: unknown,
): LegacyClientCapturePlanMetadata {
  const legacy = LegacyClientCapturePlanEnvelopeSchema.parse(value);
  if (canonicalJsonBytes(legacy).length > CLIENT_CAPTURE_LIMITS.maxPlanBytes) {
    throw new Error('Legacy client capture plan exceeds the protocol byte budget.');
  }
  const expected = sha256Buffer(
    canonicalJsonBytes({
      schemaVersion: legacy.schemaVersion,
      kind: legacy.kind,
      minecraftVersion: legacy.minecraftVersion,
      provenance: legacy.provenance,
      scenes: legacy.scenes,
    }),
  );
  if (legacy.planSha256 !== expected) {
    throw new Error('Legacy client capture plan hash does not match its v2 stable identity.');
  }
  return {
    schemaVersion: 2,
    minecraftVersion: legacy.minecraftVersion,
    planSha256: legacy.planSha256,
    sceneCount: legacy.scenes.length,
    recaptureRequired: true,
  };
}

export function canonicalClientCapturePlanBytes(value: unknown): Buffer {
  return canonicalJsonBytes(parseClientCapturePlan(value));
}

export function parseClientCapturePlanBytes(bytes: Uint8Array): ClientCapturePlan {
  const value = parseCanonicalJsonBytes(
    bytes,
    'Client capture plan',
    CLIENT_CAPTURE_LIMITS.maxPlanBytes,
  );
  return parseClientCapturePlan(value);
}

export const ClientCaptureIdentitySchema = z
  .object({
    minecraftVersion: z.literal(CLIENT_CAPTURE_MINECRAFT_VERSION),
    projectId: SafeIdSchema,
    runId: ContentIdSchema,
    revisionId: ContentIdSchema,
    specSha256: Sha256Schema,
    compiledArtifactId: ContentIdSchema,
    proposalArtifactId: ContentIdSchema,
    projectManifestSha256: Sha256Schema,
    datapackContentSha256: Sha256Schema,
    resourcepackContentSha256: Sha256Schema,
    packActivation: z
      .object({
        datapack: z.literal(CLIENT_CAPTURE_PACK_ACTIVATION.datapack),
        resourcepack: z.literal(CLIENT_CAPTURE_PACK_ACTIVATION.resourcepack),
      })
      .strict(),
    runtimeManifestSha256: Sha256Schema,
    representationSha256: Sha256Schema,
    studioSha256: Sha256Schema,
    clientJarSha1: Sha1Schema,
    clientJarSha256: Sha256Schema,
    captureModId: z.string().regex(MOD_ID_PATTERN),
    captureModVersion: z.string().regex(VERSION_PATTERN),
    captureModSha256: Sha256Schema,
  })
  .strict();

export type ClientCaptureIdentity = z.infer<typeof ClientCaptureIdentitySchema>;

export function clientCaptureIdentityForPlan(planValue: unknown): ClientCaptureIdentity {
  const plan = parseClientCapturePlan(planValue);
  const provenance = plan.provenance;
  return ClientCaptureIdentitySchema.parse({
    minecraftVersion: plan.minecraftVersion,
    projectId: provenance.projectId,
    runId: provenance.runId,
    revisionId: provenance.revisionId,
    specSha256: provenance.specSha256,
    compiledArtifactId: provenance.compiledArtifactId,
    proposalArtifactId: provenance.proposalArtifactId,
    projectManifestSha256: provenance.projectManifestSha256,
    datapackContentSha256: provenance.datapackContentSha256,
    resourcepackContentSha256: provenance.resourcepackContentSha256,
    packActivation: provenance.packActivation,
    runtimeManifestSha256: provenance.runtimeManifestSha256,
    representationSha256: provenance.representationSha256,
    studioSha256: computeClientCaptureStudioSha256(plan.studio),
    clientJarSha1: provenance.client.jarSha1,
    clientJarSha256: provenance.client.jarSha256,
    captureModId: provenance.captureMod.id,
    captureModVersion: provenance.captureMod.version,
    captureModSha256: provenance.captureMod.sha256,
  });
}

const ObservedBlockFixtureFields = {
  stateId: SafeIdSchema,
  layout: BlockFixtureFields.layout,
  orientation: BlockFixtureFields.orientation,
  animationTick: BlockFixtureFields.animationTick,
  blockPosition: BlockFixtureFields.blockPosition,
  backdrop: BlockFixtureFields.backdrop,
  overlapCopies: BlockFixtureFields.overlapCopies,
} as const;
const ObservedEntityFixtureFields = {
  stateId: SafeIdSchema,
  pose: EntityFixtureFields.pose,
  angle: EntityFixtureFields.angle,
  showPlayerScale: EntityFixtureFields.showPlayerScale,
  animationTick: EntityFixtureFields.animationTick,
} as const;
const ObservedPlaceableFixtureFields = {
  stateId: SafeIdSchema,
  orientation: PlaceableFixtureFields.orientation,
  attachment: PlaceableFixtureFields.attachment,
  distance: PlaceableFixtureFields.distance,
  occluded: PlaceableFixtureFields.occluded,
  animationTick: PlaceableFixtureFields.animationTick,
  context: PlaceableFixtureFields.context,
  subjectPosition: PlaceableFixtureFields.subjectPosition,
} as const;

/** Canonical client-world fixture readback, distinct from the planned fixture hash. */
export const ClientCaptureObservedFixtureSchema = z.union([
  z
    .object({
      strategy: z.literal('item_stack'),
      targetKind: z.enum(['held_item', 'gui_item']),
      stateId: SafeIdSchema,
      itemStack: ClientCaptureDeclarativeItemStackSchema,
      equipped: z.boolean(),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('native_block_state'),
      targetKind: z.literal('block'),
      ...ObservedBlockFixtureFields,
      blockState: ClientCaptureBlockStateSchema,
      inventoryItemStack: ClientCaptureDeclarativeItemStackSchema.optional(),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('block_display'),
      targetKind: z.literal('block'),
      ...ObservedBlockFixtureFields,
      blockDisplay: ClientCaptureBlockDisplayNodeSchema,
      inventoryItemStack: ClientCaptureDeclarativeItemStackSchema.optional(),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('equippable_head'),
      targetKind: z.literal('headwear'),
      stateId: SafeIdSchema,
      subject: HeadwearFixtureSchema.shape.subject,
      framing: HeadwearFixtureSchema.shape.framing,
      pose: HeadwearFixtureSchema.shape.pose,
      viewAngle: HeadwearFixtureSchema.shape.viewAngle,
      cameraDistance: HeadwearFixtureSchema.shape.cameraDistance,
      renderMode: z.enum(['fallback_item', 'equipment_model']),
      headItemStack: ClientCaptureDeclarativeItemStackSchema.optional(),
      chestArmorItemStack: ClientCaptureDeclarativeItemStackSchema.optional(),
    })
    .strict(),
  z
    .object({
      strategy: z.literal('native_entity'),
      targetKind: z.literal('entity'),
      ...ObservedEntityFixtureFields,
      entity: ClientCaptureNativeEntitySchema,
    })
    .strict(),
  z
    .object({
      strategy: z.literal('native_placeable_block'),
      targetKind: z.literal('placeable'),
      ...ObservedPlaceableFixtureFields,
      blockState: ClientCaptureBlockStateSchema,
    })
    .strict(),
  z
    .object({
      strategy: z.literal('native_placeable_entity'),
      targetKind: z.literal('placeable'),
      ...ObservedPlaceableFixtureFields,
      entity: ClientCaptureNativeEntitySchema,
    })
    .strict(),
  z
    .object({
      strategy: z.literal('display_rig'),
      targetKind: z.literal('entity'),
      ...ObservedEntityFixtureFields,
      displayRig: ClientCaptureDisplayRigSchema,
    })
    .strict(),
  z
    .object({
      strategy: z.literal('display_rig'),
      targetKind: z.literal('placeable'),
      ...ObservedPlaceableFixtureFields,
      displayRig: ClientCaptureDisplayRigSchema,
    })
    .strict(),
  z
    .object({
      strategy: z.literal('measurement_control'),
      targetKind: z.enum(['block', 'headwear', 'entity', 'placeable']),
      stateId: SafeIdSchema,
      baseSceneId: SafeIdSchema,
      subjectOmitted: z.literal(true),
    })
    .strict(),
]);

export type ClientCaptureObservedFixture = z.infer<typeof ClientCaptureObservedFixtureSchema>;

export function computeClientCaptureObservedFixtureSha256(value: unknown): string {
  return sha256Buffer(canonicalJsonBytes(ClientCaptureObservedFixtureSchema.parse(value)));
}

export function expectedClientCaptureObservedFixture(
  representationValue: unknown,
  sceneValue: unknown,
): ClientCaptureObservedFixture {
  const representation = ClientCaptureRepresentationSchema.parse(representationValue);
  const scene = ClientCaptureSceneSchema.parse(sceneValue);
  if (scene.fixture.kind === 'measurement_control') {
    return ClientCaptureObservedFixtureSchema.parse({
      strategy: 'measurement_control',
      targetKind: scene.targetKind,
      stateId: scene.fixture.stateId,
      baseSceneId: scene.baseSceneId,
      subjectOmitted: true,
    });
  }
  switch (representation.strategy) {
    case 'item_stack': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'item_stack') {
        throw new Error('Expected an item-stack fixture state.');
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'item_stack',
        targetKind: representation.targetKind,
        stateId: scene.fixture.stateId,
        itemStack: state.itemStack,
        equipped: scene.context === 'world',
      });
    }
    case 'native_block_state': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'native_block_state') {
        throw new Error('Expected a native-block fixture state.');
      }
      const common = {
        strategy: 'native_block_state' as const,
        targetKind: 'block' as const,
        stateId: scene.fixture.stateId,
        layout: scene.fixture.layout,
        orientation: scene.fixture.orientation,
        animationTick: scene.fixture.animationTick,
        blockPosition: scene.fixture.blockPosition,
        backdrop: scene.fixture.backdrop,
        overlapCopies: scene.fixture.overlapCopies,
        ...(scene.fixture.layout === 'inventory' &&
        representation.review.inventoryItemStack !== undefined
          ? { inventoryItemStack: representation.review.inventoryItemStack }
          : {}),
      };
      return ClientCaptureObservedFixtureSchema.parse({
        ...common,
        blockState: state.blockState,
      });
    }
    case 'block_display': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'block_display') {
        throw new Error('Expected a block-display fixture state.');
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'block_display',
        targetKind: 'block',
        stateId: scene.fixture.stateId,
        layout: scene.fixture.layout,
        orientation: scene.fixture.orientation,
        animationTick: scene.fixture.animationTick,
        blockPosition: scene.fixture.blockPosition,
        backdrop: scene.fixture.backdrop,
        overlapCopies: scene.fixture.overlapCopies,
        ...(scene.fixture.layout === 'inventory' &&
        representation.review.inventoryItemStack !== undefined
          ? { inventoryItemStack: representation.review.inventoryItemStack }
          : {}),
        blockDisplay: state.blockDisplay,
      });
    }
    case 'equippable_head': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'equippable_head') {
        throw new Error('Expected an equippable-head fixture state.');
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'equippable_head',
        targetKind: 'headwear',
        stateId: scene.fixture.stateId,
        subject: scene.fixture.subject,
        framing: scene.fixture.framing,
        pose: scene.fixture.pose,
        viewAngle: scene.fixture.viewAngle,
        cameraDistance: scene.fixture.cameraDistance,
        renderMode: representation.headwear.renderMode,
        ...(scene.fixture.subject === 'bare_control' ? {} : { headItemStack: state.itemStack }),
        ...(scene.fixture.chestArmor && representation.review.chestArmorItemStack !== undefined
          ? { chestArmorItemStack: representation.review.chestArmorItemStack }
          : {}),
      });
    }
    case 'native_entity': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'native_entity') {
        throw new Error('Expected a native-entity fixture state.');
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'native_entity',
        targetKind: 'entity',
        stateId: scene.fixture.stateId,
        pose: scene.fixture.pose,
        angle: scene.fixture.angle,
        showPlayerScale: scene.fixture.showPlayerScale,
        animationTick: scene.fixture.animationTick,
        entity: state.entity,
      });
    }
    case 'native_placeable_block': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'native_placeable_block') {
        throw new Error('Expected a native placeable-block fixture state.');
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'native_placeable_block',
        targetKind: 'placeable',
        stateId: scene.fixture.stateId,
        orientation: scene.fixture.orientation,
        attachment: scene.fixture.attachment,
        distance: scene.fixture.distance,
        occluded: scene.fixture.occluded,
        animationTick: scene.fixture.animationTick,
        context: scene.fixture.context,
        subjectPosition: scene.fixture.subjectPosition,
        blockState: state.blockState,
      });
    }
    case 'native_placeable_entity': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'native_placeable_entity') {
        throw new Error('Expected a native placeable-entity fixture state.');
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'native_placeable_entity',
        targetKind: 'placeable',
        stateId: scene.fixture.stateId,
        orientation: scene.fixture.orientation,
        attachment: scene.fixture.attachment,
        distance: scene.fixture.distance,
        occluded: scene.fixture.occluded,
        animationTick: scene.fixture.animationTick,
        context: scene.fixture.context,
        subjectPosition: scene.fixture.subjectPosition,
        entity: state.entity,
      });
    }
    case 'display_rig': {
      const state = representation.states[scene.fixture.stateId];
      if (state === undefined || scene.fixture.kind !== 'display_rig') {
        throw new Error('Expected a display-rig fixture state.');
      }
      if (scene.fixture.targetKind === 'entity') {
        return ClientCaptureObservedFixtureSchema.parse({
          strategy: 'display_rig',
          targetKind: 'entity',
          stateId: scene.fixture.stateId,
          pose: scene.fixture.pose,
          angle: scene.fixture.angle,
          showPlayerScale: scene.fixture.showPlayerScale,
          animationTick: scene.fixture.animationTick,
          displayRig: state.displayRig,
        });
      }
      return ClientCaptureObservedFixtureSchema.parse({
        strategy: 'display_rig',
        targetKind: 'placeable',
        stateId: scene.fixture.stateId,
        orientation: scene.fixture.orientation,
        attachment: scene.fixture.attachment,
        distance: scene.fixture.distance,
        occluded: scene.fixture.occluded,
        animationTick: scene.fixture.animationTick,
        context: scene.fixture.context,
        subjectPosition: scene.fixture.subjectPosition,
        displayRig: state.displayRig,
      });
    }
  }
}

const ClientCaptureViewSchema = z
  .object({
    sceneId: SafeIdSchema,
    sceneSha256: Sha256Schema,
    scene: ClientCaptureSceneSchema,
    path: ClientCaptureArtifactPathSchema,
    pngSha256: Sha256Schema,
    bytes: z.number().int().positive().max(CLIENT_CAPTURE_LIMITS.maxPngBytes),
    width: z.number().int().min(64).max(CLIENT_CAPTURE_LIMITS.maxWidth),
    height: z.number().int().min(64).max(CLIENT_CAPTURE_LIMITS.maxHeight),
    representationSha256: Sha256Schema,
    studioSha256: Sha256Schema,
    actualScaleReference: ClientCaptureStudioScaleReferenceSchema,
    actualScaleReferenceSha256: Sha256Schema,
    fixtureSha256: Sha256Schema,
    appliedFixtureSha256: Sha256Schema,
    observedFixture: ClientCaptureObservedFixtureSchema,
    observedFixtureSha256: Sha256Schema,
    actualSettledTicks: z.number().int().min(0).max(40),
    renderedSettleFrames: z.number().int().min(0).max(120),
    actualAnimationTick: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxFrame),
    actualCameraPose: ClientCaptureCameraPoseSchema,
    actualCameraMode: z.enum(['first_person', 'third_person_back', 'third_person_front']),
    actualContext: z.enum(['world', 'inventory', 'hotbar', 'tooltip', 'item_inspection']),
    actualFov: z.number().int().min(CLIENT_CAPTURE_LIMITS.minFov).max(CLIENT_CAPTURE_LIMITS.maxFov),
    actualGuiScale: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxGuiScale),
    actualHand: z.enum(['right', 'left']),
    actualPlayerModel: z.enum(['steve', 'alex']),
    actualEnvironment: ClientCaptureEnvironmentSchema,
    resourceReloadReady: z.literal(true),
    modelBakeReady: z.literal(true),
    fixtureEvidence: z
      .object({
        strategy: z.enum([
          'item_stack',
          'native_block_state',
          'block_display',
          'equippable_head',
          'native_entity',
          'display_rig',
          'native_placeable_block',
          'native_placeable_entity',
          'measurement_control',
        ]),
        stateId: SafeIdSchema,
        equippedItemId: ResourceIdSchema.optional(),
        inventoryItemId: ResourceIdSchema.optional(),
        equipReady: z.literal(true).optional(),
        chestArmorItemId: ResourceIdSchema.optional(),
        chestArmorReady: z.literal(true).optional(),
        headwearSubject: z.enum(['player', 'armor_stand', 'bare_control']).optional(),
        headwearRenderMode: z.enum(['fallback_item', 'equipment_model']).optional(),
        placedBlockState: ClientCaptureBlockStateSchema.optional(),
        spawnedEntityType: ResourceIdSchema.optional(),
        spawnedEntityVariant: ResourceIdSchema.optional(),
        spawnedEntityBaby: z.boolean().optional(),
        spawnedEntityEquipment: EntityEquipmentSchema.optional(),
        displayNodeCount: z.number().int().min(1).max(32).optional(),
        interactionWidth: z.number().positive().max(64).optional(),
        interactionHeight: z.number().positive().max(64).optional(),
        scaleReference: z.literal('minecraft:mannequin').optional(),
        subjectOmitted: z.literal(true).optional(),
      })
      .strict(),
  })
  .strict();

export const ClientCaptureMeasurementSchema = z
  .object({
    id: SafeIdSchema,
    metric: ClientCaptureMeasurementMetricSchema,
    authority: z.literal('client_pixels'),
    requiredForReadiness: z.boolean(),
    sceneIds: z.array(SafeIdSchema).min(1).max(16),
    status: z.enum(['passed', 'warning', 'failed', 'skipped']),
    unit: z.enum(['percent', 'pixels', 'ratio', 'count', 'dot']),
    value: z.number().optional(),
    threshold: ClientCaptureMeasurementThresholdSchema.optional(),
    message: z.string().min(1).max(2048),
    sourcePngSha256s: z.array(Sha256Schema).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'skipped') {
      if (value.value !== undefined || value.sourcePngSha256s.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'Skipped client-pixel measurements cannot claim a value or framebuffer sources',
        });
      }
    } else if (value.value === undefined || value.sourcePngSha256s.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Measured client-pixel results require a value and source framebuffer hashes',
      });
    }
  });

const ClientCaptureLogSchema = z
  .object({
    path: ClientCaptureArtifactPathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().positive().max(CLIENT_CAPTURE_LIMITS.maxLogBytes),
    resourceReloadSucceeded: z.literal(true),
    modelBakeSucceeded: z.literal(true),
    excerpts: z.array(z.string().min(1).max(2048)).min(1).max(16),
  })
  .strict();

export const ClientCaptureRuntimeSchema = z
  .object({
    rendererBackend: z.literal('opengl'),
    operatingSystem: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    javaVersion: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    gpuVendor: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    gpuRenderer: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    driverVersion: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    studioSha256: Sha256Schema,
    settings: z
      .object({
        preferredGraphicsBackend: z.literal('opengl'),
        graphicsMode: z.literal('custom'),
        clouds: z.literal('off'),
        particles: z.literal('minimal'),
        entityShadows: z.literal(true),
        viewBobbing: z.literal(false),
        renderDistance: z.number().int().min(2).max(16),
        simulationDistance: z.number().int().min(2).max(12),
        debugUi: z.literal(false),
      })
      .strict(),
    settingsSha256: Sha256Schema,
    resourceReloadReadyTick: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxFrame),
    modelBakeReadyTick: z.number().int().min(0).max(CLIENT_CAPTURE_LIMITS.maxFrame),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.settingsSha256 !== sha256Buffer(canonicalJsonBytes(value.settings))) {
      context.addIssue({
        code: 'custom',
        path: ['settingsSha256'],
        message: 'Runtime settings hash does not match the exact recorded Minecraft settings',
      });
    }
    if (value.modelBakeReadyTick < value.resourceReloadReadyTick) {
      context.addIssue({
        code: 'custom',
        path: ['modelBakeReadyTick'],
        message: 'Model-bake readiness cannot precede resource-reload readiness',
      });
    }
  });

const SelectedPackIdsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) => !value.includes('\0') && !value.includes('\n') && !value.includes('\r'),
        'Selected pack id contains unsafe control characters',
      ),
  )
  .max(64)
  .refine(isAsciiSortedUnique, 'Selected pack IDs must be unique and ASCII sorted');

export const ClientCapturePackActivationAttestationSchema = z
  .object({
    datapack: z
      .object({
        mode: z.literal(CLIENT_CAPTURE_PACK_ACTIVATION.datapack),
        archivePath: z.literal(CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH),
        archiveSha256: Sha256Schema,
        selected: z.literal(false),
        selectedPackIds: SelectedPackIdsSchema,
      })
      .strict(),
    resourcepack: z
      .object({
        mode: z.literal(CLIENT_CAPTURE_PACK_ACTIVATION.resourcepack),
        archivePath: z.literal(CLIENT_CAPTURE_RESOURCEPACK_PATH),
        archiveSha256: Sha256Schema,
        selected: z.literal(true),
        selectedPackIds: SelectedPackIdsSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.datapack.selectedPackIds.includes(CLIENT_CAPTURE_RESOURCEPACK_ID)) {
      context.addIssue({
        code: 'custom',
        path: ['datapack', 'selectedPackIds'],
        message: 'The hash-bound project datapack must not be selected by the capture world',
      });
    }
    if (!value.resourcepack.selectedPackIds.includes(CLIENT_CAPTURE_RESOURCEPACK_ID)) {
      context.addIssue({
        code: 'custom',
        path: ['resourcepack', 'selectedPackIds'],
        message: 'The staged project resource pack must be selected for client rendering',
      });
    }
  });

export type ClientCapturePackActivationAttestation = z.infer<
  typeof ClientCapturePackActivationAttestationSchema
>;

const ClientCaptureReportCommonShape = {
  schemaVersion: z.literal(CLIENT_CAPTURE_PROTOCOL_VERSION),
  kind: z.literal('packwright.client-capture-report'),
  executionId: z.string().regex(EXECUTION_ID_PATTERN),
  planSha256: Sha256Schema,
  identity: ClientCaptureIdentitySchema,
  runtime: ClientCaptureRuntimeSchema,
} as const;

export const ClientCaptureCompleteReportSchema = z
  .object({
    ...ClientCaptureReportCommonShape,
    status: z.literal('complete'),
    packActivation: ClientCapturePackActivationAttestationSchema,
    views: z.array(ClientCaptureViewSchema).min(1).max(CLIENT_CAPTURE_LIMITS.maxScenes),
    measurements: z.array(ClientCaptureMeasurementSchema).max(CLIENT_CAPTURE_LIMITS.maxScenes * 16),
    log: ClientCaptureLogSchema,
  })
  .strict()
  .superRefine(({ views, measurements, log }, context) => {
    const sceneIds = new Set<string>();
    const paths = new Set<string>([log.path]);
    for (const [index, view] of views.entries()) {
      if (sceneIds.has(view.sceneId)) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'sceneId'],
          message: `Duplicate captured scene id '${view.sceneId}'`,
        });
      }
      sceneIds.add(view.sceneId);
      if (index > 0 && (views[index - 1]?.sceneId ?? '') >= view.sceneId) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'sceneId'],
          message: 'Captured views must be sorted by scene id',
        });
      }
      if (paths.has(view.path)) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'path'],
          message: `Duplicate capture artifact path '${view.path}'`,
        });
      }
      paths.add(view.path);
    }
    const measurementIds = new Set<string>();
    for (const [index, measurement] of measurements.entries()) {
      if (measurementIds.has(measurement.id)) {
        context.addIssue({
          code: 'custom',
          path: ['measurements', index, 'id'],
          message: `Duplicate client measurement id '${measurement.id}'`,
        });
      }
      measurementIds.add(measurement.id);
    }
  });

export const ClientCaptureFailureReportSchema = z
  .object({
    ...ClientCaptureReportCommonShape,
    status: z.literal('failed'),
    error: z
      .object({
        code: z.enum([
          'client_launch_failed',
          'resource_reload_failed',
          'scene_capture_failed',
          'cancelled',
          'timed_out',
          'internal_error',
        ]),
        message: z.string().min(1).max(4096),
      })
      .strict(),
  })
  .strict();

export const ClientCaptureReportSchema = z.discriminatedUnion('status', [
  ClientCaptureCompleteReportSchema,
  ClientCaptureFailureReportSchema,
]);

export type ClientCaptureCompleteReport = z.infer<typeof ClientCaptureCompleteReportSchema>;
export type ClientCaptureFailureReport = z.infer<typeof ClientCaptureFailureReportSchema>;
export type ClientCaptureReport = z.infer<typeof ClientCaptureReportSchema>;
export type ClientCaptureRuntime = z.infer<typeof ClientCaptureRuntimeSchema>;

export const ClientCaptureCompletionSentinelSchema = z
  .object({
    schemaVersion: z.literal(CLIENT_CAPTURE_PROTOCOL_VERSION),
    kind: z.literal('packwright.client-capture-complete'),
    executionId: z.string().regex(EXECUTION_ID_PATTERN),
    planSha256: Sha256Schema,
    report: z
      .object({
        path: ClientCaptureArtifactPathSchema,
        sha256: Sha256Schema,
        bytes: z.number().int().positive().max(CLIENT_CAPTURE_LIMITS.maxReportBytes),
      })
      .strict(),
  })
  .strict();

export type ClientCaptureCompletionSentinel = z.infer<typeof ClientCaptureCompletionSentinelSchema>;

function parseCanonicalJsonBytes(bytesValue: unknown, label: string, maximum: number): unknown {
  const bytes = requireArtifactBytes(bytesValue, label, maximum);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!bytes.equals(canonicalJsonBytes(value))) {
    throw new Error(`${label} is not canonical JSON.`);
  }
  return value;
}

export function parseClientCaptureCompletionSentinelBytes(
  bytes: Uint8Array,
  planValue: unknown,
): ClientCaptureCompletionSentinel {
  const plan = parseClientCapturePlan(planValue);
  const value = parseCanonicalJsonBytes(
    bytes,
    'Client capture completion sentinel',
    CLIENT_CAPTURE_LIMITS.maxSentinelBytes,
  );
  const sentinel = ClientCaptureCompletionSentinelSchema.parse(value);
  if (sentinel.executionId !== plan.execution.executionId) {
    throw new Error('Client capture completion sentinel execution id does not match the plan.');
  }
  if (sentinel.planSha256 !== plan.planSha256) {
    throw new Error('Client capture completion sentinel plan hash does not match the plan.');
  }
  return sentinel;
}

export function parseClientCaptureReportBytes(
  bytes: Uint8Array,
  planValue: unknown,
): ClientCaptureReport {
  const value = parseCanonicalJsonBytes(
    bytes,
    'Client capture report',
    CLIENT_CAPTURE_LIMITS.maxReportBytes,
  );
  return parseClientCaptureReport(value, planValue);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function sameOptionalCanonicalValue(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameCanonicalValue(left, right);
}

function assertReportIdentity(plan: ClientCapturePlan, report: ClientCaptureReport): void {
  if (report.executionId !== plan.execution.executionId) {
    throw new Error('Client capture report execution id does not match the launched plan.');
  }
  if (report.planSha256 !== plan.planSha256) {
    throw new Error('Client capture report plan hash does not match the launched plan.');
  }
  const expectedIdentity = clientCaptureIdentityForPlan(plan);
  if (!sameCanonicalValue(report.identity, expectedIdentity)) {
    throw new Error('Client capture report provenance identity does not match the launched plan.');
  }
}

function assertCompletePackActivation(
  plan: ClientCapturePlan,
  report: ClientCaptureCompleteReport,
): void {
  if (
    report.packActivation.datapack.archiveSha256 !== plan.provenance.datapackContentSha256 ||
    report.packActivation.resourcepack.archiveSha256 !==
      plan.provenance.resourcepackContentSha256 ||
    !sameCanonicalValue(plan.provenance.packActivation, {
      datapack: report.packActivation.datapack.mode,
      resourcepack: report.packActivation.resourcepack.mode,
    })
  ) {
    throw new Error(
      'Client capture report pack-activation evidence does not match the launched plan.',
    );
  }
}

export function parseClientCaptureReport(value: unknown, planValue: unknown): ClientCaptureReport {
  const plan = parseClientCapturePlan(planValue);
  const report = ClientCaptureReportSchema.parse(value);
  assertReportIdentity(plan, report);
  if (report.status === 'complete') {
    assertCompletePackActivation(plan, report);
    assertCompleteViews(plan, report);
  }
  return report;
}

function expectedSceneAnimationTick(scene: ClientCaptureScene): number {
  return 'animationTick' in scene.fixture ? scene.fixture.animationTick : scene.frame;
}

function normalizedAngleDifference(left: number, right: number): number {
  const raw = Math.abs(left - right) % 360;
  return Math.min(raw, 360 - raw);
}

function assertActualCameraPose(
  scene: ClientCaptureScene,
  actual: ClientCaptureScene['cameraPose'],
): void {
  const expected = scene.expectedRenderCameraPose;
  if (
    Math.abs(actual.x - expected.x) > CLIENT_CAPTURE_CAMERA_POSITION_TOLERANCE ||
    Math.abs(actual.y - expected.y) > CLIENT_CAPTURE_CAMERA_POSITION_TOLERANCE ||
    Math.abs(actual.z - expected.z) > CLIENT_CAPTURE_CAMERA_POSITION_TOLERANCE ||
    normalizedAngleDifference(actual.yaw, expected.yaw) > CLIENT_CAPTURE_CAMERA_ANGLE_TOLERANCE ||
    Math.abs(actual.pitch - expected.pitch) > CLIENT_CAPTURE_CAMERA_ANGLE_TOLERANCE
  ) {
    throw new Error(
      `Client capture scene '${scene.id}' used a render-camera pose outside the protocol tolerance.`,
    );
  }
}

function measurementStatusForValue(
  value: number,
  threshold: z.infer<typeof ClientCaptureMeasurementThresholdSchema>,
): 'passed' | 'warning' | 'failed' {
  if (threshold.comparison === 'above') {
    if (value >= threshold.failure) return 'failed';
    if (value >= threshold.warning) return 'warning';
    return 'passed';
  }
  if (value <= threshold.failure) return 'failed';
  if (value <= threshold.warning) return 'warning';
  return 'passed';
}

function assertCompleteViews(plan: ClientCapturePlan, report: ClientCaptureCompleteReport): void {
  if (report.views.length !== plan.scenes.length) {
    throw new Error(
      `Client capture report contains ${String(report.views.length)} views; expected ${String(plan.scenes.length)}.`,
    );
  }
  const planned = new Map(plan.scenes.map((scene) => [scene.id, scene]));
  for (const view of report.views) {
    const scene = planned.get(view.sceneId);
    if (scene === undefined) {
      throw new Error(`Client capture report contains unplanned scene '${view.sceneId}'.`);
    }
    if (!sameCanonicalValue(view.scene, scene)) {
      throw new Error(
        `Client capture scene '${view.sceneId}' was captured with altered parameters.`,
      );
    }
    if (view.sceneSha256 !== computeClientCaptureSceneSha256(scene)) {
      throw new Error(`Client capture scene '${view.sceneId}' has a tampered scene hash.`);
    }
    if (view.width !== scene.resolution.width || view.height !== scene.resolution.height) {
      throw new Error(`Client capture scene '${view.sceneId}' reports unexpected dimensions.`);
    }
    if (
      view.representationSha256 !== plan.provenance.representationSha256 ||
      view.studioSha256 !== computeClientCaptureStudioSha256(plan.studio) ||
      view.fixtureSha256 !== sha256Buffer(canonicalJsonBytes(scene.fixture)) ||
      view.appliedFixtureSha256 !==
        computeClientCaptureAppliedFixtureSha256(plan.provenance.representation, scene)
    ) {
      throw new Error(
        `Client capture scene '${view.sceneId}' has stale representation, studio, or fixture evidence.`,
      );
    }
    if (
      !sameCanonicalValue(view.actualScaleReference, plan.studio.scaleReference) ||
      view.actualScaleReferenceSha256 !==
        computeClientCaptureStudioScaleReferenceSha256(view.actualScaleReference) ||
      view.actualScaleReferenceSha256 !==
        computeClientCaptureStudioScaleReferenceSha256(plan.studio.scaleReference)
    ) {
      throw new Error(
        `Client capture scene '${view.sceneId}' has stale or altered studio scale-reference readback.`,
      );
    }
    const expectedObservedFixture = expectedClientCaptureObservedFixture(
      plan.provenance.representation,
      scene,
    );
    if (
      view.observedFixtureSha256 !==
        computeClientCaptureObservedFixtureSha256(view.observedFixture) ||
      !sameCanonicalValue(view.observedFixture, expectedObservedFixture)
    ) {
      throw new Error(
        `Client capture scene '${view.sceneId}' has stale or altered client-world fixture readback.`,
      );
    }
    if (
      view.actualSettledTicks !== scene.settlingTicks ||
      view.renderedSettleFrames < CLIENT_CAPTURE_MIN_SETTLE_FRAMES
    ) {
      throw new Error(
        `Client capture scene '${view.sceneId}' did not complete its deterministic settling interval.`,
      );
    }
    if (view.actualAnimationTick !== expectedSceneAnimationTick(scene)) {
      throw new Error(
        `Client capture scene '${view.sceneId}' did not reach its exact planned animation tick.`,
      );
    }
    assertActualCameraPose(scene, view.actualCameraPose);
    const expectedCameraMode = scene.camera === 'neutral' ? 'first_person' : scene.camera;
    if (
      view.actualCameraMode !== expectedCameraMode ||
      view.actualContext !== scene.context ||
      view.actualFov !== scene.fov ||
      view.actualGuiScale !== scene.guiScale ||
      view.actualHand !== scene.hand ||
      view.actualPlayerModel !== scene.playerModel ||
      !sameCanonicalValue(view.actualEnvironment, scene.environment)
    ) {
      throw new Error(
        `Client capture scene '${view.sceneId}' runtime camera, player, or environment settings do not match the plan.`,
      );
    }
    if (
      view.fixtureEvidence.strategy !== scene.fixture.kind ||
      view.fixtureEvidence.stateId !== scene.fixture.stateId
    ) {
      throw new Error(
        `Client capture scene '${view.sceneId}' fixture evidence does not match its selected representation state.`,
      );
    }
    assertFixtureEvidence(plan.provenance.representation, scene, view.fixtureEvidence);
    planned.delete(view.sceneId);
  }
  if (planned.size > 0) {
    throw new Error(
      `Client capture report is missing planned scenes: ${[...planned.keys()].sort().join(', ')}.`,
    );
  }
  if (report.runtime.studioSha256 !== computeClientCaptureStudioSha256(plan.studio)) {
    throw new Error('Client capture runtime studio settings do not match the launched plan.');
  }
  const expectedRuntimeSettings = {
    preferredGraphicsBackend: plan.studio.rendererBackend,
    graphicsMode: plan.studio.graphicsMode,
    clouds: plan.studio.clouds,
    particles: plan.studio.particles,
    entityShadows: plan.studio.entityShadows,
    viewBobbing: plan.studio.viewBobbing,
    renderDistance: plan.studio.renderDistance,
    simulationDistance: plan.studio.simulationDistance,
    debugUi: plan.studio.debugUi,
  };
  if (!sameCanonicalValue(report.runtime.settings, expectedRuntimeSettings)) {
    throw new Error('Client capture runtime settings do not match the launched studio profile.');
  }
  const viewsById = new Map(report.views.map((view) => [view.sceneId, view]));
  const plannedMeasurements = new Map<
    string,
    { intent: z.infer<typeof ClientCaptureMeasurementIntentSchema>; sceneIds: string[] }
  >();
  for (const scene of plan.scenes) {
    for (const intent of scene.measurementIntents) {
      const existing = plannedMeasurements.get(intent.id);
      if (existing === undefined)
        plannedMeasurements.set(intent.id, {
          intent,
          sceneIds: intent.sourceSceneIds ?? [scene.id, ...scene.comparisonSceneIds],
        });
    }
  }
  if (report.measurements.length !== plannedMeasurements.size) {
    throw new Error(
      `Client capture report contains ${String(report.measurements.length)} measurements; expected ${String(plannedMeasurements.size)}.`,
    );
  }
  for (const measurement of report.measurements) {
    const plannedMeasurement = plannedMeasurements.get(measurement.id);
    if (plannedMeasurement === undefined) {
      throw new Error(`Client capture report contains unplanned measurement '${measurement.id}'.`);
    }
    const expectedSceneIds = [...new Set(plannedMeasurement.sceneIds)].sort(compareAscii);
    if (!sameCanonicalValue(measurement.sceneIds, expectedSceneIds)) {
      throw new Error(`Client capture measurement '${measurement.id}' has altered scene bindings.`);
    }
    if (
      measurement.metric !== plannedMeasurement.intent.metric ||
      measurement.unit !== plannedMeasurement.intent.unit ||
      measurement.requiredForReadiness !== plannedMeasurement.intent.requiredForReadiness ||
      !sameOptionalCanonicalValue(measurement.threshold, plannedMeasurement.intent.threshold)
    ) {
      throw new Error(
        `Client capture measurement '${measurement.id}' does not match its planned intent.`,
      );
    }
    if (measurement.status !== 'skipped') {
      const value = measurement.value;
      if (value === undefined) {
        throw new Error(`Client capture measurement '${measurement.id}' has no measured value.`);
      }
      const threshold = plannedMeasurement.intent.threshold;
      if (threshold === undefined) {
        if (measurement.status !== 'warning') {
          throw new Error(
            `Client capture measurement '${measurement.id}' has no decision threshold and cannot claim pass or failure.`,
          );
        }
      } else if (measurement.status !== measurementStatusForValue(value, threshold)) {
        throw new Error(
          `Client capture measurement '${measurement.id}' status contradicts its measured value and threshold.`,
        );
      }
    }
    if (measurement.status !== 'skipped') {
      const expectedHashes = expectedSceneIds.map((sceneId) => {
        const view = viewsById.get(sceneId);
        if (view === undefined)
          throw new Error(
            `Client capture measurement '${measurement.id}' references a missing framebuffer.`,
          );
        return view.pngSha256;
      });
      if (!sameCanonicalValue(measurement.sourcePngSha256s, expectedHashes)) {
        throw new Error(
          `Client capture measurement '${measurement.id}' has stale framebuffer hashes.`,
        );
      }
    }
    plannedMeasurements.delete(measurement.id);
  }
}

function assertFixtureEvidence(
  representation: ClientCaptureRepresentation,
  scene: ClientCaptureScene,
  evidence: z.infer<typeof ClientCaptureViewSchema>['fixtureEvidence'],
): void {
  const state = representation.states[scene.fixture.stateId];
  if (state === undefined) {
    throw new Error(`Client capture scene '${scene.id}' references an undeclared fixture state.`);
  }
  const rejectUnexpected = (allowed: readonly (keyof typeof evidence)[], label: string): void => {
    const allowedSet = new Set<string>(allowed);
    for (const key of Object.keys(evidence)) {
      if (!allowedSet.has(key)) {
        throw new Error(
          `Client capture scene '${scene.id}' reports unexpected ${label} fixture evidence '${key}'.`,
        );
      }
    }
  };
  if (scene.fixture.kind === 'measurement_control') {
    rejectUnexpected(['strategy', 'stateId', 'subjectOmitted'], 'measurement-control');
    if (evidence.subjectOmitted !== true) {
      throw new Error(
        `Client capture scene '${scene.id}' did not attest its empty-subject measurement control.`,
      );
    }
    return;
  }
  switch (representation.strategy) {
    case 'item_stack': {
      rejectUnexpected(['strategy', 'stateId', 'equippedItemId', 'equipReady'], 'item');
      if (!('itemStack' in state) || evidence.equippedItemId !== state.itemStack.itemId) {
        throw new Error(
          `Client capture scene '${scene.id}' did not report its exact rendered item identifier.`,
        );
      }
      if (scene.context === 'world' && evidence.equipReady !== true) {
        throw new Error(
          `Client capture scene '${scene.id}' did not attest that its gameplay item was equipped.`,
        );
      }
      break;
    }
    case 'equippable_head': {
      if (scene.fixture.kind !== 'equippable_head') {
        throw new Error(`Client capture scene '${scene.id}' has a mismatched headwear fixture.`);
      }
      rejectUnexpected(
        [
          'strategy',
          'stateId',
          'equippedItemId',
          'equipReady',
          'chestArmorItemId',
          'chestArmorReady',
          'headwearSubject',
          'headwearRenderMode',
        ],
        'headwear',
      );
      if (
        !('itemStack' in state) ||
        evidence.headwearSubject !== scene.fixture.subject ||
        evidence.headwearRenderMode !== representation.headwear.renderMode
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' did not report its exact headwear subject and render mode.`,
        );
      }
      if (scene.fixture.subject === 'bare_control') {
        if (evidence.equippedItemId !== undefined || evidence.equipReady !== undefined) {
          throw new Error(
            `Client capture scene '${scene.id}' bare-head control unexpectedly reports equipped headwear.`,
          );
        }
      } else if (
        evidence.equippedItemId !== state.itemStack.itemId ||
        evidence.equipReady !== true
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' did not attest its exact equipped head item.`,
        );
      }
      if (scene.fixture.chestArmor) {
        if (
          representation.review.chestArmorItemStack === undefined ||
          evidence.chestArmorItemId !== representation.review.chestArmorItemStack.itemId ||
          evidence.chestArmorReady !== true
        ) {
          throw new Error(
            `Client capture scene '${scene.id}' did not attest its exact equipped chest-armor item.`,
          );
        }
      } else if (
        evidence.chestArmorItemId !== undefined ||
        evidence.chestArmorReady !== undefined
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' unexpectedly reports equipped chest armor.`,
        );
      }
      break;
    }
    case 'native_block_state':
    case 'native_placeable_block': {
      rejectUnexpected(['strategy', 'stateId', 'placedBlockState', 'inventoryItemId'], 'block');
      if (!('blockState' in state)) {
        throw new Error(`Client capture scene '${scene.id}' selected an invalid block state.`);
      }
      const isInventory =
        representation.strategy === 'native_block_state' &&
        scene.fixture.kind === 'native_block_state' &&
        scene.fixture.layout === 'inventory';
      if (isInventory) {
        if (
          evidence.placedBlockState !== undefined ||
          evidence.inventoryItemId !== representation.review.inventoryItemStack?.itemId
        ) {
          throw new Error(
            `Client capture scene '${scene.id}' did not report only its exact block inventory item.`,
          );
        }
      } else if (
        evidence.inventoryItemId !== undefined ||
        evidence.placedBlockState === undefined ||
        !sameCanonicalValue(evidence.placedBlockState, state.blockState)
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' did not report only its exact placed block state.`,
        );
      }
      break;
    }
    case 'block_display': {
      rejectUnexpected(
        ['strategy', 'stateId', 'placedBlockState', 'displayNodeCount', 'inventoryItemId'],
        'block-display',
      );
      if (!('blockDisplay' in state) || scene.fixture.kind !== 'block_display') {
        throw new Error(`Client capture scene '${scene.id}' selected an invalid block display.`);
      }
      if (scene.fixture.layout === 'inventory') {
        if (
          evidence.placedBlockState !== undefined ||
          evidence.displayNodeCount !== undefined ||
          evidence.inventoryItemId !== representation.review.inventoryItemStack?.itemId
        ) {
          throw new Error(
            `Client capture scene '${scene.id}' did not report only its exact block-display inventory item.`,
          );
        }
      } else if (
        evidence.inventoryItemId !== undefined ||
        evidence.displayNodeCount !== 1 ||
        evidence.placedBlockState === undefined ||
        !sameCanonicalValue(evidence.placedBlockState, state.blockDisplay.blockState)
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' did not report only its exact block-display world state.`,
        );
      }
      break;
    }
    case 'native_entity':
    case 'native_placeable_entity':
      rejectUnexpected(
        [
          'strategy',
          'stateId',
          'spawnedEntityType',
          'spawnedEntityVariant',
          'spawnedEntityBaby',
          'spawnedEntityEquipment',
          'scaleReference',
        ],
        'entity',
      );
      if (
        !('entity' in state) ||
        evidence.spawnedEntityType !== state.entity.entityType ||
        evidence.spawnedEntityVariant !== state.entity.variant ||
        evidence.spawnedEntityBaby !== state.entity.baby ||
        !sameCanonicalValue(evidence.spawnedEntityEquipment, state.entity.equipment)
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' did not report its exact spawned entity type, variant, age, and equipment.`,
        );
      }
      if (
        scene.fixture.kind === 'native_entity' &&
        evidence.scaleReference !==
          (scene.fixture.showPlayerScale ? 'minecraft:mannequin' : undefined)
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' has stale player-scale reference evidence.`,
        );
      }
      break;
    case 'display_rig': {
      if (scene.fixture.kind !== 'display_rig') {
        throw new Error(`Client capture scene '${scene.id}' has a mismatched display-rig fixture.`);
      }
      if (!('displayRig' in state)) {
        throw new Error(
          `Client capture scene '${scene.id}' selected an invalid display-rig state.`,
        );
      }
      const interaction = state.displayRig.interaction;
      const allowed: readonly (keyof typeof evidence)[] =
        interaction === undefined
          ? ['strategy', 'stateId', 'displayNodeCount', 'scaleReference']
          : [
              'strategy',
              'stateId',
              'displayNodeCount',
              'interactionWidth',
              'interactionHeight',
              'scaleReference',
            ];
      rejectUnexpected(allowed, 'display-rig');
      if (
        evidence.displayNodeCount !== state.displayRig.nodes.length ||
        (interaction !== undefined &&
          (evidence.interactionWidth !== interaction.width ||
            evidence.interactionHeight !== interaction.height))
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' did not report its exact display-rig fixture.`,
        );
      }
      if (
        scene.fixture.targetKind === 'entity' &&
        evidence.scaleReference !==
          (scene.fixture.showPlayerScale ? 'minecraft:mannequin' : undefined)
      ) {
        throw new Error(
          `Client capture scene '${scene.id}' has stale display-rig scale-reference evidence.`,
        );
      }
      break;
    }
  }
}

export type ClientCaptureArtifactReader = (
  relativePath: string,
  maxBytes: number,
) => Promise<Uint8Array>;

export interface VerifyClientCaptureArtifactsOptions {
  readonly readArtifact: ClientCaptureArtifactReader;
  readonly signal?: AbortSignal | undefined;
}

export interface VerifiedClientCaptureView {
  readonly sceneId: string;
  readonly path: string;
  readonly pngSha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

export interface VerifiedClientCaptureComplete {
  readonly plan: ClientCapturePlan;
  readonly report: ClientCaptureCompleteReport;
  readonly views: readonly VerifiedClientCaptureView[];
  readonly log: Readonly<{
    path: string;
    sha256: string;
    bytes: number;
    excerpts: readonly string[];
  }>;
}

export interface ClientCaptureEvidence extends VerifiedClientCaptureComplete {
  readonly outputDirectory: string;
  readonly completion: Readonly<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
  readonly reportArtifact: Readonly<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}

export interface VerifyClientCaptureOutputInput {
  readonly plan: unknown;
  /** Must exactly match the disposable output directory recorded in the plan. */
  readonly outputDirectory: string;
  /** Canonical path relative to outputDirectory. */
  readonly completionPath?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Client capture verification was cancelled.');
}

function requireArtifactBytes(value: unknown, label: string, maximum: number): Buffer {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} reader did not return a Uint8Array.`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > maximum) {
    throw new Error(`${label} exceeds its artifact byte budget.`);
  }
  return bytes;
}

export async function verifyClientCaptureComplete(
  planValue: unknown,
  reportValue: unknown,
  options: VerifyClientCaptureArtifactsOptions,
): Promise<VerifiedClientCaptureComplete> {
  const plan = parseClientCapturePlan(planValue);
  const parsed = parseClientCaptureReport(reportValue, plan);
  if (parsed.status !== 'complete') {
    throw new Error(
      `Client capture did not complete: ${parsed.error.code}: ${parsed.error.message}`,
    );
  }
  const report = parsed;
  const views: VerifiedClientCaptureView[] = [];
  const decodedViews = new Map<string, ReturnType<typeof decodePng>>();
  for (const view of report.views) {
    abortIfNeeded(options.signal);
    const png = requireArtifactBytes(
      await options.readArtifact(view.path, CLIENT_CAPTURE_LIMITS.maxPngBytes),
      `Client capture PNG '${view.path}'`,
      CLIENT_CAPTURE_LIMITS.maxPngBytes,
    );
    const decoded = decodePng(png, {
      maxFileBytes: CLIENT_CAPTURE_LIMITS.maxPngBytes,
      maxWidth: CLIENT_CAPTURE_LIMITS.maxWidth,
      maxHeight: CLIENT_CAPTURE_LIMITS.maxHeight,
      maxPixels: CLIENT_CAPTURE_LIMITS.maxPixels,
      maxDecodedBytes: CLIENT_CAPTURE_LIMITS.maxPixels * 4,
    });
    if (
      decoded.sourceSha256 !== view.pngSha256 ||
      png.length !== view.bytes ||
      decoded.width !== view.width ||
      decoded.height !== view.height
    ) {
      throw new Error(`Client capture PNG '${view.path}' does not match its report metadata.`);
    }
    views.push({
      sceneId: view.sceneId,
      path: view.path,
      pngSha256: decoded.sourceSha256,
      bytes: png.length,
      width: decoded.width,
      height: decoded.height,
    });
    decodedViews.set(view.sceneId, decoded);
  }

  for (const measurement of report.measurements) {
    if (measurement.metric !== 'pairwise_pixel_delta' || measurement.status === 'skipped') continue;
    const owner = plan.scenes.find((scene) =>
      scene.measurementIntents.some((intent) => intent.id === measurement.id),
    );
    const intent = owner?.measurementIntents.find((entry) => entry.id === measurement.id);
    const sourceSceneIds =
      owner === undefined || intent === undefined
        ? []
        : (intent.sourceSceneIds ?? [owner.id, ...owner.comparisonSceneIds]);
    const comparisonSceneIds = sourceSceneIds.filter((sceneId) => sceneId !== owner?.id);
    if (owner === undefined || comparisonSceneIds.length === 0) {
      throw new Error(
        `Client capture pairwise measurement '${measurement.id}' has no planned comparison owner.`,
      );
    }
    const primary = decodedViews.get(owner.id);
    if (primary === undefined) {
      throw new Error(
        `Client capture pairwise measurement '${measurement.id}' has no primary PNG.`,
      );
    }
    let changedPixels = 0;
    let comparedPixels = 0;
    for (const comparisonId of comparisonSceneIds) {
      const comparison = decodedViews.get(comparisonId);
      if (
        comparison?.width !== primary.width ||
        comparison.height !== primary.height ||
        comparison.data.length !== primary.data.length
      ) {
        throw new Error(
          `Client capture pairwise measurement '${measurement.id}' has incompatible PNG dimensions.`,
        );
      }
      for (let offset = 0; offset < primary.data.length; offset += 4) {
        if (
          primary.data[offset] !== comparison.data[offset] ||
          primary.data[offset + 1] !== comparison.data[offset + 1] ||
          primary.data[offset + 2] !== comparison.data[offset + 2] ||
          primary.data[offset + 3] !== comparison.data[offset + 3]
        ) {
          changedPixels++;
        }
      }
      comparedPixels += primary.width * primary.height;
    }
    const expectedValue =
      measurement.unit === 'percent'
        ? (changedPixels / comparedPixels) * 100
        : measurement.unit === 'ratio'
          ? changedPixels / comparedPixels
          : changedPixels;
    if (measurement.value === undefined || Math.abs(measurement.value - expectedValue) > 1e-9) {
      throw new Error(
        `Client capture pairwise measurement '${measurement.id}' does not match its hashed framebuffer pixels.`,
      );
    }
  }

  abortIfNeeded(options.signal);
  const log = requireArtifactBytes(
    await options.readArtifact(report.log.path, CLIENT_CAPTURE_LIMITS.maxLogBytes),
    `Client capture log '${report.log.path}'`,
    CLIENT_CAPTURE_LIMITS.maxLogBytes,
  );
  if (log.length !== report.log.bytes || sha256Buffer(log) !== report.log.sha256) {
    throw new Error('Client capture full log does not match its report metadata.');
  }
  let logText: string;
  try {
    logText = new TextDecoder('utf-8', { fatal: true }).decode(log);
  } catch {
    throw new Error('Client capture full log is not valid UTF-8.');
  }
  for (const excerpt of report.log.excerpts) {
    if (!logText.includes(excerpt)) {
      throw new Error('Client capture log excerpt is not present in the hashed full log.');
    }
  }

  return {
    plan,
    report,
    views: views.sort((left, right) => compareAscii(left.sceneId, right.sceneId)),
    log: {
      path: report.log.path,
      sha256: report.log.sha256,
      bytes: report.log.bytes,
      excerpts: report.log.excerpts,
    },
  };
}

async function createConfinedOutputReader(
  outputDirectory: string,
  signal: AbortSignal | undefined,
): Promise<ClientCaptureArtifactReader> {
  const rootInfo = await lstat(outputDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Client capture output must be a real directory, not a symbolic link.');
  }
  const canonicalRoot = await realpath(outputDirectory);
  const rootPrefix = `${canonicalRoot}${path.sep}`;

  return async (relativePath, maxBytes) => {
    abortIfNeeded(signal);
    const parsed = ClientCaptureArtifactPathSchema.parse(relativePath);
    const segments = parsed.split('/');
    let cursor = outputDirectory;
    for (const [index, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new Error(`Client capture artifact path '${parsed}' contains a symbolic link.`);
      }
      if (index < segments.length - 1 && !info.isDirectory()) {
        throw new Error(`Client capture artifact path '${parsed}' has a non-directory parent.`);
      }
      if (index === segments.length - 1 && !info.isFile()) {
        throw new Error(`Client capture artifact path '${parsed}' is not a regular file.`);
      }
    }
    const canonicalFile = await realpath(cursor);
    if (!canonicalFile.startsWith(rootPrefix)) {
      throw new Error(`Client capture artifact path '${parsed}' escapes its output directory.`);
    }
    const result = await readStableFile(cursor, {
      maxBytes,
      collect: true,
      signal,
      pathLabel: parsed,
    });
    if (result.data === undefined)
      throw new Error(`Client capture artifact '${parsed}' was not read.`);
    return result.data;
  };
}

/**
 * Verify a completed capture directory from its atomic completion sentinel down
 * to every framebuffer PNG and the complete Minecraft client log.
 */
export async function verifyClientCaptureOutput(
  input: VerifyClientCaptureOutputInput,
): Promise<ClientCaptureEvidence> {
  const plan = parseClientCapturePlan(input.plan);
  if (input.outputDirectory !== plan.execution.outputDirectory) {
    throw new Error('Client capture output directory does not match the launched plan.');
  }
  const completionPath = ClientCaptureArtifactPathSchema.parse(
    input.completionPath ?? 'capture-complete.json',
  );
  const readArtifact = await createConfinedOutputReader(input.outputDirectory, input.signal);
  const completionBytes = await readArtifact(
    completionPath,
    CLIENT_CAPTURE_LIMITS.maxSentinelBytes,
  );
  const sentinel = parseClientCaptureCompletionSentinelBytes(completionBytes, plan);
  if (sentinel.report.path === completionPath) {
    throw new Error('Client capture completion sentinel cannot also be the report artifact.');
  }
  const reportBytes = await readArtifact(
    sentinel.report.path,
    CLIENT_CAPTURE_LIMITS.maxReportBytes,
  );
  if (
    reportBytes.length !== sentinel.report.bytes ||
    sha256Buffer(reportBytes) !== sentinel.report.sha256
  ) {
    throw new Error('Client capture report does not match the completion sentinel.');
  }
  const report = parseClientCaptureReportBytes(reportBytes, plan);
  if (report.status === 'complete') {
    const reservedPaths = new Set([completionPath, sentinel.report.path]);
    if (
      reservedPaths.has(report.log.path) ||
      report.views.some((view) => reservedPaths.has(view.path))
    ) {
      throw new Error(
        'Client capture evidence cannot overwrite its report or completion sentinel.',
      );
    }
  }
  const verified = await verifyClientCaptureComplete(plan, report, {
    readArtifact,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return {
    ...verified,
    outputDirectory: input.outputDirectory,
    completion: {
      path: completionPath,
      sha256: sha256Buffer(completionBytes),
      bytes: completionBytes.length,
    },
    reportArtifact: {
      path: sentinel.report.path,
      sha256: sentinel.report.sha256,
      bytes: sentinel.report.bytes,
    },
  };
}
