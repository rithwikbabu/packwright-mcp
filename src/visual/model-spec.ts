import { z } from 'zod';
import { isValidResourceId } from '../core/identifiers.js';
import { validateItemProperty, validateSelectValues } from './item-properties.js';

export const MODEL_SPEC_SCHEMA_VERSION = 1 as const;
export const MAX_MODEL_PARTS = 512;

const RESOURCE_ID_MESSAGE = 'Expected a namespaced Minecraft resource identifier.';
const PART_ID_PATTERN = /^[a-z][a-z0-9_.-]*$/u;
const MATERIAL_ID_PATTERN = /^[a-z][a-z0-9_.-]*$/u;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u;

export const ResourceIdSchema = z.string().max(256).refine(isValidResourceId, RESOURCE_ID_MESSAGE);

export const PartIdSchema = z.string().min(1).max(64).regex(PART_ID_PATTERN);
export const MaterialIdSchema = z.string().min(1).max(64).regex(MATERIAL_ID_PATTERN);

// Minecraft 26.2 generated model elements are confined to this model-space range.
const coordinate = z.number().min(-16).max(32);
const textureDimension = z.number().int().min(8).max(4096);

export const Vector3Schema = z.tuple([coordinate, coordinate, coordinate]);
export const TextureSizeSchema = z.tuple([textureDimension, textureDimension]);

const directionCoordinate = z.number().min(-1).max(1);
export const DirectionVectorSchema = z
  .tuple([directionCoordinate, directionCoordinate, directionCoordinate])
  .superRefine((value, context) => {
    const length = Math.hypot(...value);
    if (length < 1e-6) {
      context.addIssue({
        code: 'custom',
        message: 'A direction vector must not be zero.',
      });
    }
  });

export const ElementRotationSchema = z
  .object({
    axis: z.enum(['x', 'y', 'z']),
    angle: z.union([
      z.literal(-45),
      z.literal(-22.5),
      z.literal(0),
      z.literal(22.5),
      z.literal(45),
    ]),
    pivot: Vector3Schema,
    rescale: z.boolean().default(false),
  })
  .strict();

const uvCoordinate = z.number().min(0).max(16);

export const FaceUvSchema = z
  .object({
    uv: z.tuple([uvCoordinate, uvCoordinate, uvCoordinate, uvCoordinate]),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  })
  .strict();

export const FaceUvMapSchema = z
  .object({
    down: FaceUvSchema.optional(),
    up: FaceUvSchema.optional(),
    north: FaceUvSchema.optional(),
    south: FaceUvSchema.optional(),
    west: FaceUvSchema.optional(),
    east: FaceUvSchema.optional(),
  })
  .strict();

const PartBaseShape = {
  id: PartIdSchema,
  from: Vector3Schema,
  to: Vector3Schema,
  material: MaterialIdSchema,
  /** Semantic hierarchy for review/repair; part coordinates remain in model space. */
  parent: PartIdSchema.optional(),
  rotation: ElementRotationSchema.optional(),
  uvMode: z.enum(['box', 'manual']).default('box'),
  faces: FaceUvMapSchema.optional(),
  shade: z.boolean().default(true),
} as const;

export const CuboidPartSchema = z
  .object({
    ...PartBaseShape,
    shape: z.literal('cuboid'),
  })
  .strict()
  .superRefine((part, context) => {
    for (const axis of [0, 1, 2] as const) {
      if (part.to[axis] <= part.from[axis]) {
        context.addIssue({
          code: 'custom',
          message: 'Cuboid bounds must have positive size on every axis.',
          path: ['to', axis],
        });
      }
    }
    validateManualFaces(part, context);
  });

export const PlanePartSchema = z
  .object({
    ...PartBaseShape,
    shape: z.literal('plane'),
  })
  .strict()
  .superRefine((part, context) => {
    let flatAxes = 0;
    for (const axis of [0, 1, 2] as const) {
      if (part.to[axis] < part.from[axis]) {
        context.addIssue({
          code: 'custom',
          message: 'Plane bounds cannot be inverted.',
          path: ['to', axis],
        });
      }
      if (part.to[axis] === part.from[axis]) flatAxes += 1;
    }
    if (flatAxes !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'A plane must have exactly one zero-sized axis.',
        path: ['to'],
      });
    } else if (part.uvMode === 'manual' && part.faces !== undefined) {
      const allowed =
        part.from[0] === part.to[0]
          ? new Set(['west', 'east'])
          : part.from[1] === part.to[1]
            ? new Set(['down', 'up'])
            : new Set(['north', 'south']);
      for (const face of Object.keys(part.faces)) {
        if (!allowed.has(face)) {
          context.addIssue({
            code: 'custom',
            message: `Face '${face}' is not coplanar with this plane.`,
            path: ['faces', face],
          });
        }
      }
    }
    validateManualFaces(part, context);
  });

