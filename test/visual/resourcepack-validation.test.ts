import { describe, expect, it } from 'vitest';

import { encodePng } from '../../src/visual/png.js';
import {
  validateResourcePackSnapshot,
  type ResourcePackSnapshotEntry,
} from '../../src/visual/resourcepack-validation.js';

const PACK_METADATA = JSON.stringify({
  pack: { description: 'Validated test assets', min_format: [88, 0], max_format: [88, 0] },
});

const PIXEL = encodePng({
  width: 1,
  height: 1,
  data: Buffer.from([255, 80, 20, 255]),
});

function validModel(texture: string): string {
  return JSON.stringify({
    parent: 'minecraft:item/handheld',
    textures: { layer0: texture },
    elements: [
      {
        from: [7, 0, 7],
        to: [9, 16, 9],
        faces: { north: { texture: '#layer0', uv: [0, 0, 16, 16] } },
      },
    ],
  });
}

function itemDefinition(model: string): string {
  return JSON.stringify({ model: { type: 'minecraft:model', model } });
}

describe('strict resource-pack snapshot validation', () => {
  it('accepts a complete 26.2 custom-item snapshot without mutating its entries', () => {
    const entries: ResourcePackSnapshotEntry[] = [
      { path: 'assets/arcana/textures/item/wand.png', data: PIXEL },
      { path: 'assets/arcana/models/item/wand.json', data: validModel('arcana:item/wand') },
      { path: 'pack.mcmeta', data: PACK_METADATA },
      { path: 'assets/arcana/items/wand.json', data: itemDefinition('arcana:item/wand') },
    ];
    const pathsBefore = entries.map((entry) => entry.path);

    const result = validateResourcePackSnapshot(entries);

    expect(result).toMatchObject({
      ok: true,
      filesChecked: 4,
      jsonFilesChecked: 3,
      pngFilesChecked: 1,
      modelsChecked: 1,
    });
    expect(result.diagnostics).toEqual([]);
    expect(entries.map((entry) => entry.path)).toEqual(pathsBefore);
  });

  it('rejects wrong metadata, malformed JSON, and malformed PNG bytes', () => {
    const result = validateResourcePackSnapshot([
      {
        path: 'pack.mcmeta',
        data: JSON.stringify({
          pack: { description: 'Wrong format', min_format: [87, 0], max_format: [88, 0] },
        }),
      },
      { path: 'assets/demo/lang/en_us.json', data: '{not json' },
      { path: 'assets/demo/textures/item/broken.png', data: Buffer.from([137, 80, 78, 71]) },
      { path: 'assets/INVALID/models/item/example.json', data: '{}' },
    ]);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'visual.resourcepack.metadata_format',
        'visual.resourcepack.invalid_json',
        'visual.resourcepack.invalid_png',
        'visual.resourcepack.asset_namespace',
      ]),
    );
  });

  it('detects parent cycles and missing custom model and texture references', () => {
    const result = validateResourcePackSnapshot([
      { path: 'pack.mcmeta', data: PACK_METADATA },
      { path: 'assets/demo/items/cycle.json', data: itemDefinition('demo:item/a') },
      {
        path: 'assets/demo/models/item/a.json',
        data: JSON.stringify({ parent: 'demo:item/b', textures: { layer0: 'demo:item/missing' } }),
      },
      {
        path: 'assets/demo/models/item/b.json',
        data: JSON.stringify({ parent: 'demo:item/a' }),
      },
      { path: 'assets/demo/items/missing.json', data: itemDefinition('demo:item/not_here') },
    ]);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'visual.resourcepack.model_parent_cycle',
          severity: 'error',
        }),
        expect.objectContaining({
          code: 'visual.resourcepack.missing_model',
          target: 'demo:item/not_here',
        }),
        expect.objectContaining({
          code: 'visual.resourcepack.missing_texture',
          target: 'demo:item/missing',
        }),
      ]),
    );
  });

  it('flags unknown built-in references unless the verified client cache recognizes them', () => {
    const entries: ResourcePackSnapshotEntry[] = [
      { path: 'pack.mcmeta', data: PACK_METADATA },
      {
        path: 'assets/demo/items/diamond_view.json',
        data: itemDefinition('minecraft:item/diamond'),
      },
    ];

    const unverified = validateResourcePackSnapshot(entries);
    expect(unverified.ok).toBe(true);
    expect(unverified.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'visual.resourcepack.model_unverified_builtin',
        severity: 'warning',
        target: 'minecraft:item/diamond',
      }),
    );

    const verified = validateResourcePackSnapshot(entries, {
      recognizedBuiltInModels: new Set(['minecraft:item/diamond']),
    });
    expect(verified.ok).toBe(true);
    expect(verified.diagnostics).toEqual([]);
  });

  it('fails closed for unsupported item properties, parameters, and select values', () => {
    const invalidDefinition = JSON.stringify({
      model: {
        type: 'minecraft:select',
        property: 'minecraft:display_context',
        unexpected: true,
        cases: [
          {
            when: 'over_the_shoulder',
            model: { type: 'minecraft:model', model: 'demo:item/wand' },
          },
        ],
        fallback: {
          type: 'minecraft:condition',
          property: 'minecraft:not_real',
          on_true: { type: 'minecraft:model', model: 'demo:item/wand' },
          on_false: { type: 'minecraft:model', model: 'demo:item/wand' },
        },
      },
    });

    const result = validateResourcePackSnapshot([
      { path: 'pack.mcmeta', data: PACK_METADATA },
      { path: 'assets/demo/items/wand.json', data: invalidDefinition },
      { path: 'assets/demo/models/item/wand.json', data: validModel('demo:item/wand') },
      { path: 'assets/demo/textures/item/wand.png', data: PIXEL },
    ]);

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.code === 'visual.resourcepack.item_property' &&
          entry.message.includes("does not accept parameter 'unexpected'"),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.code === 'visual.resourcepack.item_property' &&
          entry.message.includes('Unsupported Minecraft 26.2 condition item property'),
      ),
    ).toBe(true);
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.code === 'visual.resourcepack.item_model_case' &&
          entry.message.includes("cannot match value 'over_the_shoulder'"),
      ),
    ).toBe(true);
  });

  it('validates blockstate roots and reports feasible orphan model and texture findings', () => {
    const result = validateResourcePackSnapshot([
      { path: 'pack.mcmeta', data: PACK_METADATA },
      {
        path: 'assets/demo/blockstates/lamp.json',
        data: JSON.stringify({ variants: { '': { model: 'demo:block/lamp' } } }),
      },
      {
        path: 'assets/demo/models/block/lamp.json',
        data: validModel('demo:block/lamp'),
      },
      { path: 'assets/demo/textures/block/lamp.png', data: PIXEL },
      {
        path: 'assets/demo/models/block/unused.json',
        data: validModel('demo:block/unused'),
      },
      { path: 'assets/demo/textures/block/unused.png', data: PIXEL },
    ]);

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'visual.resourcepack.orphan_model',
          target: 'demo:block/unused',
        }),
        expect.objectContaining({
          code: 'visual.resourcepack.orphan_texture',
          target: 'demo:block/unused',
        }),
      ]),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: 'visual.resourcepack.orphan_model',
        target: 'demo:block/lamp',
      }),
    );
  });
});
