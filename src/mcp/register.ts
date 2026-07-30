import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import { isPackwrightError } from '../core/errors.js';
import { MAX_MCP_PAYLOAD_BYTES } from '../core/limits.js';
import { MINECRAFT_26_2 } from '../core/version.js';
import {
  BuildResultSchema,
  DatapackBuildInputSchema,
  DatapackCreateInputSchema,
  DatapackInspectInputSchema,
  DatapackInspectResultSchema,
  DatapackTestInputSchema,
  DatapackValidateInputSchema,
  GameTestResultSchema,
  MinecraftLookupInputSchema,
  MinecraftLookupResultSchema,
  NamespaceSchema,
  OperationResultSchema,
  RelativePathSchema,
  ResourceDeleteInputSchema,
  ResourceReadInputSchema,
  ResourceReadResultSchema,
  ResourceIdSchema,
  ResourceUpsertInputSchema,
  ValidationResultSchema,
  type JsonValue,
} from './schemas.js';
import type { PackwrightProgress, PackwrightService, PackwrightServiceContext } from './service.js';
import {
  PROJECT_DIAGNOSTICS_URI_TEMPLATE,
  PROJECT_MANIFEST_URI_TEMPLATE,
  PROJECT_RESOURCES_URI_TEMPLATE,
  SUPPORTED_VERSIONS_URI,
  VERSION_REGISTRIES_URI_TEMPLATE,
  WORKSPACE_PACKS_URI,
  decodeProjectId,
  projectDiagnosticsUri,
  projectManifestUri,
  projectResourcesUri,
  versionRegistriesUri,
} from './uris.js';

export interface PackwrightMcpServerOptions {
  name?: string;
  version?: string;
}

const SERVER_INSTRUCTIONS = [
  'Packwright edits Minecraft Java Edition 26.2 datapacks inside one configured workspace.',
  'Inspect or read a resource before overwriting it, then provide its current SHA-256 as expectedSha256.',
  'Use dryRun for proposed creates and updates. Validate before testing, and test before building a ZIP.',
  'Minecraft lookups are cache-only and never access the network implicitly.',
].join(' ');

function serviceContext(context: ServerContext): PackwrightServiceContext {
  const progressToken = context.mcpReq._meta?.progressToken;

  return {
    signal: context.mcpReq.signal,
    reportProgress: async (update: PackwrightProgress): Promise<void> => {
      if (progressToken === undefined) {
        return;
      }

      await context.mcpReq.notify({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: update.progress,
          ...(update.total === undefined ? {} : { total: update.total }),
          ...(update.message === undefined ? {} : { message: update.message }),
        },
      });
    },
  };
}

function jsonSafe(value: unknown): JsonValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    return JSON.parse(serialized) as JsonValue;
  } catch {
    return undefined;
  }
}

function textFallback(value: object): string {
  const compact = JSON.stringify(value);
  if (Buffer.byteLength(compact, 'utf8') > 32 * 1024) {
    return 'The complete bounded result is available in structuredContent; the duplicate text fallback was omitted to stay within the MCP payload limit.';
  }
  return JSON.stringify(value, null, 2);
}

function fitsSerializedPayload(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_MCP_PAYLOAD_BYTES;
  } catch {
    return false;
  }
}

function sizeLimitPayload(subject: string) {
  return {
    ok: false as const,
    error: {
      code: 'size_limit',
      message: `${subject} exceeded the ${MAX_MCP_PAYLOAD_BYTES.toString()}-byte MCP payload limit`,
    },
  };
}

function sizeLimitExecutionError(): CallToolResult {
  const payload = sizeLimitPayload('Tool result');
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text', text: textFallback(payload) }],
  };
}

function enforceToolPayloadLimit(response: CallToolResult): CallToolResult {
  return fitsSerializedPayload(response) ? response : sizeLimitExecutionError();
}

function executionError(error: unknown): CallToolResult {
  let code = 'internal_error';
  let message = error instanceof Error ? error.message : String(error);
  let details: JsonValue | undefined;

  if (isPackwrightError(error)) {
    code = error.code;
    details = jsonSafe(error.details);
  } else if (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ABORT_ERR')
  ) {
    code = 'cancelled';
    message = 'The operation was cancelled';
  }

  const payload = {
    ok: false as const,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };

  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: 'text', text: textFallback(payload) }],
  };
}

