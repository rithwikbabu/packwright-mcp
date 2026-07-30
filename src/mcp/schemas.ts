import { z } from 'zod/v4';

import { isValidNamespace, isValidResourceId } from '../core/identifiers.js';
import { MAX_MCP_PAYLOAD_BYTES } from '../core/limits.js';
import { RESOURCE_TYPES } from '../core/version.js';

const NAMESPACE_PATTERN = /^[a-z0-9._-]+$/u;
const RESOURCE_ID_PATTERN =
  /^[a-z0-9._-]+:(?!(?:[^/]+\/)*\.{1,2}(?:\/|$))[a-z0-9._-]+(?:\/[a-z0-9._-]+)*$/u;
const SAFE_RELATIVE_PATH_PATTERN =
  // eslint-disable-next-line no-control-regex -- control characters are intentionally excluded from public paths
  /^(?!\/)(?![a-zA-Z]:)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[^\u0000-\u001F\u007F/]+(?:\/[^\u0000-\u001F\u007F/]+)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function isSafeRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    return false;
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return false;
    }
  }

  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function fitsMcpPayload(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MCP_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

const MCP_PAYLOAD_LIMIT_MESSAGE = `Request exceeds the ${MAX_MCP_PAYLOAD_BYTES.toString()}-byte MCP payload limit`;

export const MinecraftVersionSchema = z.literal('26.2');

export const RelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(
    SAFE_RELATIVE_PATH_PATTERN,
    'Path must be a normalized relative path without traversal or backslashes',
  )
  .refine(isSafeRelativePath, {
    message: 'Path must be a normalized relative path without encoded traversal',
  });

export const NamespaceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NAMESPACE_PATTERN, 'Invalid Minecraft namespace')
  .refine(isValidNamespace, 'Invalid Minecraft namespace');

export const ResourceIdSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(
    RESOURCE_ID_PATTERN,
    'Resource ID must be a fully qualified namespace:path identifier with normalized path segments',
  )
  .refine(
    isValidResourceId,
    'Resource ID must be a fully qualified namespace:path identifier with normalized path segments',
  );

export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);
export const AuthorableResourceTypeSchema = ResourceTypeSchema.exclude(['structure']);

export const AuthorableTextPathSchema = RelativePathSchema.refine(
  (value) =>
    value.endsWith('.json') ||
    value.endsWith('.mcfunction') ||
    value.endsWith('.mcmeta') ||
    value.endsWith('.snbt'),
  'Only JSON, MCFunction, MCMETA, and SNBT text files can be authored',
).regex(/\.(?:json|mcfunction|mcmeta|snbt)$/u, 'Path must use an authorable text extension');

export const Sha256Schema = z.string().regex(SHA256_PATTERN, 'Expected a lowercase SHA-256 digest');

export const SourcePositionSchema = z.strictObject({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
});

export const SourceRangeSchema = z.strictObject({
  start: SourcePositionSchema,
  end: SourcePositionSchema,
});

export const DiagnosticSchema = z.strictObject({
  engine: z.string().min(1),
  authority: z.enum(['structural', 'advisory', 'authoritative']),
  severity: z.enum(['error', 'warning', 'information', 'hint']),
  code: z.string(),
  message: z.string().min(1),
  path: RelativePathSchema.optional(),
  range: SourceRangeSchema.optional(),
  suggestedFix: z.string().optional(),
});

export const TextDiffSchema = z.strictObject({
  beforeSha256: Sha256Schema.optional(),
  afterSha256: Sha256Schema.optional(),
  unified: z.string(),
  truncated: z.boolean(),
});

export const OperationResultSchema = z.strictObject({
  ok: z.boolean(),
  operation: z.string().min(1),
  changed: z.boolean(),
  dryRun: z.boolean(),
  path: RelativePathSchema.optional(),
  sha256: Sha256Schema.optional(),
  previousSha256: Sha256Schema.optional(),
  diff: TextDiffSchema.optional(),
  value: z.json().optional(),
  diagnostics: z.array(DiagnosticSchema),
});

export const ResourceInventoryEntrySchema = z.strictObject({
  path: RelativePathSchema,
  size: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
});

