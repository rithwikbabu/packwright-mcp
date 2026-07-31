import { describe, expect, it } from 'vitest';

import {
  ProjectBuildInputSchema,
  TextureImportInputSchema,
  VisualClientCaptureResultSchema,
  VisualConnectInputSchema,
  VisualDraftIdSchema,
  VisualProjectIdSchema,
  VisualRevisionCreateInputSchema,
} from '../../src/mcp/visual-schemas.js';

const CONTENT_ID = 'a'.repeat(64);
const REQUIRED_CAPTURE_VIEW = 'first_person_vanilla--first-person-right-steve';
const SUPPLEMENTAL_CAPTURE_VIEW = 'first_person_scale_reference--first-person-right-steve';

function captureResult() {
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
    ok: true,
    status: 'passed' as const,
    authority: 'authoritative_environment_capture' as const,
    authorityScope: 'required_views_only' as const,
    projectId: 'firestaff',
    runId: CONTENT_ID,
    revisionId: CONTENT_ID,
    reviewProfile: 'held_item' as const,
    profileVersion: 1,
    clientCaptureSupport: 'limited' as const,
    captureReady: true,
    contactSheet: file('contact'),
    contactSheetUri: 'https://example.invalid/contact',
    scaleReferenceContactSheet: file('scale-reference-contact'),
    scaleReferenceContactSheetUri: 'https://example.invalid/scale-reference-contact',
    views: [view(REQUIRED_CAPTURE_VIEW, false), view(SUPPLEMENTAL_CAPTURE_VIEW, true)],
    requiredViewIds: [REQUIRED_CAPTURE_VIEW],
    supplementalViewIds: [SUPPLEMENTAL_CAPTURE_VIEW],
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
    ];

    for (const result of invalidResults) {
      expect(VisualClientCaptureResultSchema.safeParse(result).success).toBe(false);
    }
  });

  it('requires the scale-reference sheet and URI exactly for supplemental views', () => {
    const missingSheet = captureResult();
    delete (missingSheet as Partial<typeof missingSheet>).scaleReferenceContactSheet;
    expect(VisualClientCaptureResultSchema.safeParse(missingSheet).success).toBe(false);

    const missingUri = captureResult();
    delete (missingUri as Partial<typeof missingUri>).scaleReferenceContactSheetUri;
    expect(VisualClientCaptureResultSchema.safeParse(missingUri).success).toBe(false);

    const vanillaOnly = captureResult();
    vanillaOnly.views = vanillaOnly.views.filter((view) => view.name === REQUIRED_CAPTURE_VIEW);
    vanillaOnly.supplementalViewIds = [];
    delete (vanillaOnly as Partial<typeof vanillaOnly>).scaleReferenceContactSheet;
    delete (vanillaOnly as Partial<typeof vanillaOnly>).scaleReferenceContactSheetUri;
    expect(VisualClientCaptureResultSchema.safeParse(vanillaOnly).success).toBe(true);
  });
});
