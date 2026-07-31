import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Buffer } from '../../src/core/hash.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES } from '../../src/core/limits.js';
import {
  applyPackSnapshotOverlay,
  readConfinedPackSnapshot,
  type PackSnapshot,
} from '../../src/visual/pack-snapshot.js';
import { temporaryWorkspace } from '../core/helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function writePack(
  root: string,
  packPath: string,
  entries: readonly { readonly path: string; readonly data: string }[],
): Promise<void> {
  for (const entry of entries) {
    const filename = path.join(root, packPath, ...entry.path.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, entry.data);
  }
}

describe('confined pack snapshots', () => {
  it('produces a root-independent, order-independent tree identity from exact file bytes', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const entries = [
      {
        path: 'pack.mcmeta',
        data: '{"pack":{"description":"Fixture","pack_format":107}}\n',
      },
      { path: 'data/demo/function/load.mcfunction', data: 'say ready\n' },
      { path: 'data/minecraft/tags/function/load.json', data: '{"values":["demo:load"]}\n' },
    ];
    await writePack(fixture.root, 'first', [...entries].reverse());
    await writePack(fixture.root, 'second', entries);

    const first = await readConfinedPackSnapshot(fixture.workspace, 'first');
    const second = await readConfinedPackSnapshot(fixture.workspace, 'second');

    expect(first.entries.map((entry) => entry.path)).toEqual([
      'data/demo/function/load.mcfunction',
      'data/minecraft/tags/function/load.json',
      'pack.mcmeta',
    ]);
    expect(first.treeSha256).toBe(second.treeSha256);
    expect(first.totalBytes).toBe(
      entries.reduce((total, entry) => total + Buffer.byteLength(entry.data), 0),
    );
    expect(first.entries[0]?.sha256).toBe(sha256Buffer('say ready\n'));

    await writeFile(
      path.join(fixture.root, 'second/data/demo/function/load.mcfunction'),
      'say changed\n',
    );
    const changed = await readConfinedPackSnapshot(fixture.workspace, 'second');
    expect(changed.treeSha256).not.toBe(first.treeSha256);
  });

  it('rejects traversal, encoded traversal, symlink roots, and symlinked pack entries', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await writePack(fixture.root, 'safe', [
      { path: 'pack.mcmeta', data: '{"pack":{"description":"Safe","pack_format":107}}\n' },
      { path: 'data/demo/function/load.mcfunction', data: 'say safe\n' },
    ]);

    await expect(readConfinedPackSnapshot(fixture.workspace, '../safe')).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    await expect(
      readConfinedPackSnapshot(fixture.workspace, '%252e%252e/safe'),
    ).rejects.toMatchObject({ code: 'unsafe_path' });

    await symlink(path.join(fixture.root, 'safe'), path.join(fixture.root, 'linked-pack'));
    await expect(readConfinedPackSnapshot(fixture.workspace, 'linked-pack')).rejects.toMatchObject({
      code: 'unsafe_path',
    });

    await symlink(
      path.join(fixture.root, 'safe/data/demo/function/load.mcfunction'),
      path.join(fixture.root, 'safe/data/demo/function/linked.mcfunction'),
    );
    await expect(readConfinedPackSnapshot(fixture.workspace, 'safe')).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });

  it('applies copied overlays deterministically without mutating the source snapshot', () => {
    const originalBytes = Buffer.from('old\n');
    const snapshot: PackSnapshot = {
      root: 'assets',
      entries: [
        {
          path: 'pack.mcmeta',
          data: Buffer.from('{}\n'),
          sha256: sha256Buffer('{}\n'),
          size: 3,
        },
        {
          path: 'assets/demo/models/item/staff.json',
          data: originalBytes,
          sha256: sha256Buffer(originalBytes),
          size: originalBytes.length,
        },
      ],
      treeSha256: HASH_PLACEHOLDER,
      totalBytes: 7,
    };
    const replacement = Buffer.from('new\n');
    const added = Buffer.from('texture');
    const first = applyPackSnapshotOverlay(snapshot, [
      { path: 'assets/demo/textures/item/staff.png', data: added },
      { path: 'assets/demo/models/item/staff.json', data: replacement },
    ]);
    const second = applyPackSnapshotOverlay(snapshot, [
      { path: 'assets/demo/models/item/staff.json', data: replacement },
      { path: 'assets/demo/textures/item/staff.png', data: added },
    ]);
    replacement.fill(0);
    added.fill(0);

    expect(first.treeSha256).toBe(second.treeSha256);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      'assets/demo/models/item/staff.json',
      'assets/demo/textures/item/staff.png',
      'pack.mcmeta',
    ]);
    expect(first.entries[0]?.data.toString('utf8')).toBe('new\n');
    expect(first.entries[1]?.data.toString('utf8')).toBe('texture');
    expect(snapshot.entries[1]?.data.toString('utf8')).toBe('old\n');
    expect(first.totalBytes).toBe(3 + 4 + 7);
    expect(() =>
      applyPackSnapshotOverlay(snapshot, [{ path: '../escape.json', data: Buffer.from('{}') }]),
    ).toThrow(/unsafe path/u);
  });

  it('enforces sparse-byte and overlay-file limits before accepting a capture input', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await writePack(fixture.root, 'oversized', [
      {
        path: 'pack.mcmeta',
        data: '{"pack":{"description":"Oversized","pack_format":107}}\n',
      },
    ]);
    const sparse = path.join(fixture.root, 'oversized/zz-oversized.bin');
    await writeFile(sparse, '');
    await truncate(sparse, MAX_SCAN_BYTES);

    await expect(readConfinedPackSnapshot(fixture.workspace, 'oversized')).rejects.toMatchObject({
      code: 'size_limit',
    });

    const empty = Buffer.alloc(0);
    const full: PackSnapshot = {
      root: 'full',
      entries: Array.from({ length: MAX_SCAN_FILES }, (_, index) => ({
        path: `entry-${String(index).padStart(5, '0')}.json`,
        data: empty,
        sha256: sha256Buffer(empty),
        size: 0,
      })),
      treeSha256: HASH_PLACEHOLDER,
      totalBytes: 0,
    };
    expect(() => applyPackSnapshotOverlay(full, [{ path: 'one-more.json', data: empty }])).toThrow(
      /file limit/u,
    );
  });
});

const HASH_PLACEHOLDER = '0'.repeat(64);
