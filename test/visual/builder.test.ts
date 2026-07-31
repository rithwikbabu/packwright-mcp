import { describe, expect, it } from 'vitest';
import {
  createDeterministicResourcePackArchive,
  createDeterministicZipArchive,
} from '../../src/visual/builder.js';
import { compileItemAsset } from '../../src/visual/compiler.js';
import { fireStaffInput } from './fixtures.js';

describe('deterministic resource-pack archive', () => {
  it('builds byte-identical 26.2 ZIPs with pack.mcmeta at the root', async () => {
    const compiled = compileItemAsset(fireStaffInput);
    const entries = [
      ...compiled.files.map((file) => ({ path: file.path, data: file.content })),
      {
        path: 'assets/arcana/textures/item/firestaff/fire_crystal.png',
        data: new Uint8Array([137, 80, 78, 71]),
      },
    ];
    const first = await createDeterministicResourcePackArchive({
      description: 'Crystal fire staff assets',
      entries,
    });
    const second = await createDeterministicResourcePackArchive({
      description: 'Crystal fire staff assets',
      entries: [...entries].reverse(),
    });

    expect(first.sha256).toBe(second.sha256);
    expect(first.data.equals(second.data)).toBe(true);
    expect(first.entries).toBe(entries.length + 1);
    expect(first.resourcePackFormat).toEqual([88, 0]);
    expect(first.data.includes(Buffer.from('pack.mcmeta'))).toBe(true);
    expect(first.data.includes(Buffer.from('"min_format": [\n      88,\n      0\n    ]'))).toBe(
      true,
    );
  });

  it('rejects traversal and duplicate paths before creating a ZIP', async () => {
    await expect(
      createDeterministicResourcePackArchive({
        description: 'Unsafe',
        entries: [{ path: '../outside.png', data: new Uint8Array() }],
      }),
    ).rejects.toThrow('Unsafe resource-pack archive path');
    await expect(
      createDeterministicResourcePackArchive({
        description: 'Duplicate',
        entries: [
          { path: 'assets/demo/a.json', data: '{}' },
          { path: 'assets/demo/a.json', data: '{}' },
        ],
      }),
    ).rejects.toThrow('Duplicate resource-pack archive path');
    await expect(
      createDeterministicResourcePackArchive({
        description: 'Manifest collision',
        entries: [{ path: 'pack.mcmeta', data: '{}' }],
      }),
    ).rejects.toThrow('Duplicate resource-pack archive path');
    await expect(
      createDeterministicResourcePackArchive({
        description: 'Drive path',
        entries: [{ path: 'C:/outside.png', data: new Uint8Array() }],
      }),
    ).rejects.toThrow('Unsafe resource-pack archive path');
    await expect(
      createDeterministicResourcePackArchive({
        description: undefined,
        entries: [],
      }),
    ).rejects.toThrow('description must be a string or JSON text component');
  });

  it('archives the exact supplied pack snapshot without synthesizing or retaining mutable bytes', async () => {
    const metadata = Buffer.from(
      '{"pack":{"description":"Exact","min_format":[88,0],"max_format":[88,0]}}\n',
    );
    const model = Buffer.from('{"parent":"minecraft:item/generated"}\n');
    const firstPromise = createDeterministicZipArchive([
      { path: 'pack.mcmeta', data: metadata },
      { path: 'assets/demo/models/item/exact.json', data: model },
    ]);
    metadata.fill(0);
    model.fill(0);
    const first = await firstPromise;
    const second = await createDeterministicZipArchive([
      {
        path: 'assets/demo/models/item/exact.json',
        data: '{"parent":"minecraft:item/generated"}\n',
      },
      {
        path: 'pack.mcmeta',
        data: '{"pack":{"description":"Exact","min_format":[88,0],"max_format":[88,0]}}\n',
      },
    ]);

    expect(first.entries).toBe(2);
    expect(first.sha256).toBe(second.sha256);
    expect(first.data.equals(second.data)).toBe(true);
    expect(
      first.data.includes(
        Buffer.from('{"pack":{"description":"Exact","min_format":[88,0],"max_format":[88,0]}}\n'),
      ),
    ).toBe(true);
    expect(first.data.includes(Buffer.from('{"parent":"minecraft:item/generated"}\n'))).toBe(true);
  });
});
