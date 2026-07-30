import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { projectManifestUri } from '../../src/mcp/uris.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('compiled stdio server', () => {
  it('keeps stdout protocol-clean and serves a real client subprocess', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'packwright-stdio-'));
    cleanups.push(async () => rm(workspace, { recursive: true, force: true }));
    const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', '--workspace', workspace, '--offline'],
      cwd: path.dirname(cli),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'packwright-stdio-test', version: '1.0.0' });
    cleanups.push(async () => client.close());

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(9);

    const progress: number[] = [];
    const created = await client.callTool(
      {
        name: 'datapack_create',
        arguments: {
          project: 'stdio-pack',
          namespace: 'stdio_test',
          description: 'Created through a real MCP stdio subprocess',
          minecraftVersion: '26.2',
          loadFunction: 'say stdio works',
          dryRun: false,
        },
      },
      {
        onprogress: (update) => {
          progress.push(update.progress);
        },
      },
    );
    expect(created.isError).not.toBe(true);
    expect(progress).toEqual([0, 1]);
    await expect(
      readFile(path.join(workspace, 'stdio-pack/pack.mcmeta'), 'utf8'),
    ).resolves.toContain('107');

    const inspected = await client.callTool({
      name: 'datapack_inspect',
      arguments: { project: 'stdio-pack' },
    });
    expect(inspected.isError).not.toBe(true);
    expect(inspected.structuredContent).toMatchObject({
      ok: true,
      project: 'stdio-pack',
      compatible: true,
    });

    const manifest = await client.readResource({ uri: projectManifestUri('stdio-pack') });
    expect(manifest.contents[0]).toHaveProperty('text');
    if (manifest.contents[0] !== undefined && 'text' in manifest.contents[0]) {
      expect(JSON.parse(manifest.contents[0].text)).toMatchObject({
        project: 'stdio-pack',
        minecraftVersion: '26.2',
        compatible: true,
      });
    }

    const prompt = await client.getPrompt({
      name: 'author_gametest',
      arguments: {
        project: 'stdio-pack',
        behavior: 'Verify the load function initializes state',
        namespace: 'stdio_test',
      },
    });
    expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
    const promptContent = prompt.messages[0]?.content;
    if (promptContent?.type === 'text') {
      expect(promptContent.text).toContain(
        'an ordinary data/<namespace>/function/*.mcfunction file is not a test_function registry entry',
      );
      expect(promptContent.text).toContain('minecraft:always_pass');
    }
  }, 20_000);
});
