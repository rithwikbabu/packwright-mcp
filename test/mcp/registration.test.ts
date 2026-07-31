import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_MCP_PAYLOAD_BYTES } from '../../src/core/limits.js';
import { createPackwrightMcpServer } from '../../src/mcp/register.js';
import type { PackwrightService } from '../../src/mcp/service.js';

const unused = (): Promise<never> => Promise.reject(new Error('Unexpected service method call'));

interface JsonSchemaShape {
  readonly type?: string | undefined;
  readonly const?: unknown;
  readonly additionalProperties?: boolean | undefined;
  readonly required?: readonly string[] | undefined;
  readonly properties?: Readonly<Record<string, JsonSchemaShape>> | undefined;
  readonly items?: JsonSchemaShape | undefined;
}

const service: PackwrightService = {
  createDatapack: unused,
  inspectDatapack: unused,
  readResource: unused,
  upsertResource: unused,
  deleteResource: unused,
  validateDatapack: unused,
  lookupMinecraft: unused,
  testDatapack: unused,
  buildDatapack: unused,
  listProjects: () => Promise.resolve([]),
  getLastDiagnostics: unused,
  getCachedRegistries: unused,
  getVisualCapabilities: unused,
  attachVisualProject: unused,
  inspectVisualAsset: unused,
  upsertVisualSpec: unused,
  importTexture: unused,
  compileVisual: unused,
  connectVisual: unused,
  renderVisual: unused,
  createVisualRevision: unused,
  commitVisual: unused,
  validateVisual: unused,
  buildProject: unused,
  readVisualResource: unused,
};

