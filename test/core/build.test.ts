import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDatapack, createDatapack, sha256File, upsertResource } from '../../src/core/index.js';
import { temporaryWorkspace } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('deterministic builds', () => {
  it('creates byte-identical ZIPs with pack.mcmeta at the root', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Build me',
      loadFunction: 'say hello',
    });
    const first = await buildDatapack(fixture.workspace, 'pack', {
      outputPath: 'build/one.zip',
    });
    const second = await buildDatapack(fixture.workspace, 'pack', {
      outputPath: 'build/two.zip',
    });
    expect(first.ok).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.entries).toBeGreaterThan(1);
    const bytes = await readFile(path.join(fixture.root, 'build/one.zip'));
    expect(bytes.includes(Buffer.from('pack.mcmeta'))).toBe(true);
  });

  it('hash-guards replacement of an existing build', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Build me',
    });
    const first = await buildDatapack(fixture.workspace, 'pack', { outputPath: 'pack.zip' });
    await expect(
      buildDatapack(fixture.workspace, 'pack', { outputPath: 'pack.zip' }),
    ).rejects.toMatchObject({ code: 'precondition_required' });
    await expect(
      buildDatapack(fixture.workspace, 'pack', {
        outputPath: 'pack.zip',
        overwrite: true,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    const overwritten = await buildDatapack(fixture.workspace, 'pack', {
      outputPath: 'pack.zip',
      overwrite: true,
      expectedSha256: first.sha256,
    });
    expect(overwritten.sha256).toBe(await sha256File(path.join(fixture.root, 'pack.zip')));
  });

  it('refuses to build a structurally invalid pack', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Break me',
    });
    await upsertResource(fixture.workspace, 'pack', {
      path: 'data/demo/function/new.mcfunction',
      content: 'say valid\n',
    });
    const manifest = path.join(fixture.root, 'pack/pack.mcmeta');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(manifest, '{}\n'));
    const result = await buildDatapack(fixture.workspace, 'pack', {
      outputPath: 'invalid.zip',
    });
    expect(result.ok).toBe(false);
    await expect(stat(path.join(fixture.root, 'invalid.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to build when an authoritative validation adapter rejects a command', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Authoritative validation',
      loadFunction: 'particle minecraft:electric ~ ~ ~',
    });

    const result = await buildDatapack(fixture.workspace, 'pack', {
      outputPath: 'invalid-command.zip',
      adapters: [
        {
          name: 'minecraft',
          authority: 'authoritative',
          validate(_packRoot, _signal, context) {
            expect(context?.packPath).toBe('pack');
            expect(context?.scan.entries.some((entry) => entry.path.endsWith('.mcfunction'))).toBe(
              true,
            );
            return Promise.resolve([
              {
                engine: 'minecraft',
                authority: 'authoritative',
                severity: 'error',
                code: 'minecraft.command.unknown_particle',
                message: 'Unknown particle `minecraft:electric`',
              },
            ]);
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'minecraft.command.unknown_particle' }),
    );
    await expect(stat(path.join(fixture.root, 'invalid-command.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses files added after the validated scan snapshot', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Stable snapshot',
    });

    await expect(
      buildDatapack(fixture.workspace, 'pack', {
        outputPath: 'raced.zip',
        adapters: [
          {
            name: 'deterministic-race',
            async validate(packRoot) {
              const directory = path.join(packRoot, 'data/demo/function');
              await mkdir(directory, { recursive: true });
              await writeFile(path.join(directory, 'late.mcfunction'), 'say too late\n');
              return [];
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    await expect(stat(path.join(fixture.root, 'raced.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
