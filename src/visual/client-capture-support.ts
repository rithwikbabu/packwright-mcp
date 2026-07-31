import type { ReviewProfileId } from './review-profile.js';

export const CLIENT_CAPTURE_REVIEW_SUPPORT = Object.freeze({
  held_item: 'limited',
  gui_item: 'full',
  projectile: 'unsupported',
  head_wearable: 'unsupported',
  block: 'unsupported',
  placeable: 'unsupported',
  armor: 'unsupported',
  entity_model: 'unsupported',
} as const satisfies Readonly<Record<ReviewProfileId, ClientCaptureReviewSupport>>);

export type ClientCaptureReviewSupport = 'full' | 'limited' | 'unsupported';

export function clientCaptureReviewSupport(profileId: ReviewProfileId): ClientCaptureReviewSupport {
  return CLIENT_CAPTURE_REVIEW_SUPPORT[profileId];
}

export function assertClientCaptureReviewSupport(profileId: ReviewProfileId): void {
  const support = clientCaptureReviewSupport(profileId);
  if (support === 'unsupported') {
    throw new Error(
      `Review profile '${profileId}' cannot produce authoritative Minecraft-client evidence until its corresponding compiler and binding strategy are implemented.`,
    );
  }
}
