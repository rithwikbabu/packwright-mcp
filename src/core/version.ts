import { MINECRAFT_26_2_VISUAL_CAPABILITIES } from '../visual/capabilities.js';
import type {
  MinecraftVersion,
  PackFormat,
  VisualCapabilityProfile,
  VisualSupportLevel,
} from './types.js';

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

export interface DataPackProfile {
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

export type ResourcePackResourceType =
  | 'item_definition'
  | 'model'
  | 'blockstate'
  | 'texture'
  | 'equipment'
  | 'atlas'
  | 'font'
  | 'particle';

export interface ResourcePackResourceDirectory {
  readonly directory: string;
  readonly extension: '.json' | '.png';
}

export interface SpecialModelRenderProfile {
  readonly softwareRenderer: VisualSupportLevel;
  readonly fallback: 'placeholder' | 'client_capture_required';
}

export interface BindingStrategyProfile {
  readonly id:
    | 'item_component_model'
    | 'blockstate_replacement'
    | 'registry_variant_asset'
    | 'equipment_asset'
    | 'display_entity_rig';
  readonly target: 'item' | 'block' | 'variant' | 'equipment' | 'display';
  readonly status: 'native' | 'simulated' | 'replacement';
  readonly carrierRequired: boolean;
  readonly dataPackResources: readonly string[];
  readonly resourcePackResources: readonly ResourcePackResourceType[];
}

export interface ResourcePackProfile {
  readonly packFormat: PackFormat;
  readonly resourceDirectories: Readonly<
    Record<ResourcePackResourceType, ResourcePackResourceDirectory>
  >;
  readonly schemaKinds: readonly (
    'item_definition' | 'item_model' | 'block_model' | 'blockstate' | 'equipment' | 'atlas'
  )[];
  readonly itemModelTypes: readonly string[];
  readonly specialModelTypes: Readonly<Record<string, SpecialModelRenderProfile>>;
  readonly removedSpecialModelTypes: readonly string[];
  readonly removedAtlases: readonly string[];
  readonly modelRules: {
    readonly generatedElementBounds: readonly [minimum: number, maximum: number];
    readonly rotationAxes: readonly ['x', 'y', 'z'];
    readonly rotationAngles: readonly number[];
    readonly uvUnits: 'texture_pixels';
    readonly tintIndexMinimum: number;
    readonly supportsTextureVariables: boolean;
    readonly supportsParents: boolean;
    readonly displayContexts: readonly string[];
  };
  readonly builtInModelParents: readonly string[];
  readonly bindingStrategies: readonly BindingStrategyProfile[];
  /** Official client data is resolved only during an explicit, opted-in setup step. */
  readonly artifacts: {
    readonly versionMetadataUrl: string;
    readonly versionMetadataSha1: string;
    readonly clientDownloadKey: 'client';
    readonly assetIndexFromVersionMetadata: true;
    readonly redistributable: false;
  };
}

export interface VersionProfile {
  readonly minecraftVersion: MinecraftVersion;
  readonly dataPack: DataPackProfile;
  readonly resourcePack: ResourcePackProfile;
  readonly visualCapabilities: VisualCapabilityProfile;
  /** Compatibility alias for dataPack.packFormat used by stable datapack contracts. */
  readonly packFormat: PackFormat;
  /** Compatibility alias for dataPack.javaMajor. */
  readonly javaMajor: number;
  /** Compatibility alias for dataPack.resourceDirectories. */
  readonly resourceDirectories: Readonly<Record<ResourceType, ResourceDirectory>>;
  /** Compatibility alias for dataPack.supportedRegistries. */
  readonly supportedRegistries: readonly string[];
  /** Compatibility alias for dataPack.experimentalFlags. */
  readonly experimentalFlags: readonly string[];
  /** Compatibility alias for dataPack.artifacts. */
  readonly artifacts: DataPackProfile['artifacts'];
}

const json = (directory: string): ResourceDirectory => ({
  directory,
  extension: '.json',
});

export const MINECRAFT_26_2_DATA_PACK: DataPackProfile = Object.freeze({
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

const clientJson = (directory: string): ResourcePackResourceDirectory =>
  Object.freeze({ directory, extension: '.json' });

const clientPng = (directory: string): ResourcePackResourceDirectory =>
  Object.freeze({ directory, extension: '.png' });

function bindingStrategy(value: BindingStrategyProfile): BindingStrategyProfile {
  return Object.freeze({
    ...value,
    dataPackResources: Object.freeze([...value.dataPackResources]),
    resourcePackResources: Object.freeze([...value.resourcePackResources]),
  });
}

export const MINECRAFT_26_2_RESOURCE_PACK: ResourcePackProfile = Object.freeze({
  packFormat: [88, 0] as const,
  resourceDirectories: Object.freeze({
    item_definition: clientJson('items'),
    model: clientJson('models'),
    blockstate: clientJson('blockstates'),
    texture: clientPng('textures'),
    equipment: clientJson('equipment'),
    atlas: clientJson('atlases'),
    font: clientJson('font'),
    particle: clientJson('particles'),
  }),
  schemaKinds: Object.freeze([
    'item_definition',
    'item_model',
    'block_model',
    'blockstate',
    'equipment',
    'atlas',
  ] as const),
  itemModelTypes: Object.freeze([
    'minecraft:model',
    'minecraft:special',
    'minecraft:composite',
    'minecraft:condition',
    'minecraft:select',
    'minecraft:range_dispatch',
    'minecraft:empty',
    'minecraft:bundle/selected_item',
  ]),
  // Bed and both sign special models were removed in resource-pack format 88.0.
  specialModelTypes: Object.freeze({
    'minecraft:banner': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:chest': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:conduit': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:decorated_pot': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:head': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:shield': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:shulker_box': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
    'minecraft:trident': Object.freeze({
      softwareRenderer: 'unsupported',
      fallback: 'client_capture_required',
    }),
  }),
  removedSpecialModelTypes: Object.freeze([
    'minecraft:bed',
    'minecraft:standing_sign',
    'minecraft:hanging_sign',
  ]),
  removedAtlases: Object.freeze(['minecraft:beds', 'minecraft:signs']),
  modelRules: Object.freeze({
    generatedElementBounds: Object.freeze([-16, 32] as const),
    rotationAxes: Object.freeze(['x', 'y', 'z'] as const),
    rotationAngles: Object.freeze([-45, -22.5, 0, 22.5, 45]),
    uvUnits: 'texture_pixels',
    tintIndexMinimum: 0,
    supportsTextureVariables: true,
    supportsParents: true,
    displayContexts: Object.freeze([
      'thirdperson_lefthand',
      'thirdperson_righthand',
      'firstperson_lefthand',
      'firstperson_righthand',
      'head',
      'gui',
      'ground',
      'fixed',
    ]),
  }),
  builtInModelParents: Object.freeze([
    'minecraft:builtin/entity',
    'minecraft:builtin/generated',
    'minecraft:item/generated',
    'minecraft:item/handheld',
    'minecraft:block/block',
    'minecraft:block/cube',
    'minecraft:block/cube_all',
    'minecraft:block/orientable',
    'minecraft:block/slab',
    'minecraft:block/stairs',
  ]),
  bindingStrategies: Object.freeze([
    bindingStrategy({
      id: 'item_component_model',
      target: 'item',
      status: 'native',
      carrierRequired: true,
      dataPackResources: ['function', 'recipe', 'loot_table'],
      resourcePackResources: ['item_definition', 'model', 'texture'],
    }),
    bindingStrategy({
      id: 'blockstate_replacement',
      target: 'block',
      status: 'replacement',
      carrierRequired: true,
      dataPackResources: [],
      resourcePackResources: ['blockstate', 'model', 'texture'],
    }),
    bindingStrategy({
      id: 'registry_variant_asset',
      target: 'variant',
      status: 'native',
      carrierRequired: false,
      dataPackResources: ['painting_variant', 'trim_material', 'trim_pattern'],
      resourcePackResources: ['texture', 'atlas'],
    }),
    bindingStrategy({
      id: 'equipment_asset',
      target: 'equipment',
      status: 'native',
      carrierRequired: true,
      dataPackResources: ['function'],
      resourcePackResources: ['equipment', 'item_definition', 'model', 'texture'],
    }),
    bindingStrategy({
      id: 'display_entity_rig',
      target: 'display',
      status: 'simulated',
      carrierRequired: true,
      dataPackResources: ['function', 'function_tag'],
      resourcePackResources: ['item_definition', 'model', 'texture'],
    }),
  ]),
  artifacts: Object.freeze({
    versionMetadataUrl:
      'https://piston-meta.mojang.com/v1/packages/3457237902814cca3f5c6f20b0c5db1b1f341512/26.2.json',
    versionMetadataSha1: '3457237902814cca3f5c6f20b0c5db1b1f341512',
    clientDownloadKey: 'client',
    assetIndexFromVersionMetadata: true,
    redistributable: false,
  }),
});

export const MINECRAFT_26_2: VersionProfile = Object.freeze({
  minecraftVersion: '26.2',
  dataPack: MINECRAFT_26_2_DATA_PACK,
  resourcePack: MINECRAFT_26_2_RESOURCE_PACK,
  visualCapabilities: MINECRAFT_26_2_VISUAL_CAPABILITIES,
  // Compatibility aliases for the established datapack-facing API.
  packFormat: MINECRAFT_26_2_DATA_PACK.packFormat,
  javaMajor: MINECRAFT_26_2_DATA_PACK.javaMajor,
  resourceDirectories: MINECRAFT_26_2_DATA_PACK.resourceDirectories,
  supportedRegistries: MINECRAFT_26_2_DATA_PACK.supportedRegistries,
  experimentalFlags: MINECRAFT_26_2_DATA_PACK.experimentalFlags,
  artifacts: MINECRAFT_26_2_DATA_PACK.artifacts,
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

export function createResourcePackMetadata(
  description: unknown,
  profile: VersionProfile = MINECRAFT_26_2,
): Record<string, unknown> {
  return {
    pack: {
      description,
      min_format: [...profile.resourcePack.packFormat],
      max_format: [...profile.resourcePack.packFormat],
    },
  };
}
