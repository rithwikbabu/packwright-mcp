import { z } from 'zod/v4';

import { MAX_MCP_PAYLOAD_BYTES } from '../core/limits.js';
import {
  ClientCaptureMeasurementSchema,
  ClientCaptureRepresentationSchema,
  ClientCaptureRuntimeSchema,
} from '../minecraft/client-capture-protocol.js';
import { VISUAL_TARGETS } from '../visual/capabilities.js';
import {
  ArmorReviewSchema,
  BlockReviewSchema,
  DISPLAY_CONTEXTS,
  DirectionVectorSchema,
  DisplayTransformSchema,
  ElementRotationSchema,
  EntityModelReviewSchema,
  GuiItemReviewSchema,
  HELD_ITEM_USE_POSES,
  HeadWearableReviewSchema,
  MaterialSpecSchema,
  ModelSpecSchema,
  PlaceableReviewSchema,
  ProjectileReviewSchema,
  REVIEW_PROFILE_IDS,
  Vector3Schema,
} from '../visual/model-spec.js';
import {
  REVIEW_MEASUREMENT_IDS,
  REVIEW_MEASUREMENT_UNITS,
  REVIEW_SCENE_CATEGORIES,
} from '../visual/review-profile.js';
import {
  DiagnosticSchema,
  MinecraftVersionSchema,
  RelativePathSchema,
  ResourceIdSchema,
  Sha256Schema,
} from './schemas.js';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const CONTENT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function fitsMcpPayload(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MCP_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

const MCP_PAYLOAD_LIMIT_MESSAGE = `Request exceeds the ${MAX_MCP_PAYLOAD_BYTES.toString()}-byte MCP payload limit`;

export const VisualProjectIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    PROJECT_ID_PATTERN,
    'Project ID must start with a lowercase letter or digit and use only lowercase letters, digits, dashes, or underscores',
  );

export const VisualDraftIdSchema = z
  .string()
  .length(64)
  .regex(CONTENT_ID_PATTERN, 'Run and revision IDs must be lowercase SHA-256 content IDs');

export const VisualTargetSchema = z.enum(VISUAL_TARGETS);
export const VisualCapabilityStatusSchema = z.enum([
  'native',
  'simulated',
  'replacement',
  'requires_mod',
]);

export const VisualCapabilitySchema = z.strictObject({
  target: VisualTargetSchema,
  status: VisualCapabilityStatusSchema,
  support: z.enum(['full', 'limited', 'unsupported']),
  compilerSupport: z.enum(['full', 'limited', 'unsupported']),
  strategies: z.array(z.string().min(1)),
  nativeIdentity: z.boolean(),
  disclosure: z.string().optional(),
  limitation: z.string().optional(),
});

export const VisualProjectManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: VisualProjectIdSchema,
  minecraftVersion: MinecraftVersionSchema,
  datapack: RelativePathSchema,
  resourcepack: RelativePathSchema,
  target: z.literal('vanilla'),
});

export const VisualFileSchema = z.strictObject({
  path: RelativePathSchema,
  sha256: Sha256Schema,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  role: z.enum([
    'manifest',
    'model_spec',
    'item_definition',
    'item_model',
    'texture',
    'binding',
    'render',
    'pack_metadata',
    'other',
  ]),
});

