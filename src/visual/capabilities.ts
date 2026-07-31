import type {
  VisualCapability,
  VisualCapabilityProfile,
  VisualCapabilityStatus,
  VisualCompilerSupport,
  VisualTarget,
} from '../core/types.js';

export const VISUAL_TARGETS = [
  'custom_item',
  'conditional_item_state',
  'existing_block_appearance',
  'new_block_identity',
  'furniture_static_prop',
  'armor_equipment',
  'painting_trim_variant',
  'existing_mob_texture',
  'existing_mob_geometry',
  'new_mob_pet',
  'skeletal_animated_creature',
  'projectile_spell_visual',
  'new_particle_type',
  'gui_font_sprite',
] as const satisfies readonly VisualTarget[];

const COMPILER_SUPPORT = Object.freeze({
  custom_item: 'full',
  conditional_item_state: 'limited',
  existing_block_appearance: 'unsupported',
  new_block_identity: 'unsupported',
  furniture_static_prop: 'unsupported',
  armor_equipment: 'unsupported',
  painting_trim_variant: 'unsupported',
  existing_mob_texture: 'unsupported',
  existing_mob_geometry: 'unsupported',
  new_mob_pet: 'unsupported',
  skeletal_animated_creature: 'unsupported',
  projectile_spell_visual: 'unsupported',
  new_particle_type: 'unsupported',
  gui_font_sprite: 'unsupported',
} as const satisfies Readonly<Record<VisualTarget, VisualCompilerSupport>>);

function capability(value: Omit<VisualCapability, 'compilerSupport'>): VisualCapability {
  return Object.freeze({
    ...value,
    compilerSupport: COMPILER_SUPPORT[value.target],
    strategies: Object.freeze([...value.strategies]),
  });
}

/**
 * Truthful vanilla capability boundary for the Minecraft 26.2 profile.
 *
 * `simulated` means Packwright can build the requested presentation from
 * vanilla carriers or display entities; it never means a new block, entity,
 * projectile, or particle identity is registered with the game.
 */
