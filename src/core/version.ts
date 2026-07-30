import type { MinecraftVersion, PackFormat } from './types.js';

export const RESOURCE_TYPES = [
  'function',
  'function_tag',
  'advancement',
  'recipe',
  'predicate',
  'loot_table',
  'item_modifier',
  'structure',
  'dimension',
  'dimension_type',
  'chat_type',
  'damage_type',
  'dialog',
  'banner_pattern',
  'cat_variant',
  'cat_sound_variant',
  'chicken_variant',
  'chicken_sound_variant',
  'cow_variant',
  'cow_sound_variant',
  'enchantment',
  'enchantment_provider',
  'frog_variant',
  'instrument',
  'jukebox_song',
  'painting_variant',
  'pig_variant',
  'pig_sound_variant',
  'sulfur_cube_archetype',
  'test_environment',
  'test_instance',
  'timeline',
  'trade_set',
  'trim_material',
  'trim_pattern',
  'villager_trade',
  'wolf_sound_variant',
  'wolf_variant',
  'world_clock',
  'zombie_nautilus_variant',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface ResourceDirectory {
  readonly directory: string;
  readonly extension: '.json' | '.mcfunction' | '.nbt';
}

export interface VersionProfile {
  readonly minecraftVersion: MinecraftVersion;
  readonly packFormat: PackFormat;
  readonly javaMajor: number;
  readonly resourceDirectories: Readonly<Record<ResourceType, ResourceDirectory>>;
  readonly supportedRegistries: readonly string[];
  readonly experimentalFlags: readonly string[];
  /** Immutable Mojang launcher artifacts used only by explicit setup-version. */
  readonly artifacts: {
    readonly versionMetadataUrl: string;
    readonly versionMetadataSha1: string;
    readonly serverUrl: string;
    readonly serverSha1: string;
    readonly serverSize: number;
  };
}

const json = (directory: string): ResourceDirectory => ({
  directory,
  extension: '.json',
});

export const MINECRAFT_26_2: VersionProfile = Object.freeze({
  minecraftVersion: '26.2',
  packFormat: [107, 1] as const,
  javaMajor: 25,
  resourceDirectories: Object.freeze({
    function: { directory: 'function', extension: '.mcfunction' } as const,
    function_tag: json('tags/function'),
    advancement: json('advancement'),
    recipe: json('recipe'),
    predicate: json('predicate'),
    loot_table: json('loot_table'),
    item_modifier: json('item_modifier'),
    structure: { directory: 'structure', extension: '.nbt' } as const,
    dimension: json('dimension'),
    dimension_type: json('dimension_type'),
    chat_type: json('chat_type'),
    damage_type: json('damage_type'),
    dialog: json('dialog'),
    banner_pattern: json('banner_pattern'),
    cat_variant: json('cat_variant'),
    cat_sound_variant: json('cat_sound_variant'),
    chicken_variant: json('chicken_variant'),
    chicken_sound_variant: json('chicken_sound_variant'),
    cow_variant: json('cow_variant'),
    cow_sound_variant: json('cow_sound_variant'),
    enchantment: json('enchantment'),
    enchantment_provider: json('enchantment_provider'),
    frog_variant: json('frog_variant'),
    instrument: json('instrument'),
    jukebox_song: json('jukebox_song'),
    painting_variant: json('painting_variant'),
    pig_variant: json('pig_variant'),
    pig_sound_variant: json('pig_sound_variant'),
    sulfur_cube_archetype: json('sulfur_cube_archetype'),
    test_environment: json('test_environment'),
    test_instance: json('test_instance'),
    timeline: json('timeline'),
    trade_set: json('trade_set'),
    trim_material: json('trim_material'),
    trim_pattern: json('trim_pattern'),
    villager_trade: json('villager_trade'),
    wolf_sound_variant: json('wolf_sound_variant'),
    wolf_variant: json('wolf_variant'),
    world_clock: json('world_clock'),
    zombie_nautilus_variant: json('zombie_nautilus_variant'),
  }),
  supportedRegistries: Object.freeze([
    'banner_pattern',
    'cat_variant',
    'cat_sound_variant',
    'chat_type',
    'chicken_variant',
    'chicken_sound_variant',
    'cow_variant',
    'cow_sound_variant',
    'damage_type',
    'dialog',
    'dimension',
    'dimension_type',
    'enchantment',
    'enchantment_provider',
    'frog_variant',
    'instrument',
    'jukebox_song',
    'painting_variant',
    'pig_variant',
    'pig_sound_variant',
    'sulfur_cube_archetype',
    'test_environment',
    'test_instance',
    'timeline',
    'trade_set',
    'trim_material',
    'trim_pattern',
    'villager_trade',
    'wolf_sound_variant',
    'wolf_variant',
    'world_clock',
    'zombie_nautilus_variant',
  ]),
  experimentalFlags: Object.freeze(['zombie_nautilus_variant']),
  artifacts: Object.freeze({
    versionMetadataUrl:
      'https://piston-meta.mojang.com/v1/packages/3457237902814cca3f5c6f20b0c5db1b1f341512/26.2.json',
    versionMetadataSha1: '3457237902814cca3f5c6f20b0c5db1b1f341512',
    serverUrl:
      'https://piston-data.mojang.com/v1/objects/823e2250d24b3ddac457a60c92a6a941943fcd6a/server.jar',
    serverSha1: '823e2250d24b3ddac457a60c92a6a941943fcd6a',
    serverSize: 60_894_273,
  }),
});

export const SUPPORTED_VERSIONS: Readonly<Record<MinecraftVersion, VersionProfile>> = Object.freeze(
  {
    '26.2': MINECRAFT_26_2,
  },
);

export function getVersionProfile(version: string): VersionProfile {
  if (version !== '26.2') {
    throw new Error(`Unsupported Minecraft version: ${version}`);
  }
  return MINECRAFT_26_2;
}

export function formatEquals(left: readonly number[], right: PackFormat): boolean {
  return left.length === 2 && left[0] === right[0] && left[1] === right[1];
}

export function createPackMetadata(
  description: unknown,
  profile: VersionProfile = MINECRAFT_26_2,
): Record<string, unknown> {
  return {
    pack: {
      description,
      min_format: [...profile.packFormat],
      max_format: [...profile.packFormat],
    },
  };
}