export const VisualCapabilitiesInputSchema = z
  .strictObject({
    minecraftVersion: MinecraftVersionSchema.default('26.2'),
    target: VisualTargetSchema.optional(),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualCapabilitiesResultSchema = z.strictObject({
  ok: z.boolean(),
  minecraftVersion: MinecraftVersionSchema,
  resourcePackFormat: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  capabilities: z.array(VisualCapabilitySchema),
  reviewProfiles: z.array(
    z.strictObject({
      id: z.enum(REVIEW_PROFILE_IDS),
      version: z.number().int().positive(),
      targetKind: z.literal('item'),
      support: z.literal('full'),
      clientCaptureSupport: z.enum(['full', 'limited', 'unsupported']),
      clientCaptureTargetKind: z
        .enum(['held_item', 'gui_item', 'block', 'headwear', 'entity', 'placeable'])
        .optional(),
      clientCaptureStrategies: z.array(z.string().min(1).max(64)),
      clientCaptureLimitation: z.string().min(1).max(4096).optional(),
      clientCaptureDisclosure: z.string().min(1).max(4096).optional(),
    }),
  ),
});

export const VisualProjectAttachInputSchema = z
  .strictObject({
    id: VisualProjectIdSchema,
    datapack: RelativePathSchema,
    resourcepack: RelativePathSchema,
    minecraftVersion: MinecraftVersionSchema.default('26.2'),
    description: z.string().min(1).max(4096).default('Packwright resource pack'),
    createResourcepack: z.boolean().default(true),
    expectedManifestSha256: Sha256Schema.optional(),
    dryRun: z.boolean().default(false),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualProjectAttachResultSchema = z.strictObject({
  ok: z.boolean(),
  operation: z.literal('visual_project_attach'),
  changed: z.boolean(),
  dryRun: z.boolean(),
  project: VisualProjectManifestSchema,
  manifestPath: RelativePathSchema,
  manifestSha256: Sha256Schema,
  resourcepackCreated: z.boolean(),
  files: z.array(VisualFileSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export const VisualAssetInspectInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    assetId: ResourceIdSchema.optional(),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualAssetNodeSchema = z.strictObject({
  id: z.string().min(1).max(512),
  kind: z.enum([
    'logical_item',
    'carrier_item',
    'item_component',
    'item_definition',
    'model',
    'texture',
  ]),
  path: RelativePathSchema.optional(),
  sha256: Sha256Schema.optional(),
});

export const VisualAssetEdgeSchema = z.strictObject({
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
  relation: z.enum([
    'implemented_by',
    'uses_component',
    'resolves_to',
    'selects_model',
    'inherits_model',
    'uses_texture',
  ]),
});

export const VisualAssetInspectResultSchema = z.strictObject({
  ok: z.boolean(),
  project: VisualProjectManifestSchema,
  nodes: z.array(VisualAssetNodeSchema),
  edges: z.array(VisualAssetEdgeSchema),
  latestRunId: VisualDraftIdSchema.optional(),
  readiness: z.strictObject({
    spec: z.boolean(),
    textures: z.boolean(),
    compiled: z.boolean(),
    rendered: z.boolean(),
    reviewProfile: z.boolean(),
    binding: z.boolean(),
    committed: z.boolean(),
    clientCaptured: z.boolean(),
  }),
  diagnostics: z.array(DiagnosticSchema),
  truncated: z.boolean(),
});

export const VisualProvenanceSchema = z.strictObject({
  provider: z.string().min(1).max(128).default('agent-driven'),
  model: z.string().min(1).max(256).optional(),
  prompt: z
    .string()
    .max(32 * 1024)
    .optional(),
  seed: z.union([z.string().max(256), z.number()]).optional(),
  referenceSha256: z.array(Sha256Schema).max(64).default([]),
});

export const VisualSpecUpsertInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    request: z
      .string()
      .min(1)
      .max(32 * 1024),
    spec: ModelSpecSchema,
    provenance: VisualProvenanceSchema.default({ provider: 'agent-driven', referenceSha256: [] }),
    parentRunId: VisualDraftIdSchema.optional(),
    expectedSpecSha256: Sha256Schema.optional(),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualDraftResultSchema = z.strictObject({
  ok: z.boolean(),
  operation: z.enum([
    'visual_spec_upsert',
    'texture_import',
    'visual_compile',
    'visual_connect',
    'visual_revision_create',
  ]),
  projectId: VisualProjectIdSchema,
  runId: VisualDraftIdSchema,
  revisionId: VisualDraftIdSchema,
  parentRevisionId: VisualDraftIdSchema.optional(),
  specSha256: Sha256Schema,
  proposalSha256: Sha256Schema.optional(),
  files: z.array(VisualFileSchema),
  diagnostics: z.array(DiagnosticSchema),
});

const PngBase64Schema = z
  .string()
  .min(4)
  .regex(BASE64_PATTERN, 'PNG data must be canonical base64')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_MCP_PAYLOAD_BYTES - 16 * 1024,
    'Encoded PNG exceeds the MCP request budget',
  );

export const TextureImportInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema.optional(),
    material: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_.-]*$/u),
    source: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('png_base64'), data: PngBase64Schema }),
      z.strictObject({
        kind: z.literal('workspace_file'),
        path: RelativePathSchema,
        expectedSha256: Sha256Schema,
      }),
    ]),
    stripMetadata: z.literal(true).default(true),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualCompileInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema.optional(),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualConnectInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema.optional(),
    carrierItem: ResourceIdSchema,
    generateGiveFunction: z.boolean().default(true),
    generateRecipe: z.boolean().default(false),
    recipe: z
      .strictObject({
        pattern: z.array(z.string().min(1).max(3)).min(1).max(3),
        key: z.record(z.string().length(1), ResourceIdSchema),
        count: z.number().int().min(1).max(99).default(1),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (value.generateRecipe && value.recipe === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['recipe'],
        message: 'recipe is required when generateRecipe is true',
      });
    }
    if (value.recipe === undefined) return;

    const width = value.recipe.pattern[0]?.length;
    value.recipe.pattern.forEach((row, index) => {
      if (width !== undefined && row.length !== width) {
        context.addIssue({
          code: 'custom',
          path: ['recipe', 'pattern', index],
          message: 'Every shaped recipe row must have the same width',
        });
      }
    });

    const usedSymbols = new Set<string>();
    for (const row of value.recipe.pattern) {
      for (const symbol of row) {
        if (symbol !== ' ') usedSymbols.add(symbol);
      }
    }
    if (usedSymbols.size === 0) {
      context.addIssue({
        code: 'custom',
        path: ['recipe', 'pattern'],
        message: 'A shaped recipe must use at least one non-space symbol',
      });
    }
    if (Object.hasOwn(value.recipe.key, ' ')) {
      context.addIssue({
        code: 'custom',
        path: ['recipe', 'key', ' '],
        message: 'A space is reserved for empty recipe slots and cannot be a key symbol',
      });
    }
    for (const symbol of usedSymbols) {
      if (!Object.hasOwn(value.recipe.key, symbol)) {
        context.addIssue({
          code: 'custom',
          path: ['recipe', 'key', symbol],
          message: `Recipe pattern symbol '${symbol}' does not have a key entry`,
        });
      }
    }
    for (const symbol of Object.keys(value.recipe.key)) {
      if (symbol !== ' ' && !usedSymbols.has(symbol)) {
        context.addIssue({
          code: 'custom',
          path: ['recipe', 'key', symbol],
          message: `Recipe key symbol '${symbol}' is not used by the pattern`,
        });
      }
    }
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualRenderInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema.optional(),
    includeContexts: z
      .boolean()
      .default(true)
      .describe(
        'Compatibility flag for legacy renderer callers; scene-profile required views are never removed.',
      ),
    viewSize: z.number().int().min(32).max(256).default(128),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualRenderResultSchema = z.strictObject({
  ok: z.boolean(),
  projectId: VisualProjectIdSchema,
  runId: VisualDraftIdSchema,
  revisionId: VisualDraftIdSchema,
  reviewProfile: z.enum(REVIEW_PROFILE_IDS),
  profileVersion: z.number().int().positive(),
  reviewReady: z.boolean(),
  reportUri: z.url(),
  contactSheet: VisualFileSchema,
  contactSheetUri: z.url(),
  views: z.array(
    z.strictObject({
      name: z.string().min(1).max(128),
      required: z.boolean(),
      category: z.enum(REVIEW_SCENE_CATEGORIES),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      file: VisualFileSchema,
      uri: z.url(),
    }),
  ),
  measurements: z.array(
    z.strictObject({
      metric: z.enum(REVIEW_MEASUREMENT_IDS),
      view: z.string().min(1).max(64).optional(),
      status: z.enum(['passed', 'warning', 'failed', 'skipped']),
      value: z.number().optional(),
      threshold: z.number().optional(),
      unit: z.enum(REVIEW_MEASUREMENT_UNITS),
      message: z.string().min(1).max(4096),
      partId: z.string().min(1).max(64).optional(),
    }),
  ),
  pixelSha256: Sha256Schema,
  diagnostics: z.array(DiagnosticSchema),
});

