import { describe, expect, it } from 'vitest';

import {
  ProjectBuildInputSchema,
  TextureImportInputSchema,
  VisualConnectInputSchema,
  VisualDraftIdSchema,
  VisualProjectIdSchema,
} from '../../src/mcp/visual-schemas.js';

const CONTENT_ID = 'a'.repeat(64);

function connection(recipe: unknown) {
  return {
    projectId: 'firestaff',
    runId: CONTENT_ID,
    carrierItem: 'minecraft:blaze_rod',
    generateRecipe: true,
    recipe,
  };
}

describe('visual MCP input schemas', () => {
  it('matches the project and content-addressed ID constraints used by visual storage', () => {
    expect(VisualProjectIdSchema.safeParse('fire_staff-2').success).toBe(true);
    expect(VisualProjectIdSchema.safeParse('fire.staff').success).toBe(false);
    expect(VisualDraftIdSchema.safeParse(CONTENT_ID).success).toBe(true);
    expect(VisualDraftIdSchema.safeParse('draft-1').success).toBe(false);
    expect(VisualDraftIdSchema.safeParse('A'.repeat(64)).success).toBe(false);
  });

  it('makes texture metadata stripping mandatory', () => {
    const base = {
      projectId: 'firestaff',
      runId: CONTENT_ID,
      material: 'crystal',
      source: { kind: 'png_base64' as const, data: 'iVBORw==' },
    };

    expect(TextureImportInputSchema.parse(base).stripMetadata).toBe(true);
    expect(TextureImportInputSchema.safeParse({ ...base, stripMetadata: false }).success).toBe(
      false,
    );
  });

  it('accepts a complete shaped recipe and rejects inconsistent rows', () => {
    expect(
      VisualConnectInputSchema.safeParse(
        connection({
          pattern: [' C ', ' S ', ' S '],
          key: { C: 'minecraft:amethyst_shard', S: 'minecraft:stick' },
        }),
      ).success,
    ).toBe(true);
    expect(
      VisualConnectInputSchema.safeParse(
        connection({
          pattern: ['CC', 'S'],
          key: { C: 'minecraft:amethyst_shard', S: 'minecraft:stick' },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects missing, unused, reserved, and empty shaped-recipe symbols', () => {
    const invalidRecipes = [
      { pattern: ['CS'], key: { C: 'minecraft:amethyst_shard' } },
      {
        pattern: ['C'],
        key: { C: 'minecraft:amethyst_shard', S: 'minecraft:stick' },
      },
      {
        pattern: ['C'],
        key: { C: 'minecraft:amethyst_shard', ' ': 'minecraft:air' },
      },
      { pattern: ['   '], key: {} },
    ];

    for (const recipe of invalidRecipes) {
      expect(VisualConnectInputSchema.safeParse(connection(recipe)).success).toBe(false);
    }
  });

  it('requires an explicit absence-or-hash precondition for both paired build outputs', () => {
    expect(
      ProjectBuildInputSchema.parse({
        projectId: 'firestaff',
        overwrite: true,
        expectedDatapackSha256: 'a'.repeat(64),
        expectedResourcepackSha256: null,
      }),
    ).toMatchObject({
      overwrite: true,
      expectedDatapackSha256: 'a'.repeat(64),
      expectedResourcepackSha256: null,
    });
    expect(
      ProjectBuildInputSchema.safeParse({
        projectId: 'firestaff',
        overwrite: true,
        expectedDatapackSha256: 'a'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      ProjectBuildInputSchema.safeParse({
        projectId: 'firestaff',
        expectedDatapackSha256: null,
        expectedResourcepackSha256: null,
      }).success,
    ).toBe(false);
  });
});
