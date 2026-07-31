import { describe, expect, it } from 'vitest';

import {
  ProjectBuildInputSchema,
  TextureImportInputSchema,
  VisualClientCaptureInputSchema,
  VisualClientCaptureResultSchema,
  type VisualClientCaptureResult,
  VisualConnectInputSchema,
  VisualDraftIdSchema,
  VisualProjectIdSchema,
  VisualRevisionCreateInputSchema,
} from '../../src/mcp/visual-schemas.js';

const CONTENT_ID = 'a'.repeat(64);
const REQUIRED_CAPTURE_VIEW = 'first_person_vanilla--first-person-right-steve';
const SUPPLEMENTAL_CAPTURE_VIEW = 'first_person_scale_reference--first-person-right-steve';

function captureResult(): VisualClientCaptureResult {
  const file = (name: string) => ({
    path: `visual-runs/${CONTENT_ID}/captures/${name}.png`,
    sha256: CONTENT_ID,
    size: 64,
    mediaType: 'image/png',
    role: 'render' as const,
  });
  const view = (name: string, scaleReference: boolean) => ({
    name,
    baseSceneId: 'first-person-right-steve',
    targetKind: 'held_item' as const,
    representationSha256: CONTENT_ID,
    viewKind: scaleReference
      ? ('first_person_scale_reference' as const)
      : ('first_person_vanilla' as const),
    authority: scaleReference
      ? ('augmented_qa_reference' as const)
      : ('authoritative_environment_capture' as const),
    requiredForAuthority: !scaleReference,
    width: 1280,
    height: 720,
    sourceSha256: CONTENT_ID,
    normalizedSha256: CONTENT_ID,
    bytes: 64,
    uri: `https://example.invalid/${name}`,
  });
  return {
    protocolVersion: 3 as const,
    ok: true,
    status: 'passed' as const,
    authority: 'authoritative_environment_capture' as const,
    authorityScope: 'required_views_only' as const,
    projectId: 'firestaff',
    runId: CONTENT_ID,
    revisionId: CONTENT_ID,
    reviewProfile: 'held_item' as const,
    profileVersion: 1,
    targetKind: 'held_item' as const,
    representationSha256: CONTENT_ID,
    studioSha256: CONTENT_ID,
    representationStrategy: 'item_stack' as const,
    representationCapability: 'native' as const,
    representationDisclosure:
      'This is the exact vanilla carrier item stack; it does not register a new item type.',
    proposalBindingStatus: 'implemented' as const,
    proposalBindingReason: 'The exact held-item representation is implemented by the proposal.',
    clientCaptureSupport: 'limited' as const,
    clientCaptureStrategies: ['item_stack'],
    captureReady: true,
    contactSheet: file('contact'),
    contactSheetUri: 'https://example.invalid/contact',
    supplementalContactSheet: file('supplemental-contact'),
    supplementalContactSheetUri: 'https://example.invalid/supplemental-contact',
    views: [view(REQUIRED_CAPTURE_VIEW, false), view(SUPPLEMENTAL_CAPTURE_VIEW, true)],
    requiredViewIds: [REQUIRED_CAPTURE_VIEW],
    supplementalViewIds: [SUPPLEMENTAL_CAPTURE_VIEW],
    measurements: [
      {
        id: 'frame-retention',
        metric: 'frame_retention' as const,
        sceneIds: [REQUIRED_CAPTURE_VIEW],
        authority: 'client_pixels' as const,
        requiredForReadiness: false,
        status: 'passed' as const,
        unit: 'ratio' as const,
        value: 1,
        message: 'All authored pixels remain inside the captured framebuffer.',
        sourcePngSha256s: [CONTENT_ID],
      },
    ],
    diagnostics: [],
  };
}

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

  it('accepts strict targeted repairs for every non-held review profile', () => {
    const repairs = [
      {
        kind: 'block_review',
        value: { adjacentBlocks: true, lightingChecks: true, cullingChecks: false },
      },
      {
        kind: 'placeable_review',
        value: {
          orientations: ['north'],
          attachments: ['floor'],
          footprint: [16, 16],
        },
      },
      {
        kind: 'armor_review',
        value: { slots: ['head'], bodyVariants: ['alex'], poses: ['walking'] },
      },
      {
        kind: 'head_wearable_review',
        value: { bodyVariants: ['steve'], firstPersonObstruction: true, armorStand: false },
      },
      {
        kind: 'projectile_review',
        value: { forwardAxis: [0, 0, -1], inHand: true, impact: true, stuckDepth: 2 },
      },
      {
        kind: 'gui_item_review',
        value: { counts: [1, 64], durability: true, glint: true, tooltip: 'Item' },
      },
      {
        kind: 'entity_model_review',
        value: {
          hitbox: [8, 16, 8],
          animationPoses: ['idle'],
          playerScaleReference: true,
        },
      },
    ];

    for (const repair of repairs) {
      expect(
        VisualRevisionCreateInputSchema.safeParse({
          projectId: 'firestaff',
          runId: CONTENT_ID,
          parentRevisionId: 'b'.repeat(64),
          expectedSpecSha256: 'c'.repeat(64),
          instructions: 'Targeted profile repair',
          repairs: [repair],
        }).success,
      ).toBe(true);
    }
    expect(
      VisualRevisionCreateInputSchema.safeParse({
        projectId: 'firestaff',
        runId: CONTENT_ID,
        parentRevisionId: 'b'.repeat(64),
        expectedSpecSha256: 'c'.repeat(64),
        instructions: 'Reject an unbounded repair field',
        repairs: [
          {
            kind: 'block_review',
            value: { adjacentBlocks: true, lightingChecks: true, cullingChecks: true, extra: true },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts only strict declarative capture representations and bounded QA switches', () => {
    const base = {
      projectId: 'firestaff',
      runId: CONTENT_ID,
      proposalSha256: CONTENT_ID,
      confirm: true,
    };
    const blockRepresentation = {
      targetKind: 'block',
      strategy: 'native_block_state',
      capability: 'replacement',
      states: {
        default: { blockState: { id: 'minecraft:stone', properties: {} } },
      },
      review: {
        transparency: false,
        biomeTintBiomes: [],
        animatedTextureTicks: [],
      },
    };

    expect(
      VisualClientCaptureInputSchema.parse({
        ...base,
        representation: blockRepresentation,
      }),
    ).toMatchObject({
      representation: blockRepresentation,
      includeDebugHitboxViews: false,
      includeScaleReferenceViews: false,
    });

    const displayRigRepresentation = {
      targetKind: 'placeable',
      strategy: 'display_rig',
      capability: 'simulated',
      states: {
        default: {
          displayRig: {
            nodes: [
              {
                id: 'body',
                kind: 'block_display',
                position: [0, 64, 0],
                yaw: 0,
                pitch: 0,
                transform: {
                  translation: [0, 0, 0],
                  leftRotation: [0, 0, 0],
                  scale: [1, 1, 1],
                  rightRotation: [0, 0, 0],
                },
                billboard: 'fixed',
                brightness: { block: 15, sky: 15 },
                shadow: { radius: 0.5, strength: 1 },
                interpolation: { duration: 0, startDelta: 0 },
                blockState: { id: 'minecraft:stone', properties: {} },
              },
            ],
          },
        },
      },
      review: {
        orientations: ['north', 'east', 'south', 'west'],
        attachments: ['floor', 'wall', 'ceiling'],
        placementStates: ['north', 'east', 'south', 'west'].flatMap((orientation) =>
          ['floor', 'wall', 'ceiling'].map((attachment) => ({
            orientation,
            attachment,
            stateId: 'default',
          })),
        ),
      },
    };
    expect(
      VisualClientCaptureInputSchema.safeParse({
        ...base,
        representation: displayRigRepresentation,
        includeDebugHitboxViews: true,
        displaySettlingTicks: 2,
      }).success,
    ).toBe(true);
    expect(
      VisualClientCaptureInputSchema.safeParse({
        ...base,
        representation: blockRepresentation,
        displaySettlingTicks: 2,
      }).success,
    ).toBe(false);
    expect(
      VisualClientCaptureInputSchema.safeParse({
        ...base,
        includeDebugHitboxViews: true,
      }).success,
    ).toBe(false);
    expect(
      VisualClientCaptureInputSchema.safeParse({
        ...base,
        representation: blockRepresentation,
        includeScaleReferenceViews: true,
      }).success,
    ).toBe(false);
    expect(
      VisualClientCaptureInputSchema.safeParse({
        ...base,
        representation: {
          targetKind: 'block',
          strategy: 'block_display',
          capability: 'simulated',
          states: {
            default: {
              blockDisplay: displayRigRepresentation.states.default.displayRig.nodes[0],
            },
          },
          review: {
            transparency: false,
            biomeTintBiomes: [],
            animatedTextureTicks: [],
          },
        },
        displaySettlingTicks: 4,
      }).success,
    ).toBe(true);

    for (const forbidden of [
      { command: 'summon minecraft:pig' },
      { function: 'example:setup' },
      { savePath: '/Users/example/world' },
      { modPath: '/tmp/untrusted.jar' },
      { credentials: 'secret' },
    ]) {
      expect(
        VisualClientCaptureInputSchema.safeParse({
          ...base,
          representation: { ...blockRepresentation, ...forbidden },
        }).success,
      ).toBe(false);
    }
  });
});

describe('visual client-capture result schema', () => {
  it('scopes top-level authority to required views in a mixed result', () => {
    const parsed = VisualClientCaptureResultSchema.parse(captureResult());

    expect(parsed.authority).toBe('authoritative_environment_capture');
    expect(parsed.authorityScope).toBe('required_views_only');
    expect(parsed.views.map((view) => view.authority)).toEqual([
      'authoritative_environment_capture',
      'augmented_qa_reference',
    ]);
  });

  it('rejects inconsistent view kinds, per-view authority, and authority classification', () => {
    const invalidResults = [
      (() => {
        const result = captureResult();
        result.views = result.views.map((view) =>
          view.name === SUPPLEMENTAL_CAPTURE_VIEW
            ? { ...view, authority: 'authoritative_environment_capture' as const }
            : view,
        );
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.views = result.views.map((view) =>
          view.name === SUPPLEMENTAL_CAPTURE_VIEW ? { ...view, requiredForAuthority: true } : view,
        );
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.requiredViewIds = [SUPPLEMENTAL_CAPTURE_VIEW];
        result.supplementalViewIds = [REQUIRED_CAPTURE_VIEW];
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.supplementalViewIds = [];
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.requiredViewIds = [REQUIRED_CAPTURE_VIEW, REQUIRED_CAPTURE_VIEW];
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.views = result.views.map((view) =>
          view.name === REQUIRED_CAPTURE_VIEW
            ? { ...view, representationSha256: 'b'.repeat(64) }
            : view,
        );
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.views = result.views.map((view) =>
          view.name === REQUIRED_CAPTURE_VIEW ? { ...view, targetKind: 'entity' as const } : view,
        );
        return result;
      })(),
      (() => {
        const result = captureResult();
        result.status = 'failed';
        return result;
      })(),
    ];

    for (const result of invalidResults) {
      expect(VisualClientCaptureResultSchema.safeParse(result).success).toBe(false);
    }
  });

  it('requires the supplemental sheet and URI exactly for supplemental views', () => {
    const missingSheet = captureResult();
    delete (missingSheet as Partial<typeof missingSheet>).supplementalContactSheet;
    expect(VisualClientCaptureResultSchema.safeParse(missingSheet).success).toBe(false);

    const missingUri = captureResult();
    delete (missingUri as Partial<typeof missingUri>).supplementalContactSheetUri;
    expect(VisualClientCaptureResultSchema.safeParse(missingUri).success).toBe(false);

    const vanillaOnly = captureResult();
    vanillaOnly.views = vanillaOnly.views.filter((view) => view.name === REQUIRED_CAPTURE_VIEW);
    vanillaOnly.supplementalViewIds = [];
    delete (vanillaOnly as Partial<typeof vanillaOnly>).supplementalContactSheet;
    delete (vanillaOnly as Partial<typeof vanillaOnly>).supplementalContactSheetUri;
    expect(VisualClientCaptureResultSchema.safeParse(vanillaOnly).success).toBe(true);
  });

  it('classifies debug hitbox frames as supplemental augmented QA only', () => {
    const result = {
      ...captureResult(),
      targetKind: 'entity' as const,
      proposalBindingStatus: 'capture_only' as const,
      proposalBindingReason:
        'The exact entity representation is capture evidence and is not implemented by this proposal.',
      views: captureResult().views.map((view) => ({
        ...view,
        targetKind: 'entity' as const,
        ...(view.name === SUPPLEMENTAL_CAPTURE_VIEW
          ? {
              viewKind: 'debug_hitbox_reference' as const,
              authority: 'augmented_qa_reference' as const,
              requiredForAuthority: false,
            }
          : { viewKind: 'minecraft_vanilla' as const }),
      })),
    };
    expect(VisualClientCaptureResultSchema.safeParse(result).success).toBe(true);

    const invalid = {
      ...result,
      views: result.views.map((view) =>
        view.viewKind === 'debug_hitbox_reference'
          ? {
              ...view,
              authority: 'authoritative_environment_capture' as const,
              requiredForAuthority: true,
            }
          : view,
      ),
      requiredViewIds: [REQUIRED_CAPTURE_VIEW, SUPPLEMENTAL_CAPTURE_VIEW],
      supplementalViewIds: [],
      supplementalContactSheet: undefined,
      supplementalContactSheetUri: undefined,
    };
    expect(VisualClientCaptureResultSchema.safeParse(invalid).success).toBe(false);
  });

  it('classifies measurement controls as supplemental augmented QA only', () => {
    const controlView = 'measurement_control--block-hero';
    const result = {
      ...captureResult(),
      reviewProfile: 'block' as const,
      targetKind: 'block' as const,
      representationStrategy: 'native_block_state' as const,
      representationCapability: 'replacement' as const,
      proposalBindingStatus: 'capture_only' as const,
      proposalBindingReason:
        'The exact block representation is capture evidence and is not implemented by this proposal.',
      clientCaptureStrategies: ['native_block_state'],
      views: captureResult().views.map((view) =>
        view.name === SUPPLEMENTAL_CAPTURE_VIEW
          ? {
              ...view,
              name: controlView,
              baseSceneId: 'block-hero',
              targetKind: 'block' as const,
              viewKind: 'measurement_control' as const,
              authority: 'augmented_qa_reference' as const,
              requiredForAuthority: false,
            }
          : {
              ...view,
              name: 'block-hero',
              baseSceneId: 'block-hero',
              targetKind: 'block' as const,
              viewKind: 'minecraft_vanilla' as const,
            },
      ),
      requiredViewIds: ['block-hero'],
      supplementalViewIds: [controlView],
    };

    expect(VisualClientCaptureResultSchema.safeParse(result).success).toBe(true);

    const invalid = {
      ...result,
      views: result.views.map((view) =>
        view.viewKind === 'measurement_control'
          ? {
              ...view,
              authority: 'authoritative_environment_capture' as const,
              requiredForAuthority: true,
            }
          : view,
      ),
      requiredViewIds: ['block-hero', controlView],
      supplementalViewIds: [],
      supplementalContactSheet: undefined,
      supplementalContactSheetUri: undefined,
    };
    expect(VisualClientCaptureResultSchema.safeParse(invalid).success).toBe(false);
  });
});