export const VisualClientCaptureInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema.optional(),
    proposalSha256: Sha256Schema,
    confirm: z.literal(true),
    timeoutMs: z.number().int().min(30_000).max(600_000).default(300_000),
    resolution: z
      .strictObject({
        width: z.number().int().min(640).max(1920).default(1280),
        height: z.number().int().min(360).max(1080).default(720),
      })
      .default({ width: 1280, height: 720 }),
    guiScale: z.number().int().min(0).max(8).default(2),
    representation: ClientCaptureRepresentationSchema.optional().describe(
      'Exact declarative Minecraft representation to stage for block, headwear, entity, or placeable capture. It must match the selected review profile and is hash-bound into the protocol report.',
    ),
    includeScaleReferenceViews: z.boolean().default(false),
    includeDebugHitboxViews: z
      .boolean()
      .default(false)
      .describe(
        'Add separately classified F3+B-style hitbox inspection frames for supported entity/placeable representations. These frames are supplemental QA evidence and never satisfy authority.',
      ),
    displaySettlingTicks: z
      .number()
      .int()
      .min(2)
      .max(40)
      .optional()
      .describe(
        'Bounded post-spawn/update settling interval for display_rig or block_display representations. Omission uses two ticks; supplying it for another strategy is rejected.',
      ),
  })
  .superRefine((value, context) => {
    if (
      value.displaySettlingTicks !== undefined &&
      value.representation?.strategy !== 'display_rig' &&
      value.representation?.strategy !== 'block_display'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['displaySettlingTicks'],
        message:
          'displaySettlingTicks is valid only for a display_rig or block_display representation',
      });
    }
    if (
      value.includeDebugHitboxViews &&
      value.representation?.targetKind !== 'entity' &&
      value.representation?.targetKind !== 'placeable'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['includeDebugHitboxViews'],
        message: 'Debug hitbox views require an explicit entity or placeable representation',
      });
    }
    if (
      value.includeScaleReferenceViews &&
      value.representation !== undefined &&
      value.representation.targetKind !== 'held_item'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['includeScaleReferenceViews'],
        message: 'Injected scale-reference views are supported only for held-item capture',
      });
    }
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