export const ValidationResultSchema = z.strictObject({
  ok: z.boolean(),
  diagnostics: z.array(DiagnosticSchema),
  filesScanned: z.number().int().nonnegative(),
  bytesScanned: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
});

export const BuildResultSchema = z.strictObject({
  ok: z.boolean(),
  path: RelativePathSchema.optional(),
  size: z.number().int().nonnegative().optional(),
  sha256: Sha256Schema.optional(),
  entries: z.number().int().nonnegative(),
  diagnostics: z.array(DiagnosticSchema),
  truncated: z.boolean().optional(),
});

export const GameTestCaseResultSchema = z.strictObject({
  name: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});

export const GameTestResultSchema = z.strictObject({
  ok: z.boolean(),
  status: z.enum(['passed', 'failed', 'setup_required', 'cancelled', 'timeout']),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  reportPath: RelativePathSchema.optional(),
  tests: z.array(GameTestCaseResultSchema),
  diagnostics: z.array(DiagnosticSchema),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  truncated: z.boolean().optional(),
});

export const ResourceSelectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resource'),
    resourceType: AuthorableResourceTypeSchema,
    id: ResourceIdSchema,
  }),
  z.strictObject({
    kind: z.literal('path'),
    path: AuthorableTextPathSchema,
  }),
]);

const PayloadTextSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_MCP_PAYLOAD_BYTES,
    `Text exceeds the ${MAX_MCP_PAYLOAD_BYTES.toString()}-byte MCP payload limit`,
  );

const PayloadJsonSchema = z
  .json()
  .refine(
    fitsMcpPayload,
    `JSON exceeds the ${MAX_MCP_PAYLOAD_BYTES.toString()}-byte MCP payload limit`,
  );

export const ResourceContentSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: PayloadTextSchema,
  }),
  z.strictObject({
    kind: z.literal('json'),
    value: PayloadJsonSchema,
    pretty: z.boolean().default(true),
  }),
]);

