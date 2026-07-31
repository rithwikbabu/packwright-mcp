import { afterEach, describe, expect, it } from 'vitest';

import { createDatapack } from '../../src/core/authoring.js';
import { sha256Buffer } from '../../src/core/hash.js';
import {
  VisualProjectAttachInputSchema,
  VisualRenderInputSchema,
  VisualRevisionCreateInputSchema,
  VisualSpecUpsertInputSchema,
} from '../../src/mcp/visual-schemas.js';
import { VisualWorkflow } from '../../src/visual/workflow.js';
import { temporaryWorkspace } from '../core/helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const reviewableItem = {
  id: 'arcana:review_wand',
  targetKind: 'item',
  template: 'handheld_3d',
  materials: { wood: { color: '#6b4326' } },
  parts: [
    {
      id: 'handle',
      shape: 'cuboid',
      from: [7, 1, 7],
      to: [9, 15, 9],
      material: 'wood',
    },
  ],
  displayPreset: 'handheld_3d',
  reviewProfile: 'held_item',
  heldItem: {
    primaryGrip: [8, 5.5, 11],
    handedness: 'either',
    twoHanded: false,
    itemKind: 'generic',
    usePose: 'none',
  },
} as const;

async function renderedFixture() {
  const temporary = await temporaryWorkspace();
  cleanups.push(temporary.cleanup);
  await createDatapack(temporary.workspace, {
    packPath: 'review-data',
    namespace: 'arcana',
    description: 'Review-profile fixture',
  });
  const workflow = new VisualWorkflow(temporary.workspace, `${temporary.root}/cache`);
  await workflow.attachProject(
    VisualProjectAttachInputSchema.parse({
      id: 'reviewwand',
      datapack: 'review-data',
      resourcepack: 'review-assets',
    }),
  );
  const draft = await workflow.upsertSpec(
    VisualSpecUpsertInputSchema.parse({
      projectId: 'reviewwand',
      request: 'A held review wand',
      spec: reviewableItem,
    }),
  );
  const rendered = await workflow.render(
    VisualRenderInputSchema.parse({
      projectId: 'reviewwand',
      runId: draft.runId,
      revisionId: draft.revisionId,
      viewSize: 32,
    }),
  );
  return { workflow, draft, rendered };
}

