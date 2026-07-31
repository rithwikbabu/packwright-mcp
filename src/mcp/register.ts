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
import {
  ProjectBuildInputSchema,
  ProjectBuildResultSchema,
  TextureImportInputSchema,
  VisualAssetInspectInputSchema,
  VisualAssetInspectResultSchema,
  VisualCapabilitiesInputSchema,
  VisualCapabilitiesResultSchema,
  VisualCommitInputSchema,
  VisualCommitResultSchema,
  VisualClientCaptureInputSchema,
  VisualClientCaptureResultSchema,
  VisualCompileInputSchema,
  VisualConnectInputSchema,
  VisualDraftResultSchema,
  VisualProjectAttachInputSchema,
  VisualProjectAttachResultSchema,
  VisualProjectIdSchema,
  VisualDraftIdSchema,
  VisualRenderInputSchema,
  VisualRenderResultSchema,
  VisualRevisionCreateInputSchema,
  VisualSpecUpsertInputSchema,
  VisualValidateInputSchema,
  VisualValidateResultSchema,
} from './visual-schemas.js';
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
import {
  VISUAL_CAPABILITIES_URI,
  VISUAL_PROJECT_GRAPH_URI_TEMPLATE,
  VISUAL_PROJECT_MANIFEST_URI_TEMPLATE,
  VISUAL_RUN_BINDING_URI_TEMPLATE,
  VISUAL_RUN_CLIENT_CAPTURE_CONTACT_SHEET_URI_TEMPLATE,
  VISUAL_RUN_CLIENT_CAPTURE_REPORT_URI_TEMPLATE,
  VISUAL_RUN_CLIENT_CAPTURE_SCALE_REFERENCE_SHEET_URI_TEMPLATE,
  VISUAL_RUN_CLIENT_CAPTURE_SUPPLEMENTAL_SHEET_URI_TEMPLATE,
  VISUAL_RUN_CLIENT_CAPTURE_VIEW_URI_TEMPLATE,
  VISUAL_RUN_CONTACT_SHEET_URI_TEMPLATE,
  VISUAL_RUN_RENDER_REPORT_URI_TEMPLATE,
  VISUAL_RUN_REVIEW_URI_TEMPLATE,
  VISUAL_RUN_SPEC_URI_TEMPLATE,
  VISUAL_RUN_VIEW_URI_TEMPLATE,
  visualRunContactSheetUri,
} from './visual-uris.js';

export interface PackwrightMcpServerOptions {
  name?: string;
  version?: string;
}

const SERVER_INSTRUCTIONS = [
  'Packwright edits paired Minecraft Java Edition 26.2 datapacks and resource packs inside one configured workspace.',
  'Inspect or read a resource before overwriting it, then provide its current SHA-256 as expectedSha256.',
  'Use dryRun for proposed creates and updates. Validate before testing, and test before building a ZIP.',
  'For visual assets use describe, immutable draft, connect, profile render, report review, targeted repair, validate, explicit commit, then paired build.',
  'Treat simulated and replacement capabilities literally; display carriers are not new native blocks or entities.',
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
  const candidate = value as {
    diagnostics?: unknown;
  };
  if (Array.isArray(candidate.diagnostics) && candidate.diagnostics.length > 0) {
    const rendered = candidate.diagnostics
      .flatMap((raw): string[] => {
        if (raw === null || typeof raw !== 'object') return [];
        const item = raw as {
          path?: unknown;
          range?: { start?: { line?: unknown } };
          message?: unknown;
          suggestedFix?: unknown;
          severity?: unknown;
          engine?: unknown;
          code?: unknown;
        };
        if (typeof item.message !== 'string') return [];
        const severity = typeof item.severity === 'string' ? item.severity.toUpperCase() : 'ERROR';
        const engine = typeof item.engine === 'string' ? item.engine : 'packwright';
        const code = typeof item.code === 'string' ? item.code : 'diagnostic';
        let location: string | undefined;
        if (typeof item.path === 'string' && typeof item.range?.start?.line === 'number') {
          const match = /^data\/([^/]+)\/function\/(.+\.mcfunction)$/u.exec(item.path);
          const displayed =
            match?.[1] === undefined || match[2] === undefined
              ? item.path
              : `${match[1]}/${match[2]}`;
          location = `${displayed}:${String(item.range.start.line + 1)}`;
        }
        return location === undefined
          ? [
              `${severity} [${engine}:${code}]: ${item.message}`,
              ...(typeof item.suggestedFix === 'string' ? [item.suggestedFix] : []),
            ]
          : [
              location,
              item.message,
              ...(typeof item.suggestedFix === 'string' ? [item.suggestedFix] : []),
            ];
      })
      .join('\n');
    if (rendered.length > 0 && Buffer.byteLength(rendered, 'utf8') <= 32 * 1024) return rendered;
  }
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

async function executeVisualRender(
  service: PackwrightService,
  input: Parameters<PackwrightService['renderVisual']>[0],
  context: PackwrightServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await service.renderVisual(input, context);
    const contactSheet = await service.readVisualResource(
      {
        kind: 'contact_sheet',
        runId: result.runId,
        revisionId: result.revisionId,
      },
      context,
    );
    if (contactSheet.mimeType !== 'image/png' || contactSheet.encoding !== 'base64') {
      throw new Error('Visual renderer returned an invalid contact-sheet resource.');
    }
    const response: CallToolResult = {
      ...(result.ok ? {} : { isError: true }),
      structuredContent: result,
      content: [
        { type: 'text', text: textFallback(result) },
        { type: 'image', data: contactSheet.data, mimeType: 'image/png' },
      ],
    };
    return enforceToolPayloadLimit(response);
  } catch (error) {
    return enforceToolPayloadLimit(executionError(error));
  }
}

