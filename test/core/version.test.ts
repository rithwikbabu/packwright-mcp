import { describe, expect, it } from 'vitest';
import {
  createPackMetadata,
  getVersionProfile,
  MINECRAFT_26_2,
  resourcePath,
} from '../../src/core/index.js';

describe('Minecraft 26.2 profile', () => {
  it('pins the format, Java runtime, and singular resource mappings', () => {
    expect(getVersionProfile('26.2')).toBe(MINECRAFT_26_2);
    expect(MINECRAFT_26_2.packFormat).toEqual([107, 1]);
    expect(MINECRAFT_26_2.javaMajor).toBe(25);
    expect(resourcePath('function', 'demo:nested/load')).toBe(
      'data/demo/function/nested/load.mcfunction',
    );
    expect(resourcePath('recipe', 'demo:bread')).toBe('data/demo/recipe/bread.json');
    expect(resourcePath('sulfur_cube_archetype', 'demo:buoyant')).toBe(
      'data/demo/sulfur_cube_archetype/buoyant.json',
    );
    expect(
      [
        'world_clock',
        'villager_trade',
        'trade_set',
        'cat_sound_variant',
        'pig_sound_variant',
        'cow_sound_variant',
        'chicken_sound_variant',
        'timeline',
        'zombie_nautilus_variant',
        'dialog',
      ].map(
        (type) =>
          MINECRAFT_26_2.resourceDirectories[
            type as keyof typeof MINECRAFT_26_2.resourceDirectories
          ],
      ),
    ).toEqual(
      [
        'world_clock',
        'villager_trade',
        'trade_set',
        'cat_sound_variant',
        'pig_sound_variant',
        'cow_sound_variant',
        'chicken_sound_variant',
        'timeline',
        'zombie_nautilus_variant',
        'dialog',
      ].map((directory) => ({ directory, extension: '.json' })),
    );
    expect(MINECRAFT_26_2.supportedRegistries).toEqual(
      expect.arrayContaining([
        'world_clock',
        'villager_trade',
        'trade_set',
        'cat_sound_variant',
        'pig_sound_variant',
        'cow_sound_variant',
        'chicken_sound_variant',
        'timeline',
        'zombie_nautilus_variant',
        'dialog',
      ]),
    );
    expect(MINECRAFT_26_2.experimentalFlags).toContain('zombie_nautilus_variant');
  });

  it('creates bounded 26.2 metadata', () => {
    expect(createPackMetadata('A pack')).toEqual({
      pack: {
        description: 'A pack',
        min_format: [107, 1],
        max_format: [107, 1],
      },
    });
  });

  it('rejects malformed resource identifiers', () => {
    expect(() => resourcePath('function', 'Upper:bad path')).toThrow(/Invalid resource/u);
  });
});