describe('visual workflow review-profile evidence', () => {
  it('round-trips an immutable render report with its revision and view identities', async () => {
    const { workflow, draft, rendered } = await renderedFixture();
    const resource = await workflow.readResource({
      kind: 'render_report',
      runId: draft.runId,
      revisionId: draft.revisionId,
    });
    const report = JSON.parse(resource.data.toString('utf8')) as {
      kind: string;
      projectId: string;
      runId: string;
      revisionId: string;
      specSha256: string;
      compiledArtifactId: string;
      rendererVersion: string;
      profileId: string;
      profileVersion: number;
      planSha256: string;
      requiredViewIds: string[];
      reviewReady: boolean;
      views: { id: string; required: boolean; sha256: string }[];
      measurements: unknown[];
    };
    const state = (await workflow.states.read('reviewwand')).revisions[draft.revisionId];

    expect(resource.mimeType).toBe('application/json');
    expect(report).toMatchObject({
      kind: 'packwright.render-profile-report',
      projectId: 'reviewwand',
      runId: draft.runId,
      revisionId: draft.revisionId,
      specSha256: draft.specSha256,
      compiledArtifactId: state?.compiledArtifactId,
      rendererVersion: 'packwright-cpu-v2',
      profileId: 'held_item',
      profileVersion: 1,
      planSha256: state?.render?.review?.planSha256,
      reviewReady: rendered.reviewReady,
    });
    expect(report.requiredViewIds).toEqual(
      rendered.views.filter((view) => view.required).map((view) => view.name),
    );
    expect(report.views).toEqual(
      rendered.views.map((view) => ({
        id: view.name,
        required: view.required,
        width: view.width,
        height: view.height,
        sha256: view.file.sha256,
      })),
    );
    expect(report.measurements).toEqual(rendered.measurements);
    expect(state?.render?.review?.reportSha256).toBe(sha256Buffer(resource.data));
    await expect(
      workflow.readResource({
        kind: 'render_report',
        runId: draft.runId,
        revisionId: draft.revisionId,
      }),
    ).resolves.toEqual(resource);
  });

  it('keeps legacy render state readable while requiring a profile rerender', async () => {
    const { workflow, draft } = await renderedFixture();
    await workflow.states.update('reviewwand', (current) => {
      const active = current.revisions[draft.revisionId];
      if (active?.render === undefined) throw new Error('Rendered fixture is missing.');
      const legacyRender = {
        contactSheet: active.render.contactSheet,
        views: active.render.views,
        pixelSha256: active.render.pixelSha256,
        compiledArtifactId: active.render.compiledArtifactId,
      };
      return {
        ...current,
        revisions: {
          ...current.revisions,
          [draft.revisionId]: { ...active, render: legacyRender },
        },
      };
    });

    const legacy = (await workflow.states.read('reviewwand')).revisions[draft.revisionId];
    expect(legacy?.render?.review).toBeUndefined();
    const validated = await workflow.validateDraft('reviewwand', draft.runId, draft.revisionId);
    expect(validated.readiness).toMatchObject({ rendered: true, reviewProfile: false });
  });

  it('does not inherit render evidence after a held-item metadata repair', async () => {
    const { workflow, draft } = await renderedFixture();
    const parentReport = await workflow.readResource({
      kind: 'render_report',
      runId: draft.runId,
      revisionId: draft.revisionId,
    });
    const repaired = await workflow.revise(
      VisualRevisionCreateInputSchema.parse({
        projectId: 'reviewwand',
        runId: draft.runId,
        parentRevisionId: draft.revisionId,
        expectedSpecSha256: draft.specSha256,
        instructions: 'Move the semantic grip one model pixel upward.',
        repairs: [{ kind: 'held_item', primaryGrip: [8, 6.5, 11] }],
      }),
    );

    const state = await workflow.states.read('reviewwand');
    expect(state.revisions[draft.revisionId]?.render?.review).toBeDefined();
    expect(state.revisions[repaired.revisionId]?.render).toBeUndefined();
    await expect(
      workflow.readResource({
        kind: 'render_report',
        runId: draft.runId,
        revisionId: repaired.revisionId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      workflow.readResource({
        kind: 'render_report',
        runId: draft.runId,
        revisionId: draft.revisionId,
      }),
    ).resolves.toEqual(parentReport);
    expect((await workflow.inspect('reviewwand')).readiness).toMatchObject({
      rendered: false,
      reviewProfile: false,
    });
  });

  it('rejects a stale report reference without relying on private cache paths', async () => {
    const { workflow, draft } = await renderedFixture();
    const resource = await workflow.readResource({
      kind: 'render_report',
      runId: draft.runId,
      revisionId: draft.revisionId,
    });
    const report = JSON.parse(resource.data.toString('utf8')) as Record<string, unknown>;
    const stale = await workflow.runs.putReview(draft.runId, {
      ...report,
      specSha256: 'f'.repeat(64),
    });
    await workflow.states.update('reviewwand', (current) => {
      const active = current.revisions[draft.revisionId];
      if (active?.render?.review === undefined) throw new Error('Rendered fixture is missing.');
      return {
        ...current,
        revisions: {
          ...current.revisions,
          [draft.revisionId]: {
            ...active,
            render: {
              ...active.render,
              review: { ...active.render.review, reportSha256: stale.sha256 },
            },
          },
        },
      };
    });

    await expect(
      workflow.readResource({
        kind: 'render_report',
        runId: draft.runId,
        revisionId: draft.revisionId,
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    const validated = await workflow.validateDraft('reviewwand', draft.runId, draft.revisionId);
    expect(validated.readiness).toMatchObject({ rendered: true, reviewProfile: false });
  });
});
