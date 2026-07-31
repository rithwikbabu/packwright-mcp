import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertRuntimePathSeparation, resolveRuntimeConfig } from '../src/config.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function temporaryContainer(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-config-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe('runtime path separation', () => {
  it('rejects lexical overlap in either direction during config resolution', async () => {
    const root = await temporaryContainer();
    const workspace = path.join(root, 'workspace');

    expect(() =>
      resolveRuntimeConfig({ workspace, cacheDir: path.join(workspace, '.cache') }),
    ).toThrow(/must not overlap/u);
    expect(() => resolveRuntimeConfig({ workspace, cacheDir: root })).toThrow(/must not overlap/u);
  });

  it('rejects canonical overlap hidden behind a symlinked cache ancestor', async () => {
    const root = await temporaryContainer();
    const workspace = path.join(root, 'workspace');
    const alias = path.join(root, 'workspace-alias');
    await mkdir(workspace);
    await symlink(workspace, alias, 'dir');
    const config = resolveRuntimeConfig({
      workspace,
      cacheDir: path.join(alias, 'cache'),
    });

    await expect(assertRuntimePathSeparation(config)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });

  it('accepts canonical sibling workspace and cache trees', async () => {
    const root = await temporaryContainer();
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    const config = resolveRuntimeConfig({
      workspace,
      cacheDir: path.join(root, 'cache'),
    });

    await expect(assertRuntimePathSeparation(config)).resolves.toBeUndefined();
  });
});
