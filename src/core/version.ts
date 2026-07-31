import { MINECRAFT_26_2_VISUAL_CAPABILITIES } from '../visual/capabilities.js';
import {
  CLIENT_CAPTURE_REVIEW_SUPPORT,
  type ClientCaptureReviewSupport,
} from '../visual/client-capture-support.js';
import type { ReviewProfileId } from '../visual/review-profile.js';
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

export interface ClientCaptureLibraryProfile {
  readonly coordinate: string;
  readonly sha1: string;
  readonly sha256: string;
  readonly size: number;
  readonly repository: 'https://maven.fabricmc.net/';
}

export interface ClientCaptureProfile {
  readonly protocolVersion: 1;
  readonly authority: 'authoritative_environment_capture';
  readonly javaMajor: 25;
  readonly graphicsBackend: 'opengl';
  readonly loader: {
    readonly version: '0.19.3';
    readonly mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient';
    readonly profileUrl: string;
    readonly libraries: readonly ClientCaptureLibraryProfile[];
  };
  readonly captureMod: {
    readonly id: 'packwright_capture';
    readonly version: string;
    readonly protocolVersion: 1;
    /** Package-relative, immutable distribution path. */
    readonly runtimePath: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly reviewProfiles: Readonly<Record<ReviewProfileId, ClientCaptureReviewSupport>>;
  readonly redistributableMinecraftArtifacts: false;
}

export interface VersionProfile {
  readonly minecraftVersion: MinecraftVersion;
  readonly dataPack: DataPackProfile;
  readonly resourcePack: ResourcePackProfile;
  readonly visualCapabilities: VisualCapabilityProfile;
  readonly clientCapture: ClientCaptureProfile;
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

const fabricLibrary = (
  coordinate: string,
  sha1: string,
  sha256: string,
  size: number,
): ClientCaptureLibraryProfile =>
  Object.freeze({
    coordinate,
    sha1,
    sha256,
    size,
    repository: 'https://maven.fabricmc.net/',
  });

export const MINECRAFT_26_2_CLIENT_CAPTURE: ClientCaptureProfile = Object.freeze({
  protocolVersion: 1,
  authority: 'authoritative_environment_capture',
  javaMajor: 25,
  graphicsBackend: 'opengl',
  loader: Object.freeze({
    version: '0.19.3',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    profileUrl: 'https://meta.fabricmc.net/v2/versions/loader/26.2/0.19.3/profile/json',
    libraries: Object.freeze([
      fabricLibrary(
        'org.ow2.asm:asm:9.10.1',
        'ada2141c0cc52ee8f5c48cd5fa4ce0e794f22236',
        'ed825d10ab1399c8c0cb669e688cf0c8c82629b4c8399b58352b68e92ca10fcb',
        126_151,
      ),
      fabricLibrary(
        'org.ow2.asm:asm-analysis:9.10.1',
        '8d49f14d51f632cb1d87c88d1ceaf50db0d8af1b',
        'dede75a21306b65974ecd8f87114ff6970f09fb794157a4ca09ab25c888c2bfc',
        35_140,
      ),
      fabricLibrary(
        'org.ow2.asm:asm-commons:9.10.1',
        '4229e4c55fd8e01c23f9fe9884075cc628aacc50',
        '6d0abefb7cbf972ea16edb37ec14835372505063a45f976ab7ea889ed9497895',
        74_840,
      ),
      fabricLibrary(
        'org.ow2.asm:asm-tree:9.10.1',
        'e244332a17564c1d1572449399a842de35881be2',
        '3dfb0d5b6a106cd40b5b250e39935fbf2f927f4477546a5369a3ac609cf0506b',
        51_958,
      ),
      fabricLibrary(
        'org.ow2.asm:asm-util:9.10.1',
        '7bb9d450e8d4cbf9f9e04096c44bbfe7fba80b15',
        '1bb99d091fba2597dc6d51193e9bbcf0d8447e7ed96bd8f0198b18152f09655c',
        95_628,
      ),
      fabricLibrary(
        'net.fabricmc:sponge-mixin:0.17.3+mixin.0.8.7',
        '41c4a3984a80f4679e759fb9f495587acc5cdac7',
        '9e90efec71d2bad5b96c9089f019d14a8603227d3c5f408d12f53fae89d99d41',
        1_540_060,
      ),
      fabricLibrary(
        'net.fabricmc:fabric-loader:0.19.3',
        '354dfaa02d0552e11867f85dff7cdbfaf813ba3e',
        '73eed8c34bbad0320a2a3cba5346351e822f74f82b3f3c060574068474132958',
        1_976_502,
      ),
    ]),
  }),
  captureMod: Object.freeze({
    id: 'packwright_capture',
    version: '0.4.0',
    protocolVersion: 1,
    runtimePath: 'capture-mod/runtime/packwright-capture-mod-0.4.0.jar',
    sha256: '761ebb99192d2c19f79cc309d0daee5a652d38669e6e7d6286043597cb54bf76',
    size: 93_307,
  }),
  reviewProfiles: CLIENT_CAPTURE_REVIEW_SUPPORT,
  redistributableMinecraftArtifacts: false,
});

export const MINECRAFT_26_2: VersionProfile = Object.freeze({
  minecraftVersion: '26.2',
  dataPack: MINECRAFT_26_2_DATA_PACK,
  resourcePack: MINECRAFT_26_2_RESOURCE_PACK,
  visualCapabilities: MINECRAFT_26_2_VISUAL_CAPABILITIES,
  clientCapture: MINECRAFT_26_2_CLIENT_CAPTURE,
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
