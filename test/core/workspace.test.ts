import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDatapackRoot, PackwrightError, Workspace } from '../../src/core/index.js';
import { temporaryWorkspace } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Workspace confinement', () => {
  it('requires an absolute, existing directory', async () => {
    await expect(Workspace.open('relative/workspace')).rejects.toMatchObject({
      code: 'invalid_workspace',
    });
  });

  it.each(['../outside', '%2e%2e/outside', '%252e%252e/outside', '/tmp/outside', 'C:\\outside'])(
    'rejects unsafe path %s',
    async (unsafe) => {
      const fixture = await temporaryWorkspace();
      cleanups.push(fixture.cleanup);
      await expect(fixture.workspace.resolve(unsafe)).rejects.toBeInstanceOf(PackwrightError);
    },
  );

  it('rejects an escape through an existing symlink for a non-existing target', async () => {
    const fixture = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    cleanups.push(fixture.cleanup, outside.cleanup);
    await symlink(outside.root, path.join(fixture.root, 'escape'));

    await expect(fixture.workspace.resolve('escape/not-created/file.json')).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });

  it('detects a project from a nested resource', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, 'packs/demo/data/demo/function'), { recursive: true });
    await writeFile(path.join(fixture.root, 'packs/demo/pack.mcmeta'), '{}\n');
    await writeFile(
      path.join(fixture.root, 'packs/demo/data/demo/function/load.mcfunction'),
      'say hi\n',
    );

    await expect(
      detectDatapackRoot(fixture.workspace, 'packs/demo/data/demo/function/load.mcfunction'),
    ).resolves.toBe('packs/demo');
  });
});
