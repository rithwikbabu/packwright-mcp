import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

import { z } from 'zod/v4';

import { sha256Buffer } from '../core/hash.js';
import { readStableFile } from '../core/stable-file.js';
import { decodePng } from '../visual/png.js';
import { canonicalJsonBytes } from '../visual/run-store.js';

export const CLIENT_CAPTURE_PROTOCOL_VERSION = 2 as const;
export const CLIENT_CAPTURE_MINECRAFT_VERSION = '26.2' as const;

export const CLIENT_CAPTURE_LIMITS = Object.freeze({
  maxScenes: 32,
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

export const ClientCaptureSceneSchema = z
  .object({
    id: SafeIdSchema,
    baseSceneId: SafeIdSchema,
    viewKind: z.enum(['minecraft_vanilla', 'first_person_vanilla', 'first_person_scale_reference']),
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
    if (isFirstPersonWorld && !isVanillaFirstPerson && !isScaleReference) {
      context.addIssue({
        code: 'custom',
        path: ['viewKind'],
        message:
          'First-person world captures must be explicitly classified as vanilla gameplay or a scale reference',
      });
    }
    if (!isFirstPersonWorld && scene.viewKind !== 'minecraft_vanilla') {
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
          : scene.baseSceneId;
    if (scene.id !== expectedId) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'Capture scene id does not match its hash-bound view kind and base scene id',
      });
    }
    if (scene.requiredForAuthority === isScaleReference) {
      context.addIssue({
        code: 'custom',
        path: ['requiredForAuthority'],
        message:
          'Vanilla Minecraft views are required for authority and scale-reference views are supplemental',
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
    runtimeManifestSha256: Sha256Schema,
    itemStack: ClientCaptureItemStackSchema,
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
  .strict();

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
  const scaleReferences: (typeof scenes)[number][] = [];
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
    } else if (scene.viewKind === 'first_person_scale_reference') {
      scaleReferences.push(scene);
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
        camera: value.camera,
        context: value.context,
        hand: value.hand,
        playerModel: value.playerModel,
        fov: value.fov,
        resolution: value.resolution,
        guiScale: value.guiScale,
        animationState: value.animationState,
        frame: value.frame,
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
}

const ClientCapturePlanBodySchema = z
  .object({
    schemaVersion: z.literal(CLIENT_CAPTURE_PROTOCOL_VERSION),
    kind: z.literal('packwright.client-capture-plan'),
    minecraftVersion: z.literal(CLIENT_CAPTURE_MINECRAFT_VERSION),
    provenance: ClientCaptureProvenanceSchema,
    scenes: z.array(ClientCaptureSceneSchema).min(1).max(CLIENT_CAPTURE_LIMITS.maxScenes),
    execution: ClientCaptureExecutionSchema,
  })
  .strict()
  .superRefine(({ scenes }, context) => addUniqueSortedSceneChecks(scenes, context));

export const ClientCapturePlanSchema = z
  .object({
    schemaVersion: z.literal(CLIENT_CAPTURE_PROTOCOL_VERSION),
    kind: z.literal('packwright.client-capture-plan'),
    minecraftVersion: z.literal(CLIENT_CAPTURE_MINECRAFT_VERSION),
    provenance: ClientCaptureProvenanceSchema,
    scenes: z.array(ClientCaptureSceneSchema).min(1).max(CLIENT_CAPTURE_LIMITS.maxScenes),
    execution: ClientCaptureExecutionSchema,
    planSha256: Sha256Schema,
  })
  .strict()
  .superRefine(({ scenes }, context) => addUniqueSortedSceneChecks(scenes, context));

export type ClientCaptureScene = z.infer<typeof ClientCaptureSceneSchema>;
export type ClientCaptureViewKind = ClientCaptureScene['viewKind'];
export type ClientCaptureViewAuthority =
  'authoritative_environment_capture' | 'augmented_qa_reference';

export function clientCaptureViewAuthority(
  scene: Pick<ClientCaptureScene, 'viewKind'>,
): ClientCaptureViewAuthority {
  return scene.viewKind === 'first_person_scale_reference'
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
    runtimeManifestSha256: Sha256Schema,
    itemStackSha256: Sha256Schema,
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
    runtimeManifestSha256: provenance.runtimeManifestSha256,
    itemStackSha256: sha256Buffer(canonicalJsonBytes(provenance.itemStack)),
    clientJarSha1: provenance.client.jarSha1,
    clientJarSha256: provenance.client.jarSha256,
    captureModId: provenance.captureMod.id,
    captureModVersion: provenance.captureMod.version,
    captureModSha256: provenance.captureMod.sha256,
  });
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
  })
  .strict();

const ClientCaptureLogSchema = z
  .object({
    path: ClientCaptureArtifactPathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().positive().max(CLIENT_CAPTURE_LIMITS.maxLogBytes),
    resourceReloadSucceeded: z.literal(true),
    excerpts: z.array(z.string().min(1).max(2048)).min(1).max(16),
  })
  .strict();

export const ClientCaptureRuntimeSchema = z
  .object({
    rendererBackend: z.enum(['opengl', 'vulkan']),
    operatingSystem: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    javaVersion: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    gpuVendor: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    gpuRenderer: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
    driverVersion: z.string().min(1).max(MAX_RUNTIME_FIELD_LENGTH),
  })
  .strict();

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
    views: z.array(ClientCaptureViewSchema).min(1).max(CLIENT_CAPTURE_LIMITS.maxScenes),
    log: ClientCaptureLogSchema,
  })
  .strict()
  .superRefine(({ views, log }, context) => {
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

export function parseClientCaptureReport(value: unknown, planValue: unknown): ClientCaptureReport {
  const plan = parseClientCapturePlan(planValue);
  const report = ClientCaptureReportSchema.parse(value);
  assertReportIdentity(plan, report);
  if (report.status === 'complete') assertCompleteViews(plan, report);
  return report;
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
    planned.delete(view.sceneId);
  }
  if (planned.size > 0) {
    throw new Error(
      `Client capture report is missing planned scenes: ${[...planned.keys()].sort().join(', ')}.`,
    );
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