describe('Packwright MCP registration', () => {
  const closeCallbacks: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it('advertises the complete strict tool, resource, and prompt surface', async () => {
    const server = createPackwrightMcpServer(service);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );
    expect(client.getServerVersion()).toEqual({ name: 'packwright-mcp', version: '0.3.0' });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'datapack_create',
      'datapack_inspect',
      'resource_read',
      'resource_upsert',
      'resource_delete',
      'datapack_validate',
      'minecraft_lookup',
      'datapack_test',
      'datapack_build',
      'visual_capabilities',
      'visual_project_attach',
      'visual_asset_inspect',
      'visual_spec_upsert',
      'texture_import',
      'visual_compile',
      'visual_connect',
      'visual_render',
      'visual_revision_create',
      'visual_commit',
      'visual_validate',
      'project_build',
    ]);
    expect(tools.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
    expect(tools.tools.every((tool) => tool.outputSchema?.additionalProperties === false)).toBe(
      true,
    );
    expect(tools.tools.find((tool) => tool.name === 'resource_delete')?.annotations).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });

    const capabilitiesSchema = tools.tools.find((tool) => tool.name === 'visual_capabilities')
      ?.outputSchema as JsonSchemaShape | undefined;
    expect(capabilitiesSchema?.required).toEqual(
      expect.arrayContaining(['capabilities', 'reviewProfiles']),
    );
    const reviewProfiles = capabilitiesSchema?.properties?.reviewProfiles;
    expect(reviewProfiles).toMatchObject({
      type: 'array',
    });
    expect(reviewProfiles?.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(reviewProfiles?.items?.required).toEqual(
      expect.arrayContaining(['id', 'version', 'targetKind', 'support']),
    );

    const renderSchema = tools.tools.find((tool) => tool.name === 'visual_render')?.outputSchema as
      JsonSchemaShape | undefined;
    expect(renderSchema?.required).toEqual(
      expect.arrayContaining([
        'reviewProfile',
        'profileVersion',
        'reviewReady',
        'reportUri',
        'views',
        'measurements',
      ]),
    );
    expect(renderSchema?.properties?.reviewProfile).toMatchObject({
      type: 'string',
      const: 'held_item',
    });
    expect(renderSchema?.properties?.views?.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(renderSchema?.properties?.views?.items?.required).toEqual(
      expect.arrayContaining(['name', 'required', 'category', 'file', 'uri']),
    );
    expect(renderSchema?.properties?.measurements?.items).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(renderSchema?.properties?.measurements?.items?.required).toEqual(
      expect.arrayContaining(['metric', 'status', 'unit', 'message']),
    );

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.name)).toEqual([
      'pack-manifest',
      'pack-resources',
      'pack-last-diagnostics',
      'version-registries',
      'visual-project-manifest',
      'visual-project-asset-graph',
      'visual-draft-model-spec',
      'visual-contact-sheet',
      'visual-latest-review',
      'visual-render-report',
      'visual-binding-proposal',
      'visual-render-view',
    ]);

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      'packwright://workspace/packs',
    );
    expect(resources.resources.map((resource) => resource.uri)).toContain(
      'packwright://versions/supported',
    );

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
      'scaffold_feature',
      'review_datapack',
      'author_gametest',
      'generate_visual_asset',
      'review_visual_asset',
      'repair_visual_asset',
      'connect_custom_item',
      'author_display_rig',
    ]);
  });

  it('replaces an oversized tool response with a compact execution error', async () => {
    const oversizedService: PackwrightService = {
      ...service,
      readResource: () =>
        Promise.resolve({
          ok: true,
          project: 'example',
          path: 'data/example/function/load.mcfunction',
          mimeType: 'text/plain',
          content: 'a'.repeat(MAX_MCP_PAYLOAD_BYTES),
          sha256: 'a'.repeat(64),
          size: MAX_MCP_PAYLOAD_BYTES,
          bytesReturned: MAX_MCP_PAYLOAD_BYTES,
          truncated: false,
        }),
    };
    const server = createPackwrightMcpServer(oversizedService);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    const result = await client.callTool({
      name: 'resource_read',
      arguments: {
        project: 'example',
        selector: { kind: 'path', path: 'data/example/function/load.mcfunction' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'size_limit' },
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      MAX_MCP_PAYLOAD_BYTES,
    );
  });

  it('also bounds oversized service errors', async () => {
    const oversizedService: PackwrightService = {
      ...service,
      readResource: () => Promise.reject(new Error('a'.repeat(MAX_MCP_PAYLOAD_BYTES))),
    };
    const server = createPackwrightMcpServer(oversizedService);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    const result = await client.callTool({
      name: 'resource_read',
      arguments: {
        project: 'example',
        selector: { kind: 'path', path: 'data/example/function/load.mcfunction' },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'size_limit' },
    });
  });

  it('defaults to vanilla validation and renders command diagnostics as three readable lines', async () => {
    let receivedInput: unknown;
    const diagnosticService: PackwrightService = {
      ...service,
      validateDatapack: (input) => {
        receivedInput = input;
        return Promise.resolve({
          ok: false,
          filesScanned: 1,
          bytesScanned: 128,
          vanilla: {
            status: 'failed',
            filesChecked: 1,
            commandLinesChecked: 1,
            macroLinesDeferred: 0,
            durationMs: 10,
          },
          diagnostics: [
            {
              engine: 'minecraft',
              authority: 'authoritative',
              severity: 'error',
              code: 'minecraft.command.unknown_particle',
              message: 'Unknown particle `minecraft:electric`',
              path: 'data/spell/function/chain/cast.mcfunction',
              range: {
                start: { line: 11, character: 9 },
                end: { line: 11, character: 27 },
              },
              suggestedFix: 'Did you mean `minecraft:electric_spark`?',
            },
          ],
        });
      },
    };
    const server = createPackwrightMcpServer(diagnosticService);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    const result = await client.callTool({
      name: 'datapack_validate',
      arguments: { project: 'example' },
    });

    expect(receivedInput).toEqual({
      project: 'example',
      includeSpyglass: true,
      includeVanilla: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: [
          'spell/chain/cast.mcfunction:12',
          'Unknown particle `minecraft:electric`',
          'Did you mean `minecraft:electric_spark`?',
        ].join('\n'),
      },
    ]);
  });

  it('replaces an oversized JSON resource with a compact size-limit payload', async () => {
    const oversizedService: PackwrightService = {
      ...service,
      listProjects: () =>
        Promise.resolve([
          {
            project: 'example',
            name: 'Example',
            description: 'a'.repeat(MAX_MCP_PAYLOAD_BYTES),
            minecraftVersion: '26.2',
            namespaces: ['example'],
            sha256: 'a'.repeat(64),
          },
        ]),
    };
    const server = createPackwrightMcpServer(oversizedService);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    const result = await client.readResource({ uri: 'packwright://workspace/packs' });
    const content = result.contents[0];
    expect(content).toBeDefined();
    expect(content).toHaveProperty('text');
    if (content === undefined || !('text' in content)) {
      throw new Error('Expected a text resource');
    }

    expect(JSON.parse(content.text)).toMatchObject({
      ok: false,
      error: { code: 'size_limit' },
    });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(
      MAX_MCP_PAYLOAD_BYTES,
    );
  });

  it('propagates official-client cancellation to the running service operation', async () => {
    let markStarted: (() => void) | undefined;
    let markCancelled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      markCancelled = resolve;
    });
    const cancellationService: PackwrightService = {
      ...service,
      validateDatapack: (_input, context) =>
        new Promise((resolve) => {
          markStarted?.();
          const finish = (): void => {
            markCancelled?.();
            resolve({
              ok: false,
              diagnostics: [],
              filesScanned: 0,
              bytesScanned: 0,
            });
          };
          if (context.signal.aborted) {
            finish();
          } else {
            context.signal.addEventListener('abort', finish, { once: true });
          }
        }),
    };
    const server = createPackwrightMcpServer(cancellationService);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    const controller = new AbortController();
    const request = client.callTool(
      {
        name: 'datapack_validate',
        arguments: { project: 'example', includeSpyglass: false },
      },
      { signal: controller.signal },
    );
    await started;
    controller.abort();

    await expect(request).rejects.toThrow(/AbortError/u);
    await expect(cancelled).resolves.toBeUndefined();
  });

  it('returns inspection diagnostics instead of failing output validation for an invalid namespace', async () => {
    const invalidPackService: PackwrightService = {
      ...service,
      inspectDatapack: () =>
        Promise.resolve({
          ok: true,
          project: 'example',
          metadata: null,
          minecraftVersion: '26.2',
          packFormat: [107, 1],
          compatible: false,
          namespaces: ['Uppercase'],
          resources: [
            {
              path: 'data/Uppercase/function/load.mcfunction',
              size: 1,
              sha256: 'a'.repeat(64),
              resourceType: 'function',
              resourceId: 'Uppercase:load',
            },
          ],
          files: 1,
          totalBytes: 1,
          sha256: 'b'.repeat(64),
          validationReadiness: { structural: true, spyglass: false, vanilla: false },
          diagnostics: [
            {
              engine: 'packwright',
              authority: 'structural',
              severity: 'error',
              code: 'resource.invalid_namespace',
              message: 'Invalid namespace directory: Uppercase',
              path: 'data/Uppercase/function/load.mcfunction',
            },
          ],
          truncated: false,
        }),
    };
    const server = createPackwrightMcpServer(invalidPackService);
    const client = new Client({ name: 'packwright-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeCallbacks.push(
      () => client.close(),
      () => server.close(),
    );

    const result = await client.callTool({
      name: 'datapack_inspect',
      arguments: { project: 'example' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      namespaces: ['Uppercase'],
      diagnostics: [{ code: 'resource.invalid_namespace' }],
    });
  });
});
