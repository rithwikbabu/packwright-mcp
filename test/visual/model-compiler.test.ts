import { describe, expect, it } from 'vitest';
import {
  compileItemAsset,
  createItemBindingProposal,
  RESOURCE_PACK_FORMAT_26_2,
} from '../../src/visual/compiler.js';
import {
  MAX_MODEL_PARTS,
  parseModelSpec,
  safeParseModelSpec,
} from '../../src/visual/model-spec.js';
import { validateModelSpec } from '../../src/visual/visual-validation.js';
import { fireStaffInput } from './fixtures.js';

describe('semantic visual model specification', () => {
  it('normalizes a constrained cuboid/plane item specification', () => {
    const spec = parseModelSpec(fireStaffInput);
    expect(spec.schemaVersion).toBe(1);
    expect(spec.parts[1]?.rotation?.rescale).toBe(false);
    expect(spec.parts[2]?.shape).toBe('plane');
    expect(spec.states[0]).toMatchObject({ kind: 'condition', when: true });
  });

  it('rejects invalid geometry, empty manual UV maps, and parent cycles', () => {
    const parsed = safeParseModelSpec({
      id: 'arcana:broken',
      targetKind: 'item',
      parts: [
        {
          id: 'first',
          shape: 'cuboid',
          from: [1, 1, 1],
          to: [1, 2, 2],
          material: 'wood',
          parent: 'second',
          uvMode: 'manual',
          faces: {},
        },
        {
          id: 'second',
          shape: 'plane',
          from: [0, 0, 0],
          to: [0, 0, 1],
          material: 'wood',
          parent: 'first',
        },
      ],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Cuboid bounds must have positive size on every axis.',
        'Manual UV mode requires at least one face mapping.',
        'A plane must have exactly one zero-sized axis.',
        "Part parent cycle includes 'first'.",
      ]),
    );
  });

  it('accepts the shared 512-part ceiling and rejects one additional part', () => {
    const parts = Array.from({ length: MAX_MODEL_PARTS + 1 }, (_unused, index) => ({
      id: `part_${String(index)}`,
      shape: 'cuboid',
      from: [0, 0, 0],
      to: [1, 1, 1],
      material: 'material',
    }));
    const input = {
      id: 'arcana:part_limit',
      targetKind: 'item',
      parts: parts.slice(0, MAX_MODEL_PARTS),
    };

    expect(safeParseModelSpec(input).success).toBe(true);
    const overLimit = safeParseModelSpec({ ...input, parts });
    expect(overLimit.success).toBe(false);
    if (overLimit.success) return;
    expect(overLimit.error.issues).toContainEqual(
      expect.objectContaining({
        code: 'too_big',
        maximum: MAX_MODEL_PARTS,
        path: ['parts'],
      }),
    );
  });

  it('fails closed for item properties and codec parameters outside the supported 26.2 subset', () => {
    const unknownProperty = safeParseModelSpec({
      ...fireStaffInput,
      states: [
        {
          id: 'unknown',
          kind: 'condition',
          property: 'minecraft:not_real',
          model: 'arcana:item/unknown',
        },
      ],
    });
    expect(unknownProperty.success).toBe(false);

    const unknownCodec = safeParseModelSpec({
      ...fireStaffInput,
      states: [
        {
          id: 'component',
          kind: 'condition',
          property: 'minecraft:has_component',
          model: 'arcana:item/component',
          parameters: { component: 'minecraft:custom_name' },
        },
      ],
    });
    expect(unknownCodec.success).toBe(false);

    const unexpectedParameter = safeParseModelSpec({
      ...fireStaffInput,
      states: [
        {
          id: 'using',
          kind: 'condition',
          property: 'minecraft:using_item',
          model: 'arcana:item/using',
          parameters: { component: 'minecraft:custom_name' },
        },
      ],
    });
    expect(unexpectedParameter.success).toBe(false);
    expect(safeParseModelSpec(fireStaffInput).success).toBe(true);
  });

  it('diagnoses conflicting constant colors assigned to the same tint index', () => {
    const diagnostics = validateModelSpec({
      id: 'arcana:conflicting_tints',
      targetKind: 'item',
      materials: {
        red: { tintIndex: 0, color: '#ff0000' },
        blue: { tintIndex: 0, color: '#0000ff' },
      },
      parts: [
        {
          id: 'red_part',
          shape: 'cuboid',
          from: [0, 0, 0],
          to: [1, 1, 1],
          material: 'red',
        },
        {
          id: 'blue_part',
          shape: 'cuboid',
          from: [1, 0, 0],
          to: [2, 1, 1],
          material: 'blue',
        },
      ],
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: 'visual.tint.conflict', severity: 'error' }),
    );
  });
});