const ClientCaptureTargetKindSchema = z.enum([
  'held_item',
  'gui_item',
  'block',
  'headwear',
  'entity',
  'placeable',
]);

const ClientCaptureViewKindSchema = z.enum([
  'minecraft_vanilla',
  'first_person_vanilla',
  'first_person_scale_reference',
  'debug_hitbox_reference',
  'comparison_reference',
  'world_scale_reference',
  'measurement_control',
]);

export const VisualClientCaptureResultSchema = z
  .strictObject({
    protocolVersion: z.literal(3),
    ok: z.boolean(),
    status: z.enum(['passed', 'failed', 'setup_required', 'cancelled', 'timeout']),
    authority: z.literal('authoritative_environment_capture'),
    authorityScope: z.literal('required_views_only'),
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema,
    reviewProfile: z.enum(REVIEW_PROFILE_IDS),
    profileVersion: z.number().int().positive(),
    targetKind: ClientCaptureTargetKindSchema.optional(),
    representationSha256: Sha256Schema.optional(),
    studioSha256: Sha256Schema.optional(),
    representationStrategy: z
      .enum([
        'item_stack',
        'native_block_state',
        'block_display',
        'equippable_head',
        'native_entity',
        'display_rig',
        'native_placeable_block',
        'native_placeable_entity',
      ])
      .optional(),
    representationCapability: z.enum(['native', 'replacement', 'simulated']).optional(),
    representationDisclosure: z.string().min(1).max(4096).optional(),
    proposalBindingStatus: z.enum(['implemented', 'capture_only']).optional(),
    proposalBindingReason: z.string().min(1).max(4096).optional(),
    clientCaptureSupport: z.enum(['full', 'limited', 'unsupported']),
    clientCaptureStrategies: z.array(z.string().min(1).max(64)),
    clientCaptureLimitation: z.string().min(1).max(4096).optional(),
    captureReady: z.boolean(),
    planSha256: Sha256Schema.optional(),
    reportSha256: Sha256Schema.optional(),
    reportUri: z.url().optional(),
    contactSheet: VisualFileSchema.optional(),
    contactSheetUri: z.url().optional(),
    supplementalContactSheet: VisualFileSchema.optional(),
    supplementalContactSheetUri: z.url().optional(),
    views: z.array(
      z.strictObject({
        name: z.string().min(1).max(128),
        baseSceneId: z.string().min(1).max(64),
        targetKind: ClientCaptureTargetKindSchema,
        representationSha256: Sha256Schema,
        viewKind: ClientCaptureViewKindSchema,
        authority: z.enum(['authoritative_environment_capture', 'augmented_qa_reference']),
        requiredForAuthority: z.boolean(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        sourceSha256: Sha256Schema,
        normalizedSha256: Sha256Schema,
        bytes: z.number().int().positive(),
        uri: z.url(),
      }),
    ),
    requiredViewIds: z.array(z.string().min(1).max(128)),
    supplementalViewIds: z.array(z.string().min(1).max(128)),
    environment: ClientCaptureRuntimeSchema.optional(),
    measurements: z.array(ClientCaptureMeasurementSchema),
    diagnostics: z.array(DiagnosticSchema),
  })
  .superRefine((value, context) => {
    const passed = value.status === 'passed';
    if (value.ok !== passed || value.captureReady !== passed) {
      context.addIssue({
        code: 'custom',
        path: ['captureReady'],
        message: 'Only a passed client capture can be ok and capture-ready',
      });
    }
    const requiredIds = new Set(value.requiredViewIds);
    const supplementalIds = new Set(value.supplementalViewIds);
    const viewIds = new Set(value.views.map((view) => view.name));

    if (requiredIds.size !== value.requiredViewIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['requiredViewIds'],
        message: 'Required client-capture view IDs must be unique',
      });
    }
    if (supplementalIds.size !== value.supplementalViewIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['supplementalViewIds'],
        message: 'Supplemental client-capture view IDs must be unique',
      });
    }
    if (viewIds.size !== value.views.length) {
      context.addIssue({
        code: 'custom',
        path: ['views'],
        message: 'Completed client-capture view names must be unique',
      });
    }

    for (const [index, view] of value.views.entries()) {
      const isAugmented =
        view.viewKind === 'first_person_scale_reference' ||
        view.viewKind === 'debug_hitbox_reference' ||
        view.viewKind === 'comparison_reference' ||
        view.viewKind === 'world_scale_reference' ||
        view.viewKind === 'measurement_control';
      const expectedAuthority = isAugmented
        ? 'augmented_qa_reference'
        : 'authoritative_environment_capture';
      const expectedRequired = !isAugmented;
      const inRequired = requiredIds.has(view.name);
      const inSupplemental = supplementalIds.has(view.name);

      if (value.targetKind === undefined || view.targetKind !== value.targetKind) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'targetKind'],
          message: 'View target kind does not match the capture result target kind',
        });
      }
      if (
        value.representationSha256 !== undefined &&
        view.representationSha256 !== value.representationSha256
      ) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'representationSha256'],
          message: 'View representation hash does not match the capture result',
        });
      }

      if (view.authority !== expectedAuthority) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'authority'],
          message: `View authority must be '${expectedAuthority}' for '${view.viewKind}'`,
        });
      }
      if (view.requiredForAuthority !== expectedRequired) {
        context.addIssue({
          code: 'custom',
          path: ['views', index, 'requiredForAuthority'],
          message: `'${view.viewKind}' requiredForAuthority must be ${String(expectedRequired)}`,
        });
      }
      if (inRequired === inSupplemental || inRequired !== expectedRequired) {
        context.addIssue({
          code: 'custom',
          path: [expectedRequired ? 'requiredViewIds' : 'supplementalViewIds'],
          message: `Completed view '${view.name}' is not classified in its only valid authority set`,
        });
      }
    }

    for (const [index, viewId] of value.requiredViewIds.entries()) {
      if (!viewIds.has(viewId)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredViewIds', index],
          message: `Required view '${viewId}' is not present in completed views`,
        });
      }
      if (supplementalIds.has(viewId)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredViewIds', index],
          message: `View '${viewId}' cannot be both required and supplemental`,
        });
      }
    }
    for (const [index, viewId] of value.supplementalViewIds.entries()) {
      if (!viewIds.has(viewId)) {
        context.addIssue({
          code: 'custom',
          path: ['supplementalViewIds', index],
          message: `Supplemental view '${viewId}' is not present in completed views`,
        });
      }
    }

    const hasSupplementalSheet = value.supplementalContactSheet !== undefined;
    const hasSupplementalSheetUri = value.supplementalContactSheetUri !== undefined;
    const expectsSupplementalSheet = value.supplementalViewIds.length > 0;
    if (
      hasSupplementalSheet !== hasSupplementalSheetUri ||
      hasSupplementalSheet !== expectsSupplementalSheet
    ) {
      context.addIssue({
        code: 'custom',
        path: ['supplementalContactSheet'],
        message:
          'Supplemental contact sheet and URI must both exist exactly when supplemental views exist',
      });
    }
    if (
      value.status === 'passed' &&
      (value.representationSha256 === undefined ||
        value.targetKind === undefined ||
        value.representationStrategy === undefined ||
        value.representationCapability === undefined ||
        value.proposalBindingStatus === undefined ||
        value.proposalBindingReason === undefined ||
        value.studioSha256 === undefined ||
        value.views.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['representationSha256'],
        message: 'A passed capture must bind a representation and at least one completed view',
      });
    }
    if (value.status === 'passed' && value.targetKind !== undefined) {
      const expectedProposalBindingStatus =
        value.targetKind === 'held_item' || value.targetKind === 'gui_item'
          ? 'implemented'
          : 'capture_only';
      if (value.proposalBindingStatus !== expectedProposalBindingStatus) {
        context.addIssue({
          code: 'custom',
          path: ['proposalBindingStatus'],
          message: `Target '${value.targetKind}' must report proposal binding '${expectedProposalBindingStatus}'`,
        });
      }
    }
  });

