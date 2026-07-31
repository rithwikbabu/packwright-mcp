import type { VisualCapabilityStatus } from '../core/types.js';
import type {
  ClientCaptureRepresentation,
  ClientCaptureTargetKind,
} from '../minecraft/client-capture-protocol.js';
import type { ReviewProfileId } from './review-profile.js';

export type ClientCaptureReviewSupport = 'full' | 'limited' | 'unsupported';
export type ClientCaptureStrategy = ClientCaptureRepresentation['strategy'];

export interface ClientCaptureSupportDescriptor {
  readonly profileId: ReviewProfileId;
  readonly targetKind?: ClientCaptureTargetKind | undefined;
  readonly support: ClientCaptureReviewSupport;
  readonly strategies: readonly ClientCaptureStrategy[];
  readonly capabilityStatuses: readonly VisualCapabilityStatus[];
  readonly disclosure: string;
  readonly limitation?: string | undefined;
  readonly rejectionReason?: string | undefined;
}

const descriptor = (value: ClientCaptureSupportDescriptor): ClientCaptureSupportDescriptor =>
  Object.freeze({
    ...value,
    strategies: Object.freeze([...value.strategies]),
    capabilityStatuses: Object.freeze([...value.capabilityStatuses]),
  });

/**
 * Single truthful policy map for official-client evidence. CPU review support
 * is deliberately irrelevant here: only listed strict representations may be
 * lowered into the protocol-v3 capture studio.
 */
export const CLIENT_CAPTURE_SUPPORT_DESCRIPTORS: Readonly<
  Record<ReviewProfileId, ClientCaptureSupportDescriptor>
> = Object.freeze({
  held_item: descriptor({
    profileId: 'held_item',
    targetKind: 'held_item',
    support: 'limited',
    strategies: ['item_stack'],
    capabilityStatuses: ['native'],
    disclosure:
      'Captures the exact component-bearing vanilla item stack in normal first- and third-person gameplay.',
    limitation: 'Two-handed secondary-grip posing is not authoritative in this release.',
  }),
  gui_item: descriptor({
    profileId: 'gui_item',
    targetKind: 'gui_item',
    support: 'full',
    strategies: ['item_stack'],
    capabilityStatuses: ['native'],
    disclosure:
      'Captures the exact vanilla item stack through Minecraft inventory and HUD renderers.',
  }),
  block: descriptor({
    profileId: 'block',
    targetKind: 'block',
    support: 'limited',
    strategies: ['native_block_state', 'block_display'],
    capabilityStatuses: ['replacement', 'simulated'],
    disclosure:
      'native_block_state is an existing vanilla block-state/resource-pack binding; block_display is a simulated visual and never a new block identity.',
    limitation:
      'Vanilla cannot register an arbitrary new block identity; matrices are bounded to explicitly declared states, and protocol v3 does not claim a controllable global animated-texture phase.',
  }),
  head_wearable: descriptor({
    profileId: 'head_wearable',
    targetKind: 'headwear',
    support: 'limited',
    strategies: ['equippable_head'],
    capabilityStatuses: ['native', 'replacement'],
    disclosure:
      'Captures an actually equipped minecraft:equippable head item and records whether Minecraft uses fallback item rendering or an equipment model.',
    limitation:
      'Only head-slot behavior and equipment layers exposed by Minecraft 26.2 are supported.',
  }),
  entity_model: descriptor({
    profileId: 'entity_model',
    targetKind: 'entity',
    support: 'limited',
    strategies: ['native_entity', 'display_rig'],
    capabilityStatuses: ['replacement', 'simulated'],
    disclosure:
      'native_entity captures an allow-listed existing vanilla entity and supported variant; display_rig is a simulated composite, not a new entity type.',
    limitation:
      'Native capture is limited to the explicit 26.2 entity allow-list; simulated rigs require separate exact idle, walk, and attack states and do not claim tick-driven animation.',
  }),
  placeable: descriptor({
    profileId: 'placeable',
    targetKind: 'placeable',
    support: 'limited',
    strategies: ['native_placeable_block', 'native_placeable_entity', 'display_rig'],
    capabilityStatuses: ['native', 'replacement', 'simulated'],
    disclosure:
      'Native fixtures remain their actual vanilla block/entity identity; display rigs are compiler-declared simulations with optional interaction dimensions.',
    limitation:
      'Display rigs have no native block identity or collision and accept only allow-listed static declarative nodes; interpolation capture is not authoritative in protocol v3.',
  }),
  projectile: descriptor({
    profileId: 'projectile',
    support: 'unsupported',
    strategies: [],
    capabilityStatuses: ['simulated'],
    disclosure:
      'The CPU projectile profile is advisory and is not authoritative Minecraft-client evidence.',
    rejectionReason:
      'No strict projectile carrier representation or runtime executor is implemented.',
  }),
  armor: descriptor({
    profileId: 'armor',
    support: 'unsupported',
    strategies: [],
    capabilityStatuses: ['native'],
    disclosure:
      'The CPU armor profile is advisory and is not authoritative Minecraft-client evidence.',
    rejectionReason: 'A strict multi-slot equipment representation is not implemented.',
  }),
});

export const CLIENT_CAPTURE_REVIEW_SUPPORT = Object.freeze(
  Object.fromEntries(
    Object.entries(CLIENT_CAPTURE_SUPPORT_DESCRIPTORS).map(([profileId, value]) => [
      profileId,
      value.support,
    ]),
  ) as Readonly<Record<ReviewProfileId, ClientCaptureReviewSupport>>,
);

export function clientCaptureSupportDescriptor(
  profileId: ReviewProfileId,
): ClientCaptureSupportDescriptor {
  return CLIENT_CAPTURE_SUPPORT_DESCRIPTORS[profileId];
}

export function clientCaptureReviewSupport(profileId: ReviewProfileId): ClientCaptureReviewSupport {
  return clientCaptureSupportDescriptor(profileId).support;
}

export function assertClientCaptureReviewSupport(profileId: ReviewProfileId): void {
  const descriptor = clientCaptureSupportDescriptor(profileId);
  if (descriptor.support === 'unsupported') {
    throw new Error(
      `Review profile '${profileId}' cannot produce authoritative Minecraft-client evidence: ${descriptor.rejectionReason ?? 'unsupported strict representation'}`,
    );
  }
}

export function assertClientCaptureStrategySupport(
  profileId: ReviewProfileId,
  strategy: ClientCaptureStrategy,
): void {
  const descriptor = clientCaptureSupportDescriptor(profileId);
  assertClientCaptureReviewSupport(profileId);
  if (!descriptor.strategies.includes(strategy)) {
    throw new Error(
      `Review profile '${profileId}' does not support client capture strategy '${strategy}'. Allowed strategies: ${descriptor.strategies.join(', ')}.`,
    );
  }
}
