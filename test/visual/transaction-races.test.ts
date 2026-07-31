import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { link, rename, symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const injectedRace = vi.hoisted<{
  mode: 'none' | 'concurrent_install' | 'parent_swap_on_backup';
  fired: boolean;
  parent: string;
  moved: string;
  outside: string;
}>(() => ({
  mode: 'none',
  fired: false,
  parent: '',
  moved: '',
  outside: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<
    Record<string, unknown> & {
      link: typeof link;
      rename: typeof rename;
      symlink: typeof symlink;
      writeFile: typeof writeFile;
    }
  >();
  return {
    ...actual,
    async link(
      existingPath: Parameters<typeof actual.link>[0],
      newPath: Parameters<typeof actual.link>[1],
    ) {
      const existing = existingPath.toString();
      const destination = newPath.toString();
      if (
        injectedRace.mode === 'concurrent_install' &&
        !injectedRace.fired &&
        existing.endsWith('.stage') &&
        destination.endsWith('/existing.json')
      ) {
        injectedRace.fired = true;
        await actual.writeFile(newPath, 'concurrent writer\n', { flag: 'wx' });
      }
      return actual.link(existingPath, newPath);
    },
    async rename(
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) {
      const result = await actual.rename(oldPath, newPath);
      if (
        injectedRace.mode === 'parent_swap_on_backup' &&
        !injectedRace.fired &&
        newPath.toString().endsWith('.backup')
      ) {
        injectedRace.fired = true;
        await actual.rename(injectedRace.parent, injectedRace.moved);
        await actual.symlink(injectedRace.outside, injectedRace.parent, 'dir');
      }
      return result;
    },
  };
});

import { sha256Buffer } from '../../src/core/hash.js';
import { commitFileTransaction } from '../../src/visual/transaction.js';
import { temporaryWorkspace } from '../core/helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  injectedRace.mode = 'none';
  injectedRace.fired = false;
  injectedRace.parent = '';
  injectedRace.moved = '';
  injectedRace.outside = '';
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function onlyJournal(root: string): Promise<string> {
  const files = await readdir(path.join(root, '.packwright/transactions'));
  expect(files).toHaveLength(1);
  const journal = files[0];
  if (journal === undefined) throw new Error('Expected a retained transaction journal.');
  return journal;
}

describe('visual transaction race hardening', () => {
  it('never replaces a concurrent writer and retains the backup and journal on EEXIST', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await writeFile(path.join(fixture.root, 'existing.json'), 'original\n');
    injectedRace.mode = 'concurrent_install';

    await expect(
      commitFileTransaction(fixture.workspace, [
        {
          path: 'existing.json',
          content: 'packwright replacement\n',
          expectedSha256: sha256Buffer('original\n'),
        },
      ]),
    ).rejects.toMatchObject({ code: 'transaction_recovery_required' });

    expect(injectedRace.fired).toBe(true);
    await expect(readFile(path.join(fixture.root, 'existing.json'), 'utf8')).resolves.toBe(
      'concurrent writer\n',
    );
    const rootFiles = await readdir(fixture.root);
    const backup = rootFiles.find((entry) => entry.endsWith('.backup'));
    const stage = rootFiles.find((entry) => entry.endsWith('.stage'));
    expect(backup).toBeDefined();
    expect(stage).toBeDefined();
    await expect(readFile(path.join(fixture.root, backup ?? ''), 'utf8')).resolves.toBe(
      'original\n',
    );
    await expect(readFile(path.join(fixture.root, stage ?? ''), 'utf8')).resolves.toBe(
      'packwright replacement\n',
    );
    expect(await onlyJournal(fixture.root)).toMatch(/^[0-9a-f-]{36}\.json$/u);
  });

  it('fails closed when a validated parent is replaced before backup verification', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const parent = path.join(fixture.root, 'assets');
    const moved = path.join(fixture.root, 'assets-before-swap');
    const outside = `${fixture.root}-outside-target`;
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await mkdir(parent);
    await mkdir(outside);
    await writeFile(path.join(parent, 'existing.json'), 'original\n');
    injectedRace.mode = 'parent_swap_on_backup';
    injectedRace.parent = parent;
    injectedRace.moved = moved;
    injectedRace.outside = outside;

    await expect(
      commitFileTransaction(fixture.workspace, [
        {
          path: 'assets/existing.json',
          content: 'packwright replacement\n',
          expectedSha256: sha256Buffer('original\n'),
        },
      ]),
    ).rejects.toMatchObject({ code: 'transaction_recovery_required' });

    expect(injectedRace.fired).toBe(true);
    expect((await lstat(parent)).isSymbolicLink()).toBe(true);
    expect(await readdir(outside)).toEqual([]);
    const retained = await readdir(moved);
    expect(retained.some((entry) => entry.endsWith('.backup'))).toBe(true);
    expect(retained.some((entry) => entry.endsWith('.stage'))).toBe(true);
    expect(await onlyJournal(fixture.root)).toMatch(/^[0-9a-f-]{36}\.json$/u);
  });
});