const PartRepairSchema = z.strictObject({
  kind: z.literal('part'),
  partId: z.string().min(1).max(64),
  from: Vector3Schema.optional(),
  to: Vector3Schema.optional(),
  rotation: ElementRotationSchema.nullable().optional(),
  material: z.string().min(1).max(64).optional(),
});

const MaterialRepairSchema = z.strictObject({
  kind: z.literal('material'),
  material: z.string().min(1).max(64),
  value: MaterialSpecSchema,
});

const DisplayRepairSchema = z.strictObject({
  kind: z.literal('display'),
  context: z.enum(DISPLAY_CONTEXTS),
  transform: DisplayTransformSchema,
});

const HeldItemRepairSchema = z
  .strictObject({
    kind: z.literal('held_item'),
    primaryGrip: Vector3Schema.optional(),
    secondaryGrip: Vector3Schema.nullable().optional(),
    muzzle: Vector3Schema.nullable().optional(),
    forwardAxis: DirectionVectorSchema.nullable().optional(),
    handedness: z.enum(['right', 'left', 'either']).optional(),
    twoHanded: z.boolean().optional(),
    itemKind: z
      .enum(['generic', 'weapon', 'tool', 'bow', 'shield', 'horn', 'food', 'spyglass'])
      .optional(),
    usePose: z.enum(HELD_ITEM_USE_POSES).optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'kind'),
    'A held-item repair must change at least one semantic field',
  );

const ProfileReviewRepairSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('block_review'), value: BlockReviewSchema }),
  z.strictObject({ kind: z.literal('placeable_review'), value: PlaceableReviewSchema }),
  z.strictObject({ kind: z.literal('armor_review'), value: ArmorReviewSchema }),
  z.strictObject({ kind: z.literal('head_wearable_review'), value: HeadWearableReviewSchema }),
  z.strictObject({ kind: z.literal('projectile_review'), value: ProjectileReviewSchema }),
  z.strictObject({ kind: z.literal('gui_item_review'), value: GuiItemReviewSchema }),
  z.strictObject({ kind: z.literal('entity_model_review'), value: EntityModelReviewSchema }),
]);

export const VisualRevisionCreateInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    parentRevisionId: VisualDraftIdSchema,
    expectedSpecSha256: Sha256Schema,
    instructions: z
      .string()
      .min(1)
      .max(16 * 1024),
    repairs: z
      .array(
        z.discriminatedUnion('kind', [
          PartRepairSchema,
          MaterialRepairSchema,
          DisplayRepairSchema,
          HeldItemRepairSchema,
          ...ProfileReviewRepairSchema.options,
        ]),
      )
      .min(1)
      .max(128),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualCommitInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema,
    revisionId: VisualDraftIdSchema.optional(),
    proposalSha256: Sha256Schema,
    expectedClientCaptureReportSha256: Sha256Schema.optional(),
    confirm: z.literal(true),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualCommitResultSchema = z.strictObject({
  ok: z.boolean(),
  operation: z.literal('visual_commit'),
  projectId: VisualProjectIdSchema,
  runId: VisualDraftIdSchema,
  revisionId: VisualDraftIdSchema,
  transactionId: z.string().min(1),
  clientCaptureReportSha256: Sha256Schema.optional(),
  files: z.array(VisualFileSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export const VisualValidateInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    runId: VisualDraftIdSchema.optional(),
    revisionId: VisualDraftIdSchema.optional(),
    includeVanilla: z.boolean().default(true),
    includeGameTests: z.boolean().default(false),
    requireClientCapture: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.revisionId !== undefined && value.runId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['runId'],
        message: 'runId is required when revisionId is supplied',
      });
    }
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const VisualValidateResultSchema = z.strictObject({
  ok: z.boolean(),
  projectId: VisualProjectIdSchema,
  runId: VisualDraftIdSchema.optional(),
  revisionId: VisualDraftIdSchema.optional(),
  layers: z.array(
    z.strictObject({
      name: z.enum([
        'metadata',
        'schema',
        'texture',
        'asset_graph',
        'geometry',
        'render',
        'review_profile',
        'client_capture',
        'binding',
        'vanilla_commands',
        'gametest',
      ]),
      status: z.enum(['passed', 'failed', 'skipped', 'setup_required']),
    }),
  ),
  diagnostics: z.array(DiagnosticSchema),
  truncated: z.boolean(),
});