export const ModelPartSchema = z.union([CuboidPartSchema, PlanePartSchema]);

export const MaterialSpecSchema = z
  .object({
    /** A namespaced texture identifier. Omit to use the asset's generated texture path. */
    texture: ResourceIdSchema.optional(),
    tintIndex: z.number().int().min(0).max(255).optional(),
    color: z.string().regex(HEX_COLOR_PATTERN).optional(),
    emissive: z.boolean().default(false),
    transparent: z.boolean().default(false),
  })
  .strict();

const DisplayVectorSchema = z.tuple([
  z.number().min(-360).max(360),
  z.number().min(-360).max(360),
  z.number().min(-360).max(360),
]);
const DisplayTranslationSchema = z.tuple([
  z.number().min(-80).max(80),
  z.number().min(-80).max(80),
  z.number().min(-80).max(80),
]);
const DisplayScaleSchema = z.tuple([
  z.number().min(0).max(4),
  z.number().min(0).max(4),
  z.number().min(0).max(4),
]);

export const DisplayTransformSchema = z
  .object({
    rotation: DisplayVectorSchema.default([0, 0, 0]),
    translation: DisplayTranslationSchema.default([0, 0, 0]),
    scale: DisplayScaleSchema.default([1, 1, 1]),
  })
  .strict();

export const DISPLAY_CONTEXTS = [
  'thirdperson_righthand',
  'thirdperson_lefthand',
  'firstperson_righthand',
  'firstperson_lefthand',
  'gui',
  'head',
  'ground',
  'fixed',
] as const;

export const DisplayOverridesSchema = z
  .object({
    thirdperson_righthand: DisplayTransformSchema.optional(),
    thirdperson_lefthand: DisplayTransformSchema.optional(),
    firstperson_righthand: DisplayTransformSchema.optional(),
    firstperson_lefthand: DisplayTransformSchema.optional(),
    gui: DisplayTransformSchema.optional(),
    head: DisplayTransformSchema.optional(),
    ground: DisplayTransformSchema.optional(),
    fixed: DisplayTransformSchema.optional(),
  })
  .strict();

const StateBase = {
  id: PartIdSchema,
  model: ResourceIdSchema,
} as const;

const ItemPropertyParametersSchema = z
  .record(
    z.string().regex(/^[a-z_][a-z0-9_]*$/u),
    z.union([z.string().max(256), z.number(), z.boolean()]),
  )
  .default({});

export const ConditionStateSchema = z
  .object({
    ...StateBase,
    kind: z.literal('condition'),
    property: ResourceIdSchema,
    when: z.boolean().default(true),
    parameters: ItemPropertyParametersSchema,
  })
  .strict()
  .superRefine((state, context) => {
    for (const message of validateItemProperty('condition', state.property, state.parameters)) {
      context.addIssue({ code: 'custom', message, path: ['property'] });
    }
  });