describe('Minecraft 26.2 item compiler', () => {
  it('compiles deterministic geometry, item states, UVs, and resource paths', () => {
    const compiled = compileItemAsset(fireStaffInput);
    expect(compiled.resourcePackFormat).toEqual(RESOURCE_PACK_FORMAT_26_2);
    expect(compiled.modelResourceId).toBe('arcana:item/firestaff');
    expect(compiled.files.map((file) => file.path)).toEqual([
      'assets/arcana/items/firestaff.json',
      'assets/arcana/models/item/firestaff.json',
    ]);
    expect(compiled.textures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          materialId: 'dark_oak',
          resourceId: 'arcana:item/firestaff/dark_oak',
          external: true,
        }),
        expect.objectContaining({
          materialId: 'fire_crystal',
          path: 'assets/arcana/textures/item/firestaff/fire_crystal.png',
          external: false,
        }),
      ]),
    );
    expect(compiled.uvLayout).toHaveLength(14);
    expect(
      compiled.uvLayout.every(
        (entry) =>
          entry.uv.every((coordinate) => coordinate >= 0 && coordinate <= 16) &&
          entry.pixelBounds[0] !== entry.pixelBounds[2] &&
          entry.pixelBounds[1] !== entry.pixelBounds[3],
      ),
    ).toBe(true);

    const modelFile = compiled.files.find((file) => file.role === 'model');
    const model = JSON.parse(modelFile?.content ?? '{}') as {
      elements?: { rotation?: { origin?: number[]; angle?: number } }[];
      display?: Record<string, unknown>;
    };
    expect(model.elements).toHaveLength(3);
    expect(model.elements?.some((element) => element.rotation?.angle === 22.5)).toBe(true);
    expect(model.elements?.some((element) => element.rotation?.origin?.[1] === 14)).toBe(true);
    expect(model.display).toHaveProperty('firstperson_righthand');

    const definitionFile = compiled.files.find((file) => file.role === 'item_definition');
    const definition = JSON.parse(definitionFile?.content ?? '{}') as {
      model?: {
        type?: string;
        on_true?: { model?: string; tints?: unknown[] };
        on_false?: { type?: string; entries?: { threshold?: number }[] };
      };
    };
    expect(definition.model).toMatchObject({
      type: 'minecraft:condition',
      on_true: {
        model: 'arcana:item/firestaff_casting',
        tints: [
          {
            type: 'minecraft:constant',
            value: [1, 0.415686, 0],
          },
        ],
      },
      on_false: {
        type: 'minecraft:range_dispatch',
        entries: [{ threshold: 2 }, { threshold: 10 }],
      },
    });
  });

  it('is byte-stable when semantically unordered parts and materials are reordered', () => {
    const first = compileItemAsset(fireStaffInput);
    const second = compileItemAsset({
      ...fireStaffInput,
      materials: {
        fire_crystal: fireStaffInput.materials.fire_crystal,
        dark_oak: fireStaffInput.materials.dark_oak,
      },
      parts: [...fireStaffInput.parts].reverse(),
    });
    expect(first.files.map((file) => file.sha256)).toEqual(second.files.map((file) => file.sha256));
  });

  it('compiles select properties and composite model layers', () => {
    const compiled = compileItemAsset({
      ...fireStaffInput,
      states: [
        {
          id: 'context',
          kind: 'select',
          property: 'minecraft:display_context',
          cases: [
            {
              when: ['firstperson_righthand', 'firstperson_lefthand'],
              model: 'arcana:item/firestaff_firstperson',
            },
          ],
        },
        {
          id: 'glow_overlay',
          kind: 'composite',
          models: ['arcana:item/firestaff_glow'],
        },
      ],
    });
    const definition = JSON.parse(
      compiled.files.find((file) => file.role === 'item_definition')?.content ?? '{}',
    ) as {
      model?: {
        type?: string;
        cases?: unknown[];
        fallback?: { type?: string; models?: unknown[] };
      };
    };
    expect(definition.model).toMatchObject({
      type: 'minecraft:select',
      cases: [
        {
          when: ['firstperson_righthand', 'firstperson_lefthand'],
          model: { type: 'minecraft:model', model: 'arcana:item/firestaff_firstperson' },
        },
      ],
      fallback: {
        type: 'minecraft:composite',
        models: [
          { type: 'minecraft:model', model: 'arcana:item/firestaff' },
          { type: 'minecraft:model', model: 'arcana:item/firestaff_glow' },
        ],
      },
    });
    expect(compiled.externalModelReferences).toEqual([
      'arcana:item/firestaff_firstperson',
      'arcana:item/firestaff_glow',
    ]);
  });

  it('creates a declarative native minecraft:item_model binding proposal', () => {
    const compiled = compileItemAsset(fireStaffInput);
    const binding = createItemBindingProposal(compiled.spec, compiled);
    expect(binding).toMatchObject({
      capability: 'native',
      strategy: 'minecraft:item_model',
      carrierItem: 'minecraft:blaze_rod',
      component: {
        id: 'minecraft:item_model',
        value: 'arcana:firestaff',
      },
      itemStack: {
        id: 'minecraft:blaze_rod',
        components: { 'minecraft:item_model': 'arcana:firestaff' },
      },
    });
    expect(binding.giveCommand).toBe(
      'give @s minecraft:blaze_rod[minecraft:item_model="arcana:firestaff"] 1',
    );
  });
});
