import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readStableFile, snapshotStableFile } from '../../src/core/stable-file.js';
import { temporaryWorkspace } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('stable file reads', () => {
  it('collects bytes and hashes them through one bounded handle', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const filename = path.join(fixture.root, 'resource.json');
    await writeFile(filename, '{"safe":true}\n');

    const snapshot = await snapshotStableFile(filename, { maxBytes: 1024 });
    const result = await readStableFile(filename, {
      maxBytes: snapshot.size,
      expected: snapshot,
      collect: true,
    });

    expect(result.snapshot).toEqual(snapshot);
    expect(result.data?.toString('utf8')).toBe('{"safe":true}\n');
  });

  it('rejects same-size content that no longer matches its snapshot', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const filename = path.join(fixture.root, 'resource.json');
    await writeFile(filename, '{"value":1}\n');
    const snapshot = await snapshotStableFile(filename, { maxBytes: 1024 });
    await writeFile(filename, '{"value":2}\n');

    await expect(
      readStableFile(filename, {
        maxBytes: snapshot.size,
        expected: snapshot,
        collect: true,
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('refuses final-component symlinks and oversized reads', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const target = path.join(fixture.root, 'target.txt');
    const linked = path.join(fixture.root, 'linked.txt');
    await writeFile(target, '12345');
    await symlink(target, linked);

    await expect(readStableFile(linked, { maxBytes: 5 })).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    await expect(readStableFile(target, { maxBytes: 4 })).rejects.toMatchObject({
      code: 'size_limit',
    });
  });
});