async function executeVisualClientCapture(
  service: PackwrightService,
  input: Parameters<PackwrightService['captureVisual']>[0],
  context: PackwrightServiceContext,
): Promise<CallToolResult> {
  try {
    const result = await service.captureVisual(input, context);
    const content: CallToolResult['content'] = [{ type: 'text', text: textFallback(result) }];
    if (result.contactSheetUri !== undefined) {
      const contactSheet = await service.readVisualResource(
        {
          kind: 'client_contact_sheet',
          runId: result.runId,
          revisionId: result.revisionId,
        },
        context,
      );
      if (contactSheet.mimeType !== 'image/png' || contactSheet.encoding !== 'base64') {
        throw new Error('Client capture returned an invalid contact-sheet resource.');
      }
      content.push({ type: 'image', data: contactSheet.data, mimeType: 'image/png' });
    }
    const response: CallToolResult = {
      ...(result.ok && result.status === 'passed' ? {} : { isError: true }),
      structuredContent: result,
      content,
    };
    if (fitsSerializedPayload(response)) return response;

    // Full-resolution Minecraft framebuffers remain available through the
    // hash-bound resource URI in structuredContent. Do not turn a successful,
    // expensive capture into a size-limit failure solely because its optional
    // inline convenience image does not fit MCP's one-MiB envelope.
    return enforceToolPayloadLimit({
      ...(result.ok && result.status === 'passed' ? {} : { isError: true }),
      structuredContent: result,
      content: [{ type: 'text', text: textFallback(result) }],
    });
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

function visualResource(
  uri: URL,
  value: Awaited<ReturnType<PackwrightService['readVisualResource']>>,
) {
  const content =
    value.encoding === 'base64'
      ? { uri: uri.href, mimeType: value.mimeType, blob: value.data }
      : { uri: uri.href, mimeType: value.mimeType, text: value.data };
  const response = { contents: [content] };
  if (fitsSerializedPayload(response)) return response;
  return jsonResource(uri, sizeLimitPayload('Visual resource result'));
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
        'Run structural checks plus authoritative Minecraft 26.2 dispatcher, registry, and codec validation for every ordinary .mcfunction command. Requires setup-version and Java 25 unless includeVanilla=false; configured Spyglass diagnostics are also available. Invalid packs return normalized diagnostics as a tool execution error.',
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
        'Validate commands, then load a staged copy of the pack and run selected GameTests in a disposable Minecraft 26.2 universe. The configured timeout is one shared budget capped at five minutes.',
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
        'Run strict structural and authoritative Minecraft 26.2 command validation, then create a deterministic datapack ZIP with pack.mcmeta at its root. Java 25 and setup-version are required; builds cannot bypass vanilla validation. Existing output files require overwrite=true and their current SHA-256.',
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

  server.registerTool(
    'visual_capabilities',
    {
      title: 'Report Visual Capabilities',
      description:
        'Report the truthful Minecraft 26.2 capability boundary and the separately labeled current compiler support for each visual target.',
      inputSchema: VisualCapabilitiesInputSchema,
      outputSchema: VisualCapabilitiesResultSchema,
      annotations: {
        title: 'Report Visual Capabilities',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.getVisualCapabilities(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_project_attach',
    {
      title: 'Attach Paired Packs',
      description:
        'Associate sibling datapack and resource-pack roots through a guarded project manifest. Can create a new format-88.0 resource pack without moving the datapack.',
      inputSchema: VisualProjectAttachInputSchema,
      outputSchema: VisualProjectAttachResultSchema,
      annotations: {
        title: 'Attach Paired Packs',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.attachVisualProject(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_asset_inspect',
    {
      title: 'Inspect Visual Asset',
      description:
        'Inspect a paired project, its logical item graph, current draft readiness, bindings, textures, renders, and commit state without changing files.',
      inputSchema: VisualAssetInspectInputSchema,
      outputSchema: VisualAssetInspectResultSchema,
      annotations: {
        title: 'Inspect Visual Asset',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.inspectVisualAsset(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_spec_upsert',
    {
      title: 'Create Visual Draft',
      description:
        'Validate a semantic custom-item ModelSpec, including its selected review-profile metadata, and create an immutable, content-addressed draft run. Review profiles stage the same compiled item output and never imply new native target support.',
      inputSchema: VisualSpecUpsertInputSchema,
      outputSchema: VisualDraftResultSchema,
      annotations: {
        title: 'Create Visual Draft',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.upsertVisualSpec(input, serviceContext(context))),
  );

  server.registerTool(
    'texture_import',
    {
      title: 'Import PNG Texture',
      description:
        'Strictly decode, bound, normalize, metadata-strip, and content-address a PNG supplied inline or through an exact hash-guarded workspace file.',
      inputSchema: TextureImportInputSchema,
      outputSchema: VisualDraftResultSchema,
      annotations: {
        title: 'Import PNG Texture',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.importTexture(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_compile',
    {
      title: 'Compile Visual Draft',
      description:
        'Compile a semantic custom-item ModelSpec into exact Minecraft 26.2 item-definition, model, UV, and texture draft assets without changing the paired packs.',
      inputSchema: VisualCompileInputSchema,
      outputSchema: VisualDraftResultSchema,
      annotations: {
        title: 'Compile Visual Draft',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.compileVisual(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_connect',
    {
      title: 'Connect Item Behavior',
      description:
        'Create a guarded multi-file proposal connecting a client item definition to a vanilla carrier through minecraft:item_model, with optional give helper and recipe.',
      inputSchema: VisualConnectInputSchema,
      outputSchema: VisualDraftResultSchema,
      annotations: {
        title: 'Connect Item Behavior',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.connectVisual(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_render',
    {
      title: 'Render Visual Draft',
      description:
        'Render the selected model-specific scene-review profile with Packwright’s deterministic CPU renderer. All profiles produce bounded original-reference scenes, advisory measurements, an immutable report, individual image resources, and a contact sheet returned as image content.',
      inputSchema: VisualRenderInputSchema,
      outputSchema: VisualRenderResultSchema,
      annotations: {
        title: 'Render Visual Draft',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) => {
      const operationContext = serviceContext(context);
      return executeVisualRender(service, input, operationContext);
    },
  );

  server.registerTool(
    'visual_capture',
    {
      title: 'Capture With Minecraft Client',
      description:
        'Launch the pinned official Minecraft 26.2 client in a disposable deterministic studio and return protocol-v3, representation-bound framebuffer evidence for supported item, block, headwear, entity, or placeable fixtures. Required world/gameplay views are authoritative only for the recorded OpenGL environment. Scale-reference and debug-hitbox views are separately requested augmented QA aids, never WYSIWYG evidence and never substitutes for required authority. The strict representation union accepts no commands, functions, saves, executable content, or mod paths. Requires explicit client-capture setup and a graphical macOS session; never falls back to CPU images.',
      inputSchema: VisualClientCaptureInputSchema,
      outputSchema: VisualClientCaptureResultSchema,
      annotations: {
        title: 'Capture With Minecraft Client',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, context) => executeVisualClientCapture(service, input, serviceContext(context)),
  );

  server.registerTool(
    'visual_revision_create',
    {
      title: 'Repair Visual Draft',
      description:
        'Create an immutable child revision by changing only named parts, materials, display transforms, or selected review-profile metadata against the reviewed spec hash.',
      inputSchema: VisualRevisionCreateInputSchema,
      outputSchema: VisualDraftResultSchema,
      annotations: {
        title: 'Repair Visual Draft',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.createVisualRevision(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_commit',
    {
      title: 'Commit Accepted Visual',
      description:
        'After explicit acceptance, atomically install every proposed datapack and resource-pack file. Official-client evidence can authorize commit only when its proposalBindingStatus is implemented; capture_only block, headwear, entity, and placeable evidence is QA-only until the compiler implements that exact representation. Accepted evidence requires the exact verified report SHA-256, which is bound into the durable commit receipt.',
      inputSchema: VisualCommitInputSchema,
      outputSchema: VisualCommitResultSchema,
      annotations: {
        title: 'Commit Accepted Visual',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.commitVisual(input, serviceContext(context))),
  );

  server.registerTool(
    'visual_validate',
    {
      title: 'Validate Paired Visual Project',
      description:
        'Combine paired-pack, model, graph, CPU preview, binding, vanilla-command, and optional GameTest validation. Existing official-client evidence is authoritative by default for supported profiles; set requireClientCapture false only for an explicit fast advisory pass.',
      inputSchema: VisualValidateInputSchema,
      outputSchema: VisualValidateResultSchema,
      annotations: {
        title: 'Validate Paired Visual Project',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(
        () => service.validateVisual(input, serviceContext(context)),
        (result) => !result.ok,
      ),
  );

  server.registerTool(
    'project_build',
    {
      title: 'Build Paired Pack ZIPs',
      description:
        'Validate and build separate deterministic datapack and resource-pack ZIPs for an attached project. Existing artifacts require both current SHA-256 values.',
      inputSchema: ProjectBuildInputSchema,
      outputSchema: ProjectBuildResultSchema,
      annotations: {
        title: 'Build Paired Pack ZIPs',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, context) =>
      executeTool(() => service.buildProject(input, serviceContext(context))),
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
            dataPackFormat: [...MINECRAFT_26_2.dataPack.packFormat],
            resourcePackFormat: [...MINECRAFT_26_2.resourcePack.packFormat],
            javaMajor: MINECRAFT_26_2.javaMajor,
            resourceTypes: Object.keys(MINECRAFT_26_2.resourceDirectories),
            clientResourceTypes: Object.keys(MINECRAFT_26_2.resourcePack.resourceDirectories),
            supportedRegistries: [...MINECRAFT_26_2.supportedRegistries],
            experimentalFlags: [...MINECRAFT_26_2.experimentalFlags],
            registriesUri: versionRegistriesUri('26.2'),
            visualCapabilitiesUri: VISUAL_CAPABILITIES_URI,
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

  server.registerResource(
    'visual-capability-matrix',
    VISUAL_CAPABILITIES_URI,
    {
      title: 'Minecraft 26.2 Visual Capability Matrix',
      description:
        'Truthful native, simulated, replacement, and requires-mod support boundaries for all visual targets.',
      mimeType: 'application/json',
    },
    async (uri, context) =>
      jsonResource(
        uri,
        await service.getVisualCapabilities({ minecraftVersion: '26.2' }, serviceContext(context)),
      ),
  );

  server.registerResource(
    'visual-project-manifest',
    new ResourceTemplate(VISUAL_PROJECT_MANIFEST_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Paired Project Manifest',
      description:
        'The final datapack/resource-pack association for one Packwright visual project.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) =>
      visualResource(
        uri,
        await service.readVisualResource(
          { kind: 'project_manifest', projectId: templateValue(variables, 'projectId') },
          serviceContext(context),
        ),
      ),
  );

  server.registerResource(
    'visual-project-asset-graph',
    new ResourceTemplate(VISUAL_PROJECT_GRAPH_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Visual Project Asset Graph',
      description:
        'Logical item, carrier, component, item-definition, model, and texture relationships for a paired project.',
      mimeType: 'application/json',
    },
    async (uri, variables, context) =>
      visualResource(
        uri,
        await service.readVisualResource(
          { kind: 'project_graph', projectId: templateValue(variables, 'projectId') },
          serviceContext(context),
        ),
      ),
  );

  const runResourceInput = (
    variables: Record<string, string | string[]>,
    kind:
      | 'spec'
      | 'contact_sheet'
      | 'render_report'
      | 'review'
      | 'binding'
      | 'client_capture_report'
      | 'client_contact_sheet'
      | 'client_supplemental_sheet'
      | 'client_scale_reference_sheet',
  ) =>
    ({
      kind,
      runId: templateValue(variables, 'runId'),
      revisionId: templateValue(variables, 'revisionId'),
    }) as const;

  for (const resource of [
    {
      name: 'visual-draft-model-spec',
      template: VISUAL_RUN_SPEC_URI_TEMPLATE,
      title: 'Draft Model Specification',
      description: 'The immutable semantic ModelSpec for a visual revision.',
      kind: 'spec' as const,
      mimeType: 'application/json',
    },
    {
      name: 'visual-contact-sheet',
      template: VISUAL_RUN_CONTACT_SHEET_URI_TEMPLATE,
      title: 'Visual Contact Sheet',
      description: 'The deterministic standardized visual review contact sheet.',
      kind: 'contact_sheet' as const,
      mimeType: 'image/png',
    },
    {
      name: 'visual-latest-review',
      template: VISUAL_RUN_REVIEW_URI_TEMPLATE,
      title: 'Latest Visual Review',
      description: 'The immutable targeted repair record associated with a revision.',
      kind: 'review' as const,
      mimeType: 'application/json',
    },
    {
      name: 'visual-render-report',
      template: VISUAL_RUN_RENDER_REPORT_URI_TEMPLATE,
      title: 'Visual Render Profile Report',
      description:
        'The immutable profile plan, required-scene identity, and deterministic held-item measurements for a visual revision.',
      kind: 'render_report' as const,
      mimeType: 'application/json',
    },
    {
      name: 'visual-binding-proposal',
      template: VISUAL_RUN_BINDING_URI_TEMPLATE,
      title: 'Visual Binding Proposal',
      description: 'The declarative vanilla carrier and minecraft:item_model binding proposal.',
      kind: 'binding' as const,
      mimeType: 'application/json',
    },
    {
      name: 'visual-client-capture-report',
      template: VISUAL_RUN_CLIENT_CAPTURE_REPORT_URI_TEMPLATE,
      title: 'Minecraft Client Capture Report',
      description:
        'Hash-bound provenance and environment evidence from the actual Minecraft 26.2 renderer, including required_views_only authority scope and each view’s kind, authority, and required-or-supplemental status.',
      kind: 'client_capture_report' as const,
      mimeType: 'application/json',
    },
    {
      name: 'visual-client-contact-sheet',
      template: VISUAL_RUN_CLIENT_CAPTURE_CONTACT_SHEET_URI_TEMPLATE,
      title: 'Authoritative Minecraft Gameplay Contact Sheet',
      description:
        'A bounded composition of verified stock gameplay/world Minecraft framebuffers. It excludes every augmented scale-reference, debug-hitbox, grid, and inspection-only view.',
      kind: 'client_contact_sheet' as const,
      mimeType: 'image/png',
    },
    {
      name: 'visual-client-supplemental-sheet',
      template: VISUAL_RUN_CLIENT_CAPTURE_SUPPLEMENTAL_SHEET_URI_TEMPLATE,
      title: 'Minecraft Supplemental QA Contact Sheet',
      description:
        'A separately labeled composition of augmented QA-only frames such as scale references and debug hitboxes. It is never authoritative or a WYSIWYG gameplay preview.',
      kind: 'client_supplemental_sheet' as const,
      mimeType: 'image/png',
    },
    {
      name: 'visual-client-scale-reference-sheet',
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- protocol-v2 read compatibility
      template: VISUAL_RUN_CLIENT_CAPTURE_SCALE_REFERENCE_SHEET_URI_TEMPLATE,
      title: 'Deprecated Protocol-v2 Scale-Reference QA Sheet',
      description:
        'A read-only compatibility alias for stored protocol-v2 scale-reference evidence. Protocol v3 uses the generic supplemental QA sheet.',
      kind: 'client_scale_reference_sheet' as const,
      mimeType: 'image/png',
    },
  ]) {
    server.registerResource(
      resource.name,
      new ResourceTemplate(resource.template, { list: undefined }),
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri, variables, context) =>
        visualResource(
          uri,
          await service.readVisualResource(
            runResourceInput(variables, resource.kind),
            serviceContext(context),
          ),
        ),
    );
  }

  server.registerResource(
    'visual-render-view',
    new ResourceTemplate(VISUAL_RUN_VIEW_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Individual Visual Render View',
      description: 'One deterministic turntable or context render from a visual revision.',
      mimeType: 'image/png',
    },
    async (uri, variables, context) =>
      visualResource(
        uri,
        await service.readVisualResource(
          {
            kind: 'view',
            runId: templateValue(variables, 'runId'),
            revisionId: templateValue(variables, 'revisionId'),
            view: templateValue(variables, 'view'),
          },
          serviceContext(context),
        ),
      ),
  );

  server.registerResource(
    'visual-client-capture-view',
    new ResourceTemplate(VISUAL_RUN_CLIENT_CAPTURE_VIEW_URI_TEMPLATE, { list: undefined }),
    {
      title: 'Minecraft Client Framebuffer Preview',
      description:
        'A bounded preview of one actual Minecraft framebuffer. Consult the capture report for its exact representation hash, target, view kind, and authority: stock gameplay/world views are authoritative for their recorded environment, while injected scale references and debug hitboxes are augmented QA only. The report retains the full-resolution source and normalized PNG hashes.',
      mimeType: 'image/png',
    },
    async (uri, variables, context) =>
      visualResource(
        uri,
        await service.readVisualResource(
          {
            kind: 'client_view',
            runId: templateValue(variables, 'runId'),
            revisionId: templateValue(variables, 'revisionId'),
            view: templateValue(variables, 'view'),
          },
          serviceContext(context),
        ),
      ),
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
                ? 'Add a GameTest only when the pack already has a viable block_based structure or the test can use a known vanilla Test Function for smoke coverage; never treat a datapack .mcfunction as a Test Function. Run datapack_test after validation.'
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
        'Plan and author a vanilla-compatible Minecraft 26.2 GameTest for behavior in a workspace datapack.',
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
              'A vanilla datapack cannot register a function-type GameTest Test Function: an ordinary data/<namespace>/function/*.mcfunction file is not a test_function registry entry.',
              'Use a known vanilla Test Function only for infrastructure smoke coverage (for example minecraft:always_pass), or use a block_based test backed by an existing binary .nbt structure containing Test Blocks. Packwright v1 does not author binary structures.',
              'Do not invent a custom Test Function ID. If the requested behavior cannot be expressed with an existing structure, explain the limitation instead of creating a test that vanilla cannot load.',
              'Inspect related resources, create the test with a dry-run resource_upsert, apply it with optimistic concurrency, validate, then run only the new test with datapack_test.',
              'If vanilla setup is unavailable, report the setup_required result and retain the validated test resource.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'generate_visual_asset',
    {
      title: 'Generate a Visual Asset Draft',
      description:
        'Turn creative intent into a semantic ModelSpec and immutable draft without committing files.',
      argsSchema: z.strictObject({
        projectId: VisualProjectIdSchema,
        request: z.string().min(1).max(4096),
        target: z
          .enum(['custom_item', 'furniture_static_prop', 'new_mob_pet'])
          .default('custom_item'),
      }),
    },
    ({ projectId, request, target }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Create a visual draft for project "${projectId}": ${request}`,
              `Requested target: ${target}. Begin with visual_capabilities and disclose whether the result is native, simulated, replacement, or requires_mod.`,
              'For the supported custom-item compiler slice, author a semantic ModelSpec with named parts and materials, select the review profile that matches the intended presentation, and provide that profile’s semantic metadata. Call visual_spec_upsert, import textures only when needed, then call visual_compile and visual_render.',
              'Inspect reviewReady, the immutable selected-profile report, and its specialized contact sheet. The profile does not expand compiler support. Do not call visual_commit. Retain all creative provenance.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'review_visual_asset',
    {
      title: 'Review a Visual Asset',
      description:
        'Judge a deterministic profile report, contact sheet, and individual scenes against a semantic visual-review rubric.',
      argsSchema: z.strictObject({
        projectId: VisualProjectIdSchema,
        runId: VisualDraftIdSchema,
        revisionId: VisualDraftIdSchema,
        intent: z.string().min(1).max(4096),
      }),
    },
    ({ projectId, runId, revisionId, intent }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Visually review project ${projectId}, run ${runId}, revision ${revisionId}. Intended result: ${intent}`,
              `Read packwright://visual/runs/${runId}/revisions/${revisionId}/render-report and ${visualRunContactSheetUri(runId, revisionId)}; inspect individual profile views when a finding is ambiguous.`,
              'Review every required scene defined by the selected profile, including its original Packwright reference geometry. Treat all CPU-rendered fit, overlap, lighting, GUI, pose, scale, hitbox, and frame measurements as advisory rather than authoritative client evidence.',
              'When official-client evidence is available, review the authoritative gameplay contact sheet and every required stock view. A first_person_vanilla view is exact gameplay composition with no Packwright-injected arm. Treat any separately requested first_person_scale_reference view as augmented QA-only scale/occlusion context: it is never WYSIWYG and never substitutes for required evidence.',
              'Return accept or repair. A failed measurement or reviewReady=false requires repair. Name the exact part, material, display context, profile metadata field, scene, and metric when available. Do not mutate or commit files.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'repair_visual_asset',
    {
      title: 'Repair a Visual Asset',
      description: 'Translate review findings into a targeted immutable visual revision.',
      argsSchema: z.strictObject({
        projectId: VisualProjectIdSchema,
        runId: VisualDraftIdSchema,
        revisionId: VisualDraftIdSchema,
        finding: z.string().min(1).max(4096),
      }),
    },
    ({ projectId, runId, revisionId, finding }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Repair visual project ${projectId}, run ${runId}, revision ${revisionId}: ${finding}`,
              'Read the draft spec, immutable profile report, contact sheet, and implicated scene resources. Use visual_revision_create with the current spec SHA and only targeted part, material, display-transform, or selected-profile metadata repairs.',
              'Compile and profile-render the child revision, then compare the same selected-profile scenes and advisory measurements. Do not commit until reviewReady is true and a subsequent visual review explicitly accepts it.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'connect_custom_item',
    {
      title: 'Connect a Custom Item',
      description:
        'Create and validate a declarative vanilla carrier binding for an accepted custom-item draft.',
      argsSchema: z.strictObject({
        projectId: VisualProjectIdSchema,
        runId: VisualDraftIdSchema,
        revisionId: VisualDraftIdSchema,
        carrierItem: ResourceIdSchema.default('minecraft:stick'),
        recipe: z.enum(['yes', 'no']).default('no'),
      }),
    },
    ({ projectId, runId, revisionId, carrierItem, recipe }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Connect accepted visual revision ${revisionId} from run ${runId} in project ${projectId} to carrier ${carrierItem}.`,
              'Use visual_connect to create a proposal with a give helper and ' +
                (recipe === 'yes' ? 'a requested explicit recipe.' : 'no recipe.'),
              'Inspect the binding resource, run visual_validate with vanilla command validation, and present the proposal hash and file diffs. Do not call visual_commit without explicit acceptance.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'author_display_rig',
    {
      title: 'Author a Display Rig',
      description:
        'Plan a truthful vanilla display-entity approximation while the automatic rig compiler remains limited.',
      argsSchema: z.strictObject({
        projectId: VisualProjectIdSchema,
        request: z.string().min(1).max(4096),
        interaction: z.enum(['none', 'hitbox']).default('none'),
      }),
    },
    ({ projectId, request, interaction }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Plan a display-entity rig in visual project ${projectId}: ${request}`,
              'First call visual_capabilities. State prominently that the result is simulated and does not create a native block or entity identity.',
              `Interaction requirement: ${interaction}. Describe carrier choice, stable tags, display nodes, cleanup, migration, and performance budget.`,
              'The current public compiler automates the custom-item vertical slice only. Produce a reviewable plan and do not invent unsupported visual_commit outputs.',
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
      version: options.version ?? '0.5.0',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  return registerPackwrightMcp(server, service);
}
