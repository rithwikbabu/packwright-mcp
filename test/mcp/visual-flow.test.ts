import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';

import { createDatapack } from '../../src/core/authoring.js';
import { createPackwrightMcpServer } from '../../src/mcp/register.js';
import { PackwrightApplication } from '../../src/service.js';
import { temporaryWorkspace } from '../core/helpers.js';
import { fireStaffInput } from '../visual/fixtures.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  const content = result.structuredContent;
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Expected structured tool content.');
  }
  return content as Record<string, unknown>;
}

describe('visual MCP flow', () => {
  it('drives paired attachment, semantic drafting, compilation, and image rendering', async () => {
    const temporary = await temporaryWorkspace();
    cleanups.push(temporary.cleanup);
    await createDatapack(temporary.workspace, {
      packPath: 'firestaff-data',
      namespace: 'arcana',
      description: 'Fire staff behavior',
    });
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'packwright-visual-mcp-cache-'));
    cleanups.push(() => rm(cacheRoot, { recursive: true, force: true }));
    const application = await PackwrightApplication.open({
      workspaceRoot: temporary.root,
      cacheDir: cacheRoot,
      javaCommand: 'java',
      readOnly: false,
      offline: true,
    });
    const server = createPackwrightMcpServer(application);
    const client = new Client({ name: 'visual-flow-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(
      () => client.close(),
      () => server.close(),
    );

    const attached = await client.callTool({
      name: 'visual_project_attach',
      arguments: {
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
      },
    });
    expect(attached.isError).not.toBe(true);
    expect(structured(attached)).toMatchObject({ ok: true, resourcepackCreated: true });

    const drafted = await client.callTool({
      name: 'visual_spec_upsert',
      arguments: {
        projectId: 'firestaff',
        request: 'A crystal fire staff',
        spec: {
          ...fireStaffInput,
          materials: {
            dark_oak: { color: '#4d2f1a' },
            fire_crystal: { color: '#ff6a00', emissive: true, tintIndex: 0 },
          },
          states: [],
        },
      },
    });
    const draft = structured(drafted);
    expect(drafted.isError).not.toBe(true);
    expect(draft).toMatchObject({ ok: true, operation: 'visual_spec_upsert' });
    const runId = draft.runId;
    const revisionId = draft.revisionId;
    if (typeof runId !== 'string' || typeof revisionId !== 'string') {
      throw new Error('Draft did not return run and revision IDs.');
    }

    const compiled = await client.callTool({
      name: 'visual_compile',
      arguments: { projectId: 'firestaff', runId, revisionId },
    });
    expect(compiled.isError).not.toBe(true);
    expect(structured(compiled)).toMatchObject({ ok: true, operation: 'visual_compile' });

    const rendered = await client.callTool({
      name: 'visual_render',
      arguments: { projectId: 'firestaff', runId, revisionId, viewSize: 64 },
    });
    if (rendered.isError === true) {
      throw new Error(`Visual render failed: ${JSON.stringify(rendered)}`);
    }
    expect(structured(rendered)).toMatchObject({ ok: true, runId, revisionId });
    expect(rendered.content.some((entry) => entry.type === 'image')).toBe(true);
    const image = rendered.content.find((entry) => entry.type === 'image');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    if (image?.type !== 'image') throw new Error('Expected contact-sheet image content.');
    expect(Buffer.from(image.data, 'base64').subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const connected = await client.callTool({
      name: 'visual_connect',
      arguments: {
        projectId: 'firestaff',
        runId,
        revisionId,
        carrierItem: 'minecraft:blaze_rod',
      },
    });
    expect(connected.isError).not.toBe(true);
    expect(structured(connected)).toMatchObject({ ok: true, operation: 'visual_connect' });

    const validated = await client.callTool({
      name: 'visual_validate',
      arguments: {
        projectId: 'firestaff',
        runId,
        revisionId,
        includeVanilla: false,
      },
    });
    expect(validated.isError).not.toBe(true);
    const validation = structured(validated);
    expect(validation).toMatchObject({ ok: true });
    if (!Array.isArray(validation.layers)) throw new Error('Expected visual validation layers.');
    expect(validation.layers).toContainEqual({ name: 'asset_graph', status: 'passed' });
    expect(validation.layers).toContainEqual({ name: 'vanilla_commands', status: 'skipped' });
  });
});