export const MINECRAFT_26_2_VISUAL_CAPABILITIES: VisualCapabilityProfile = Object.freeze({
  custom_item: capability({
    target: 'custom_item',
    status: 'native',
    support: 'full',
    strategies: ['item_component_item_model', 'client_item_definition'],
    nativeIdentity: false,
    disclosure:
      'The custom item uses a vanilla base item plus minecraft:item_model; it is not a newly registered item type.',
    limitation: 'Uses a vanilla base item as the inventory and gameplay carrier.',
  }),
  conditional_item_state: capability({
    target: 'conditional_item_state',
    status: 'native',
    support: 'full',
    strategies: ['condition', 'select', 'range_dispatch', 'composite_item_model'],
    nativeIdentity: false,
  }),
  existing_block_appearance: capability({
    target: 'existing_block_appearance',
    status: 'replacement',
    support: 'full',
    strategies: ['blockstate_variant', 'blockstate_multipart', 'block_model'],
    nativeIdentity: false,
    disclosure:
      'This changes or selects the appearance of an existing vanilla block; it does not register a new block identity.',
  }),
  new_block_identity: capability({
    target: 'new_block_identity',
    status: 'simulated',
    support: 'limited',
    strategies: ['carrier_block_state', 'block_display_rig'],
    nativeIdentity: false,
    disclosure:
      'Vanilla resource packs cannot register a new block. Packwright can only simulate one with a carrier state or display entities.',
    limitation:
      'Carrier collisions and display-entity interaction behavior differ from a native block.',
  }),
  furniture_static_prop: capability({
    target: 'furniture_static_prop',
    status: 'simulated',
    support: 'full',
    strategies: ['item_display_rig', 'block_display_rig', 'interaction_hitbox'],
    nativeIdentity: false,
    disclosure:
      'The prop is a display-entity assembly with optional interaction entities, not a newly registered block or entity.',
  }),
  armor_equipment: capability({
    target: 'armor_equipment',
    status: 'native',
    support: 'full',
    strategies: ['equipment_asset', 'equippable_component', 'item_model'],
    nativeIdentity: true,
    limitation:
      'Only equipment layers, slots, and behavior exposed by Minecraft 26.2 are available.',
  }),
  painting_trim_variant: capability({
    target: 'painting_trim_variant',
    status: 'native',
    support: 'full',
    strategies: ['datapack_registry_resource', 'resource_pack_texture_asset'],
    nativeIdentity: true,
  }),
  existing_mob_texture: capability({
    target: 'existing_mob_texture',
    status: 'replacement',
    support: 'limited',
    strategies: ['data_driven_variant', 'vanilla_texture_replacement'],
    nativeIdentity: false,
    disclosure:
      'This supplies a variant or replacement texture for an existing mob identity and geometry.',
    limitation:
      'Availability depends on the data-driven variants exposed for that mob in Minecraft 26.2.',
  }),
  existing_mob_geometry: capability({
    target: 'existing_mob_geometry',
    status: 'requires_mod',
    support: 'unsupported',
    strategies: ['future_mod_adapter'],
    nativeIdentity: false,
    disclosure:
      'Vanilla resource packs do not provide a general mechanism for replacing mob geometry. A mod is required for true geometry changes.',
  }),
  new_mob_pet: capability({
    target: 'new_mob_pet',
    status: 'simulated',
    support: 'limited',
    strategies: ['invisible_carrier', 'display_entity_rig', 'interaction_hitbox'],
    nativeIdentity: false,
    disclosure:
      'The creature is an existing invisible carrier plus a display rig and datapack behavior, not a newly registered entity type.',
    limitation:
      'Pathfinding, hitboxes, attributes, and networking remain those of vanilla carrier entities.',
  }),
  skeletal_animated_creature: capability({
    target: 'skeletal_animated_creature',
    status: 'simulated',
    support: 'limited',
    strategies: ['hierarchical_display_rig', 'datapack_keyframes'],
    nativeIdentity: false,
    disclosure:
      'Animation is implemented by transformed display entities and datapack keyframes, not a native skeletal model.',
    limitation:
      'Entity count and command updates impose practical animation and performance limits.',
  }),
  projectile_spell_visual: capability({
    target: 'projectile_spell_visual',
    status: 'simulated',
    support: 'full',
    strategies: ['item_display_composite', 'block_display_composite', 'existing_particles'],
    nativeIdentity: false,
    disclosure:
      'The visual is attached to an existing projectile or display carrier; it does not register a new projectile type.',
  }),
  new_particle_type: capability({
    target: 'new_particle_type',
    status: 'requires_mod',
    support: 'unsupported',
    strategies: ['existing_particle_palette', 'display_entity_approximation', 'future_mod_adapter'],
    nativeIdentity: false,
    disclosure:
      'Vanilla cannot register arbitrary particle types. Existing particles or display entities are approximations; a mod is required for a real new particle type.',
  }),
  gui_font_sprite: capability({
    target: 'gui_font_sprite',
    status: 'native',
    support: 'full',
    strategies: ['gui_texture', 'font_provider', 'sprite_atlas'],
    nativeIdentity: true,
  }),
});

export function isVisualTarget(value: string): value is VisualTarget {
  return (VISUAL_TARGETS as readonly string[]).includes(value);
}

export function getVisualCapability(
  target: VisualTarget,
  profile: VisualCapabilityProfile = MINECRAFT_26_2_VISUAL_CAPABILITIES,
): VisualCapability {
  return profile[target];
}

export function listVisualCapabilities(
  profile: VisualCapabilityProfile = MINECRAFT_26_2_VISUAL_CAPABILITIES,
  status?: VisualCapabilityStatus,
): readonly VisualCapability[] {
  return VISUAL_TARGETS.map((target) => profile[target]).filter(
    (entry) => status === undefined || entry.status === status,
  );
}