export const DatapackCreateInputSchema = z
  .strictObject({
    project: RelativePathSchema.describe(
      'New datapack directory, relative to the configured workspace',
    ),
    namespace: NamespaceSchema,
    description: z.string().min(1).max(4096),
    minecraftVersion: MinecraftVersionSchema.default('26.2'),
    loadFunction: PayloadTextSchema.optional().describe(
      'When present, create <namespace>:load and register it in minecraft:load',
    ),
    tickFunction: PayloadTextSchema.optional().describe(
      'When present, create <namespace>:tick and register it in minecraft:tick',
    ),
    dryRun: z.boolean().default(false),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const DatapackInspectInputSchema = z
  .strictObject({
    project: RelativePathSchema,
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const ResourceReadInputSchema = z
  .strictObject({
    project: RelativePathSchema,
    selector: ResourceSelectorSchema,
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const ResourceUpsertInputSchema = z
  .strictObject({
    project: RelativePathSchema,
    selector: ResourceSelectorSchema,
    content: ResourceContentSchema,
    overwrite: z.boolean().default(false),
    expectedSha256: Sha256Schema.optional(),
    dryRun: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.overwrite && value.expectedSha256 === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expectedSha256'],
        message: 'expectedSha256 is required when overwrite is true',
      });
    }
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const ResourceDeleteInputSchema = z
  .strictObject({
    project: RelativePathSchema,
    selector: ResourceSelectorSchema,
    confirm: z.literal(true),
    expectedSha256: Sha256Schema,
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const DatapackValidateInputSchema = z
  .strictObject({
    project: RelativePathSchema,
    includeSpyglass: z.boolean().default(true),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const MinecraftLookupInputSchema = z
  .strictObject({
    query: z.string().min(1).max(256),
    minecraftVersion: MinecraftVersionSchema.default('26.2'),
    categories: z
      .array(z.enum(['command', 'registry', 'resource_type', 'identifier']))
      .min(1)
      .max(4)
      .optional(),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const DatapackTestInputSchema = z
  .strictObject({
    project: RelativePathSchema,
    tests: z.array(ResourceIdSchema).min(1).max(256).optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).default(300_000),
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const DatapackBuildInputSchema = z
  .strictObject({
    project: RelativePathSchema,
    outputPath: RelativePathSchema.optional(),
    overwrite: z.boolean().default(false),
    expectedSha256: Sha256Schema.optional(),
  })
  .superRefine((value, context) => {
    if (value.overwrite && value.expectedSha256 === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expectedSha256'],
        message: 'expectedSha256 is required when overwrite is true',
      });
    }
  })
  .refine(fitsMcpPayload, MCP_PAYLOAD_LIMIT_MESSAGE);

export const DatapackInspectResultSchema = z.strictObject({
  ok: z.boolean(),
  project: RelativePathSchema,
  metadata: z.json(),
  minecraftVersion: MinecraftVersionSchema,
  packFormat: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  compatible: z.boolean(),
  namespaces: z.array(z.string().min(1).max(255)),
  resources: z.array(ResourceInventoryEntrySchema),
  files: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
  validationReadiness: z.strictObject({
    structural: z.boolean(),
    spyglass: z.boolean(),
    vanilla: z.boolean(),
  }),
  diagnostics: z.array(DiagnosticSchema),
  truncated: z.boolean(),
});

export const ResourceReadResultSchema = z.strictObject({
  ok: z.boolean(),
  project: RelativePathSchema,
  path: RelativePathSchema,
  mimeType: z.string().min(1),
  content: z.string(),
  sha256: Sha256Schema,
  size: z.number().int().nonnegative(),
  bytesReturned: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const MinecraftLookupResultSchema = z.strictObject({
  ok: z.boolean(),
  minecraftVersion: MinecraftVersionSchema,
  query: z.string(),
  cacheReady: z.boolean(),
  results: z.array(
    z.strictObject({
      category: z.enum(['command', 'registry', 'resource_type', 'identifier']),
      id: z.string().min(1),
      summary: z.string().optional(),
      data: z.json().optional(),
    }),
  ),
  truncated: z.boolean(),
});

export const ProjectSummarySchema = z.strictObject({
  project: RelativePathSchema,
  name: z.string().min(1),
  description: z.json().optional(),
  minecraftVersion: MinecraftVersionSchema,
  namespaces: z.array(z.string().min(1).max(255)),
  sha256: Sha256Schema.optional(),
});

export const LastDiagnosticsResultSchema = z.strictObject({
  project: RelativePathSchema,
  available: z.boolean(),
  validation: ValidationResultSchema.optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
});

export const CachedRegistriesResultSchema = z.strictObject({
  ok: z.boolean(),
  minecraftVersion: MinecraftVersionSchema,
  cacheReady: z.boolean(),
  generatedAt: z.iso.datetime({ offset: true }).optional(),
  commands: z.array(z.string()).optional(),
  registries: z.record(z.string(), z.array(z.string())),
  resourceTypes: z.array(z.string()),
  diagnostics: z.array(DiagnosticSchema),
  truncated: z.boolean(),
});

export const ExecutionErrorSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.json().optional(),
  }),
});

export type DatapackCreateInput = z.infer<typeof DatapackCreateInputSchema>;
export type DatapackInspectInput = z.infer<typeof DatapackInspectInputSchema>;
export type ResourceReadInput = z.infer<typeof ResourceReadInputSchema>;
export type ResourceUpsertInput = z.infer<typeof ResourceUpsertInputSchema>;
export type ResourceDeleteInput = z.infer<typeof ResourceDeleteInputSchema>;
export type DatapackValidateInput = z.infer<typeof DatapackValidateInputSchema>;
export type MinecraftLookupInput = z.infer<typeof MinecraftLookupInputSchema>;
export type DatapackTestInput = z.infer<typeof DatapackTestInputSchema>;
export type DatapackBuildInput = z.infer<typeof DatapackBuildInputSchema>;
export type DatapackInspectResult = z.infer<typeof DatapackInspectResultSchema>;
export type ResourceReadResult = z.infer<typeof ResourceReadResultSchema>;
export type MinecraftLookupResult = z.infer<typeof MinecraftLookupResultSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type LastDiagnosticsResult = z.infer<typeof LastDiagnosticsResultSchema>;
export type CachedRegistriesResult = z.infer<typeof CachedRegistriesResultSchema>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;