async function executeTool<T extends object>(
  operation: () => Promise<T>,
  failed: (result: T) => boolean = (result) => 'ok' in result && result.ok === false,
): Promise<CallToolResult> {
  try {
    const result = await operation();
    const content = [{ type: 'text' as const, text: textFallback(result) }];
    const structuredContent = result as unknown as Record<string, unknown>;
    const response: CallToolResult = failed(result)
      ? { isError: true, structuredContent, content }
      : { structuredContent, content };
    return enforceToolPayloadLimit(response);
  } catch (error) {
    return enforceToolPayloadLimit(executionError(error));
  }
}

function jsonResource(uri: URL, value: unknown) {
  const response = {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
  if (fitsSerializedPayload(response)) {
    return response;
  }

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(sizeLimitPayload('Resource result'), null, 2),
      },
    ],
  };
}

function templateValue(variables: Record<string, string | string[]>, name: string): string {
  const value = variables[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Resource URI is missing the ${name} value`);
  }
  return value;
}

function registerTools(server: McpServer, service: PackwrightService): void {
  server.registerTool(
    'datapack_create',
    {
      title: 'Create Datapack',
      description:
        'Create a Minecraft Java Edition 26.2 datapack below the configured workspace. The target must not exist. Supports a no-write dry run and optional namespace load/tick functions.',
      inputSchema: DatapackCreateInputSchema,
      outputSchema: OperationResultSchema,
      annotations: {
        title: 'Create Datapack',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.createDatapack(input, serviceContext(context))),
  );

  server.registerTool(
    'datapack_inspect',
    {
      title: 'Inspect Datapack',
      description:
        'Inspect pack metadata, namespaces, resource inventory, hashes, Minecraft 26.2 compatibility, and validator readiness without changing files.',
      inputSchema: DatapackInspectInputSchema,
      outputSchema: DatapackInspectResultSchema,
      annotations: {
        title: 'Inspect Datapack',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.inspectDatapack(input, serviceContext(context))),
  );

  server.registerTool(
    'resource_read',
    {
      title: 'Read Datapack Resource',
      description:
        'Read an allowed text resource by typed Minecraft resource ID or exact pack-relative path. Returns its SHA-256 for guarded follow-up writes.',
      inputSchema: ResourceReadInputSchema,
      outputSchema: ResourceReadResultSchema,
      annotations: {
        title: 'Read Datapack Resource',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.readResource(input, serviceContext(context))),
  );

  server.registerTool(
    'resource_upsert',
    {
      title: 'Create or Update Resource',
      description:
        'Create a typed datapack resource or allowed text file. Existing files require overwrite=true and their current expectedSha256. dryRun returns the proposed diff without writing.',
      inputSchema: ResourceUpsertInputSchema,
      outputSchema: OperationResultSchema,
      annotations: {
        title: 'Create or Update Resource',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.upsertResource(input, serviceContext(context))),
  );

  server.registerTool(
    'resource_delete',
    {
      title: 'Delete Resource',
      description:
        "Delete exactly one datapack file. Requires confirm=true and the file's current SHA-256; directories are never recursively deleted.",
      inputSchema: ResourceDeleteInputSchema,
      outputSchema: OperationResultSchema,
      annotations: {
        title: 'Delete Resource',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.deleteResource(input, serviceContext(context))),
  );

  server.registerTool(
    'datapack_validate',
    {
      title: 'Validate Datapack',
      description:
        'Run Packwright structural validation and, when configured, external Spyglass diagnostics. Invalid packs return normalized diagnostics as a tool execution error.',
      inputSchema: DatapackValidateInputSchema,
      outputSchema: ValidationResultSchema,
      annotations: {
        title: 'Validate Datapack',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(
        () => service.validateDatapack(input, serviceContext(context)),
        (result) => !result.ok,
      ),
  );

  server.registerTool(
    'minecraft_lookup',
    {
      title: 'Search Minecraft 26.2 Data',
      description:
        'Search locally cached Minecraft 26.2 commands, registries, resource types, and identifiers. This tool never performs network access.',
      inputSchema: MinecraftLookupInputSchema,
      outputSchema: MinecraftLookupResultSchema,
      annotations: {
        title: 'Search Minecraft 26.2 Data',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.lookupMinecraft(input, serviceContext(context))),
  );

  server.registerTool(
    'datapack_test',
    {
      title: 'Run Vanilla GameTests',
      description:
        'Load a staged copy of the pack and run selected GameTests in a disposable Minecraft 26.2 universe. The configured timeout is capped at five minutes.',
      inputSchema: DatapackTestInputSchema,
      outputSchema: GameTestResultSchema,
      annotations: {
        title: 'Run Vanilla GameTests',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(
        () => service.testDatapack(input, serviceContext(context)),
        (result) => !result.ok || result.status !== 'passed',
      ),
  );

  server.registerTool(
    'datapack_build',
    {
      title: 'Build Datapack ZIP',
      description:
        'Validate and create a deterministic datapack ZIP with pack.mcmeta at its root. Existing output files require overwrite=true and their current SHA-256.',
      inputSchema: DatapackBuildInputSchema,
      outputSchema: BuildResultSchema,
      annotations: {
        title: 'Build Datapack ZIP',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.buildDatapack(input, serviceContext(context))),
  );
}

function registerResources(server: McpServer, service: PackwrightService): void {
  const projectsByRequest = new WeakMap<
    ServerContext,
    ReturnType<PackwrightService['listProjects']>
  >();
  const listProjects = (context: ServerContext) => {
    const existing = projectsByRequest.get(context);
    if (existing !== undefined) {
      return existing;
    }
    const pending = service.listProjects(serviceContext(context));
    projectsByRequest.set(context, pending);
    return pending;
  };

  server.registerResource(
    'workspace-packs',
    WORKSPACE_PACKS_URI,
    {
      title: 'Workspace Datapacks',
      description: 'Datapacks detected below the configured workspace root.',
      mimeType: 'application/json',
    },
    async (uri, context) => {
      const projects = await listProjects(context);
      return jsonResource(uri, {
        projects: projects.map((project) => ({
          ...project,
          resources: {
            manifest: projectManifestUri(project.project),
            inventory: projectResourcesUri(project.project),
            diagnostics: projectDiagnosticsUri(project.project),
          },
        })),
        truncated: service.projectsWereTruncated?.() ?? false,
      });
    },
  );

  server.registerResource(
    'supported-versions',
    SUPPORTED_VERSIONS_URI,
    {
      title: 'Supported Minecraft Versions',
      description: "Packwright's supported Minecraft Java Edition profiles.",
      mimeType: 'application/json',
    },
    (uri) =>
      jsonResource(uri, {
        versions: [
          {
            minecraftVersion: MINECRAFT_26_2.minecraftVersion,
            packFormat: [...MINECRAFT_26_2.packFormat],
            javaMajor: MINECRAFT_26_2.javaMajor,
            resourceTypes: Object.keys(MINECRAFT_26_2.resourceDirectories),
            supportedRegistries: [...MINECRAFT_26_2.supportedRegistries],
            experimentalFlags: [...MINECRAFT_26_2.experimentalFlags],
            registriesUri: versionRegistriesUri('26.2'),
          },
        ],
      }),
  );

  server.registerResource(
    'pack-manifest',
    new ResourceTemplate(PROJECT_MANIFEST_URI_TEMPLATE, {
      list: async (context) => {
        const projects = await listProjects(context);
        return {
          resources: projects.map((project) => ({
            uri: projectManifestUri(project.project),
            name: `${project.name} manifest`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Datapack Manifest',
      description:
        'Parsed pack.mcmeta and compatibility details for a workspace datapack. projectId is the canonical base64url encoding of its relative path.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) => {
      const project = decodeProjectId(templateValue(variables, 'projectId'));
      const inspection = await service.inspectDatapack({ project }, serviceContext(context));
      return jsonResource(uri, {
        project,
        metadata: inspection.metadata,
        minecraftVersion: inspection.minecraftVersion,
        packFormat: inspection.packFormat,
        compatible: inspection.compatible,
        sha256: inspection.sha256,
        diagnostics: inspection.diagnostics,
      });
    },
  );

  server.registerResource(
    'pack-resources',
    new ResourceTemplate(PROJECT_RESOURCES_URI_TEMPLATE, {
      list: async (context) => {
        const projects = await listProjects(context);
        return {
          resources: projects.map((project) => ({
            uri: projectResourcesUri(project.project),
            name: `${project.name} resource inventory`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Datapack Resource Inventory',
      description:
        'Resource paths, logical IDs, sizes, and SHA-256 hashes for a workspace datapack.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) => {
      const project = decodeProjectId(templateValue(variables, 'projectId'));
      const inspection = await service.inspectDatapack({ project }, serviceContext(context));
      return jsonResource(uri, {
        project,
        resources: inspection.resources,
        files: inspection.files,
        totalBytes: inspection.totalBytes,
        sha256: inspection.sha256,
      });
    },
  );

  server.registerResource(
    'pack-last-diagnostics',
    new ResourceTemplate(PROJECT_DIAGNOSTICS_URI_TEMPLATE, {
      list: async (context) => {
        const projects = await listProjects(context);
        return {
          resources: projects.map((project) => ({
            uri: projectDiagnosticsUri(project.project),
            name: `${project.name} last diagnostics`,
            mimeType: 'application/json',
          })),
        };
      },
    }),
    {
      title: 'Last Datapack Diagnostics',
      description: 'The most recent cached validation result for a datapack.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) => {
      const project = decodeProjectId(templateValue(variables, 'projectId'));
      const result = await service.getLastDiagnostics({ project }, serviceContext(context));
      return jsonResource(uri, result);
    },
  );

  server.registerResource(
    'version-registries',
    new ResourceTemplate(VERSION_REGISTRIES_URI_TEMPLATE, {
      list: () => ({
        resources: [
          {
            uri: versionRegistriesUri('26.2'),
            name: 'Minecraft 26.2 cached registries',
            mimeType: 'application/json',
          },
        ],
      }),
    }),
    {
      title: 'Cached Minecraft Registries',
      description:
        'Commands, registries, and resource types loaded by explicit setup-version; reading this resource never downloads data.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) => {
      const version = templateValue(variables, 'version');
      if (version !== '26.2') {
        throw new Error(`Unsupported Minecraft version: ${version}`);
      }
      const result = await service.getCachedRegistries(
        { minecraftVersion: version },
        serviceContext(context),
      );
      return jsonResource(uri, result);
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'scaffold_feature',
    {
      title: 'Scaffold a Datapack Feature',
      description: 'Plan a safe, reviewable set of Packwright calls for a new datapack feature.',
      argsSchema: z.strictObject({
        project: RelativePathSchema,
        feature: z.string().min(1).max(512),
        namespace: NamespaceSchema.optional(),
        requirements: z.string().max(4096).optional(),
        includeGametest: z.enum(['yes', 'no']).default('yes'),
      }),
    },
    ({ project, feature, namespace, requirements, includeGametest }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Design and scaffold the datapack feature "${feature}" in project "${project}".`,
              namespace === undefined
                ? 'Infer the namespace from datapack_inspect.'
                : `Use namespace "${namespace}".`,
              requirements === undefined
                ? 'Ask only if a product-level behavior is genuinely ambiguous.'
                : `Additional requirements: ${requirements}`,
              'Inspect existing resources first. Use resource_upsert with dryRun=true, review each diff, then apply guarded writes and run datapack_validate.',
              includeGametest === 'yes'
                ? 'Add an appropriate GameTest and run datapack_test after validation.'
                : 'Do not add a GameTest unless the implementation reveals a clear regression risk.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review_datapack',
    {
      title: 'Review a Datapack',
      description:
        "Review a workspace datapack using Packwright's inventory and layered validation.",
      argsSchema: z.strictObject({
        project: RelativePathSchema,
        focus: z.enum(['all', 'structure', 'compatibility', 'quality', 'security']).default('all'),
      }),
    },
    ({ project, focus }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Review datapack project "${project}" with focus "${focus}".`,
              'Start with datapack_inspect and datapack_validate. Read only the resources needed to verify each finding.',
              'Separate structural Packwright findings, advisory Spyglass findings, and authoritative vanilla evidence. Rank actionable findings by severity and include exact resource paths.',
              'Do not modify any files during the review.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'author_gametest',
    {
      title: 'Author a GameTest',
      description:
        'Plan and author a Minecraft 26.2 GameTest for behavior in a workspace datapack.',
      argsSchema: z.strictObject({
        project: RelativePathSchema,
        behavior: z.string().min(1).max(2048),
        namespace: NamespaceSchema.optional(),
        testId: ResourceIdSchema.optional(),
      }),
    },
    ({ project, behavior, namespace, testId }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Author a Minecraft 26.2 GameTest in project "${project}" for this behavior: ${behavior}`,
              namespace === undefined
                ? 'Infer the namespace from datapack_inspect.'
                : `Use namespace "${namespace}".`,
              testId === undefined
                ? 'Choose a descriptive, collision-free test resource ID.'
                : `Use test resource ID "${testId}".`,
              'Inspect related resources, create the test with a dry-run resource_upsert, apply it with optimistic concurrency, validate, then run only the new test with datapack_test.',
              'If vanilla setup is unavailable, report the setup_required result and retain the validated test resource.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}

export function registerPackwrightMcp(server: McpServer, service: PackwrightService): McpServer {
  registerTools(server, service);
  registerResources(server, service);
  registerPrompts(server);
  return server;
}

export function createPackwrightMcpServer(
  service: PackwrightService,
  options: PackwrightMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? 'packwright-mcp',
      version: options.version ?? '0.1.0',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  return registerPackwrightMcp(server, service);
}