export const ProjectBuildInputSchema = z
  .strictObject({
    projectId: VisualProjectIdSchema,
    outputDirectory: RelativePathSchema.optional(),
    overwrite: z.boolean().default(false),
    expectedDatapackSha256: Sha256Schema.nullable().optional(),
    expectedResourcepackSha256: Sha256Schema.nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.overwrite &&
      (value.expectedDatapackSha256 === undefined || value.expectedResourcepackSha256 === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['overwrite'],
        message:
          'Both expected ZIP preconditions (SHA-256 or null for absent) are required when overwrite is true',
      });
    }
    if (
      !value.overwrite &&
      (value.expectedDatapackSha256 !== undefined || value.expectedResourcepackSha256 !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['overwrite'],
        message: 'Expected ZIP hashes may only be supplied when overwrite is true',
      });
    }
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const ProjectBuildResultSchema = z.strictObject({
  ok: z.boolean(),
  projectId: VisualProjectIdSchema,
  datapack: z.strictObject({
    path: RelativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    entries: z.number().int().nonnegative(),
  }),
  resourcepack: z.strictObject({
    path: RelativePathSchema,
    size: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    entries: z.number().int().nonnegative(),
  }),
  diagnostics: z.array(DiagnosticSchema),
  truncated: z.boolean(),
});

export type VisualCapabilitiesInput = z.infer<typeof VisualCapabilitiesInputSchema>;
export type VisualCapabilitiesResult = z.infer<typeof VisualCapabilitiesResultSchema>;
export type VisualProjectAttachInput = z.infer<typeof VisualProjectAttachInputSchema>;
export type VisualProjectAttachResult = z.infer<typeof VisualProjectAttachResultSchema>;
export type VisualAssetInspectInput = z.infer<typeof VisualAssetInspectInputSchema>;
export type VisualAssetInspectResult = z.infer<typeof VisualAssetInspectResultSchema>;
export type VisualSpecUpsertInput = z.infer<typeof VisualSpecUpsertInputSchema>;
export type TextureImportInput = z.infer<typeof TextureImportInputSchema>;
export type VisualCompileInput = z.infer<typeof VisualCompileInputSchema>;
export type VisualConnectInput = z.infer<typeof VisualConnectInputSchema>;
export type VisualDraftResult = z.infer<typeof VisualDraftResultSchema>;
export type VisualRenderInput = z.infer<typeof VisualRenderInputSchema>;
export type VisualRenderResult = z.infer<typeof VisualRenderResultSchema>;
export type VisualClientCaptureInput = z.infer<typeof VisualClientCaptureInputSchema>;
export type VisualClientCaptureResult = z.infer<typeof VisualClientCaptureResultSchema>;
export type VisualRevisionCreateInput = z.infer<typeof VisualRevisionCreateInputSchema>;
export type VisualCommitInput = z.infer<typeof VisualCommitInputSchema>;
export type VisualCommitResult = z.infer<typeof VisualCommitResultSchema>;
export type VisualValidateInput = z.infer<typeof VisualValidateInputSchema>;
export type VisualValidateResult = z.infer<typeof VisualValidateResultSchema>;
export type ProjectBuildInput = z.infer<typeof ProjectBuildInputSchema>;
export type ProjectBuildResult = z.infer<typeof ProjectBuildResultSchema>;