export const SelectStateSchema = z
  .object({
    id: PartIdSchema,
    kind: z.literal('select'),
    property: ResourceIdSchema,
    parameters: ItemPropertyParametersSchema,
    cases: z
      .array(
        z
          .object({
            when: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
            model: ResourceIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict()
  .superRefine((state, context) => {
    for (const message of validateItemProperty('select', state.property, state.parameters)) {
      context.addIssue({ code: 'custom', message, path: ['property'] });
    }
    const values = new Set<string>();
    for (const [caseIndex, entry] of state.cases.entries()) {
      const matches = typeof entry.when === 'string' ? [entry.when] : entry.when;
      for (const [matchIndex, match] of matches.entries()) {
        if (values.has(match)) {
          context.addIssue({
            code: 'custom',
            message: `Select value '${match}' is handled more than once.`,
            path: ['cases', caseIndex, 'when', matchIndex],
          });
        }
        values.add(match);
        for (const message of validateSelectValues(state.property, [match])) {
          context.addIssue({
            code: 'custom',
            message,
            path: ['cases', caseIndex, 'when', matchIndex],
          });
        }
      }
    }
  });

export const RangeDispatchStateSchema = z
  .object({
    id: PartIdSchema,
    kind: z.literal('range_dispatch'),
    property: ResourceIdSchema,
    parameters: ItemPropertyParametersSchema,
    scale: z.number().positive().max(1_000_000).default(1),
    entries: z
      .array(
        z
          .object({
            threshold: z.number(),
            model: ResourceIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict()
  .superRefine((state, context) => {
    for (const message of validateItemProperty(
      'range_dispatch',
      state.property,
      state.parameters,
    )) {
      context.addIssue({ code: 'custom', message, path: ['property'] });
    }
    const thresholds = new Set<number>();
    for (const [index, entry] of state.entries.entries()) {
      if (thresholds.has(entry.threshold)) {
        context.addIssue({
          code: 'custom',
          message: 'Range-dispatch thresholds must be unique.',
          path: ['entries', index, 'threshold'],
        });
      }
      thresholds.add(entry.threshold);
    }
  });

export const CompositeStateSchema = z
  .object({
    id: PartIdSchema,
    kind: z.literal('composite'),
    models: z.array(ResourceIdSchema).min(1).max(64),
  })
  .strict()
  .superRefine((state, context) => {
    const models = new Set<string>();
    for (const [index, model] of state.models.entries()) {
      if (models.has(model)) {
        context.addIssue({
          code: 'custom',
          message: `Composite model '${model}' is duplicated.`,
          path: ['models', index],
        });
      }
      models.add(model);
    }
  });

export const ItemStateSchema = z.union([
  ConditionStateSchema,
  SelectStateSchema,
  RangeDispatchStateSchema,
  CompositeStateSchema,
]);

export const ItemConnectionIntentSchema = z
  .object({
    strategy: z.literal('minecraft:item_model').default('minecraft:item_model'),
    carrierItem: ResourceIdSchema,
  })
  .strict();

export const HELD_ITEM_USE_POSES = [
  'none',
  'swing',
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
] as const;

export const HeldItemReviewSchema = z
  .object({
    /** Model-space point that should sit in the player's palm. */
    primaryGrip: Vector3Schema.default([8, 5.5, 11]),
    /** Optional model-space point for the offhand in a two-handed pose. */
    secondaryGrip: Vector3Schema.optional(),
    /** Optional model-space origin used by directional/aiming items. */
    muzzle: Vector3Schema.optional(),
    /** Model-space direction that should point away from the player. */
    forwardAxis: DirectionVectorSchema.optional(),
    handedness: z.enum(['right', 'left', 'either']).default('either'),
    twoHanded: z.boolean().default(false),
    itemKind: z
      .enum(['generic', 'weapon', 'tool', 'bow', 'shield', 'horn', 'food', 'spyglass'])
      .default('generic'),
    usePose: z.enum(HELD_ITEM_USE_POSES).default('none'),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.twoHanded && value.secondaryGrip === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A two-handed item must declare secondaryGrip.',
        path: ['secondaryGrip'],
      });
    }
    if (
      value.secondaryGrip?.every((coordinate, index) => coordinate === value.primaryGrip[index]) ===
      true
    ) {
      context.addIssue({
        code: 'custom',
        message: 'secondaryGrip must differ from primaryGrip.',
        path: ['secondaryGrip'],
      });
    }
    if (
      value.muzzle?.every((coordinate, index) => coordinate === value.primaryGrip[index]) === true
    ) {
      context.addIssue({
        code: 'custom',
        message: 'muzzle must differ from primaryGrip so it defines a usable forward direction.',
        path: ['muzzle'],
      });
    }
    if (value.usePose === 'aim' && value.forwardAxis === undefined && value.muzzle === undefined) {
      context.addIssue({
        code: 'custom',
        message: "The 'aim' use pose requires forwardAxis or muzzle.",
        path: ['usePose'],
      });
    }
  });

export const ModelSpecSchema = z
  .object({
    schemaVersion: z.literal(MODEL_SPEC_SCHEMA_VERSION).default(MODEL_SPEC_SCHEMA_VERSION),
    id: ResourceIdSchema,
    targetKind: z.literal('item'),
    template: z.enum(['flat', 'handheld', 'handheld_3d']).default('handheld_3d'),
    textureSize: TextureSizeSchema.default([16, 16]),
    materials: z.record(MaterialIdSchema, MaterialSpecSchema).default({}),
    parts: z.array(ModelPartSchema).min(1).max(MAX_MODEL_PARTS),
    displayPreset: z.enum(['generated', 'handheld', 'handheld_3d']).default('handheld_3d'),
    display: DisplayOverridesSchema.default({}),
    states: z.array(ItemStateSchema).max(128).default([]),
    connection: ItemConnectionIntentSchema.optional(),
    reviewProfile: z.literal('held_item').default('held_item'),
    heldItem: HeldItemReviewSchema.optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    const partIds = new Map<string, number>();
    for (const [index, part] of spec.parts.entries()) {
      const previous = partIds.get(part.id);
      if (previous !== undefined) {
        context.addIssue({
          code: 'custom',
          message: `Part ID '${part.id}' is duplicated (first declared at index ${String(previous)}).`,
          path: ['parts', index, 'id'],
        });
      } else {
        partIds.set(part.id, index);
      }
    }

    for (const [index, part] of spec.parts.entries()) {
      if (part.parent !== undefined && !partIds.has(part.parent)) {
        context.addIssue({
          code: 'custom',
          message: `Parent part '${part.parent}' does not exist.`,
          path: ['parts', index, 'parent'],
        });
      }
    }

    const parents = new Map(spec.parts.map((part) => [part.id, part.parent] as const));
    for (const [index, part] of spec.parts.entries()) {
      const seen = new Set<string>([part.id]);
      let cursor = part.parent;
      while (cursor !== undefined) {
        if (seen.has(cursor)) {
          context.addIssue({
            code: 'custom',
            message: `Part parent cycle includes '${cursor}'.`,
            path: ['parts', index, 'parent'],
          });
          break;
        }
        seen.add(cursor);
        cursor = parents.get(cursor);
      }
    }

    const stateIds = new Set<string>();
    for (const [index, state] of spec.states.entries()) {
      if (stateIds.has(state.id)) {
        context.addIssue({
          code: 'custom',
          message: `State ID '${state.id}' is duplicated.`,
          path: ['states', index, 'id'],
        });
      }
      stateIds.add(state.id);
    }
  });

interface ManualFacePart {
  readonly uvMode: 'box' | 'manual';
  readonly faces?: z.infer<typeof FaceUvMapSchema> | undefined;
}

function validateManualFaces(part: ManualFacePart, context: z.RefinementCtx): void {
  if (
    part.uvMode === 'manual' &&
    (part.faces === undefined || Object.values(part.faces).every((face) => face === undefined))
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Manual UV mode requires at least one face mapping.',
      path: ['faces'],
    });
  }
  if (part.uvMode === 'box' && part.faces !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Face mappings are only allowed when uvMode is manual.',
      path: ['faces'],
    });
  }
}

export type Vector3 = z.infer<typeof Vector3Schema>;
export type ElementRotation = z.infer<typeof ElementRotationSchema>;
export type FaceUv = z.infer<typeof FaceUvSchema>;
export type FaceUvMap = z.infer<typeof FaceUvMapSchema>;
export type ModelPart = z.infer<typeof ModelPartSchema>;
export type MaterialSpec = z.infer<typeof MaterialSpecSchema>;
export type DisplayTransform = z.infer<typeof DisplayTransformSchema>;
export type DisplayContext = (typeof DISPLAY_CONTEXTS)[number];
export type ItemState = z.infer<typeof ItemStateSchema>;
export type ItemConnectionIntent = z.infer<typeof ItemConnectionIntentSchema>;
export type HeldItemReview = z.infer<typeof HeldItemReviewSchema>;
export type HeldItemUsePose = (typeof HELD_ITEM_USE_POSES)[number];
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

export function parseModelSpec(input: unknown): ModelSpec {
  return ModelSpecSchema.parse(input);
}

export function safeParseModelSpec(input: unknown): z.ZodSafeParseResult<ModelSpec> {
  return ModelSpecSchema.safeParse(input);
}
