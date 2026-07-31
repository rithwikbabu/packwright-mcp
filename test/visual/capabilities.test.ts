import { describe, expect, it } from 'vitest';

import type { VisualCapabilityStatus } from '../../src/core/types.js';
import {
  createPackMetadata,
  createResourcePackMetadata,
  MINECRAFT_26_2,
  MINECRAFT_26_2_DATA_PACK,
  MINECRAFT_26_2_RESOURCE_PACK,
} from '../../src/core/version.js';
import {
  getVisualCapability,
  isVisualTarget,
  listVisualCapabilities,
  MINECRAFT_26_2_VISUAL_CAPABILITIES,
  VISUAL_TARGETS,
} from '../../src/visual/capabilities.js';

describe('Minecraft 26.2 visual capability profile', () => {
  it('composes data, resource, and capability profiles without breaking datapack aliases', () => {
    expect(MINECRAFT_26_2.dataPack).toBe(MINECRAFT_26_2_DATA_PACK);
    expect(MINECRAFT_26_2.resourcePack).toBe(MINECRAFT_26_2_RESOURCE_PACK);
    expect(MINECRAFT_26_2.visualCapabilities).toBe(MINECRAFT_26_2_VISUAL_CAPABILITIES);
    expect(MINECRAFT_26_2.packFormat).toBe(MINECRAFT_26_2.dataPack.packFormat);
    expect(MINECRAFT_26_2.resourceDirectories).toBe(MINECRAFT_26_2.dataPack.resourceDirectories);
    expect(MINECRAFT_26_2.resourcePack.packFormat).toEqual([88, 0]);
    expect(createPackMetadata('Data')).toMatchObject({
      pack: { min_format: [107, 1], max_format: [107, 1] },
    });
    expect(createResourcePackMetadata('Assets')).toEqual({
      pack: {
        description: 'Assets',
        min_format: [88, 0],
        max_format: [88, 0],
      },
    });
  });

  it('profiles client resources, item models, renderer limits, and binding strategies', () => {
    const profile = MINECRAFT_26_2.resourcePack;
    expect(profile.resourceDirectories.item_definition).toEqual({
      directory: 'items',
      extension: '.json',
    });
    expect(profile.resourceDirectories.equipment.directory).toBe('equipment');
    expect(profile.itemModelTypes).toEqual(
      expect.arrayContaining([
        'minecraft:model',
        'minecraft:condition',
        'minecraft:select',
        'minecraft:range_dispatch',
        'minecraft:composite',
      ]),
    );
    expect(profile.specialModelTypes).not.toHaveProperty('minecraft:bed');
    expect(profile.specialModelTypes).not.toHaveProperty('minecraft:standing_sign');
    expect(profile.removedSpecialModelTypes).toEqual([
      'minecraft:bed',
      'minecraft:standing_sign',
      'minecraft:hanging_sign',
    ]);
    expect(profile.removedAtlases).toEqual(['minecraft:beds', 'minecraft:signs']);
    expect(Object.keys(profile.specialModelTypes).sort()).toEqual([
      'minecraft:banner',
      'minecraft:chest',
      'minecraft:conduit',
      'minecraft:decorated_pot',
      'minecraft:head',
      'minecraft:shield',
      'minecraft:shulker_box',
      'minecraft:trident',
    ]);
    expect(
      Object.values(profile.specialModelTypes).every(
        (entry) => entry.softwareRenderer === 'unsupported',
      ),
    ).toBe(true);
    expect(profile.bindingStrategies.map((strategy) => strategy.id)).toEqual([
      'item_component_model',
      'blockstate_replacement',
      'registry_variant_asset',
      'equipment_asset',
      'display_entity_rig',
    ]);
    expect(profile.artifacts).toMatchObject({
      clientDownloadKey: 'client',
      assetIndexFromVersionMetadata: true,
      redistributable: false,
    });
  });

  it('returns one truthful capability status for every target', () => {
    expect(listVisualCapabilities()).toHaveLength(VISUAL_TARGETS.length);
    expect(new Set(listVisualCapabilities().map((entry) => entry.target))).toEqual(
      new Set(VISUAL_TARGETS),
    );
    const statuses = new Set<VisualCapabilityStatus>([
      'native',
      'simulated',
      'replacement',
      'requires_mod',
    ]);
    expect(listVisualCapabilities().every((entry) => statuses.has(entry.status))).toBe(true);
    expect(getVisualCapability('custom_item').compilerSupport).toBe('full');
    expect(getVisualCapability('conditional_item_state').compilerSupport).toBe('limited');
    expect(
      listVisualCapabilities()
        .filter(
          (entry) => entry.target !== 'custom_item' && entry.target !== 'conditional_item_state',
        )
        .every((entry) => entry.compilerSupport === 'unsupported'),
    ).toBe(true);
    expect(listVisualCapabilities(undefined, 'requires_mod').map((entry) => entry.target)).toEqual([
      'existing_mob_geometry',
      'new_particle_type',
    ]);
  });

  it('discloses the non-native identity of display and carrier approximations', () => {
    expect(getVisualCapability('custom_item')).toMatchObject({
      status: 'native',
      nativeIdentity: false,
    });
    expect(getVisualCapability('custom_item').disclosure).toMatch(/vanilla base item/u);
    for (const target of [
      'new_block_identity',
      'furniture_static_prop',
      'new_mob_pet',
      'skeletal_animated_creature',
      'projectile_spell_visual',
    ] as const) {
      const entry = getVisualCapability(target);
      expect(entry.status).toBe('simulated');
      expect(entry.nativeIdentity).toBe(false);
      expect(entry.disclosure).toBeTruthy();
    }
    expect(getVisualCapability('existing_mob_geometry')).toMatchObject({
      status: 'requires_mod',
      support: 'unsupported',
      nativeIdentity: false,
    });
    expect(isVisualTarget('custom_item')).toBe(true);
    expect(isVisualTarget('made_up_target')).toBe(false);
  });
});
