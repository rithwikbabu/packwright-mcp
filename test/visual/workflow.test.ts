import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatapack } from '../../src/core/authoring.js';
import {
  VisualConnectInputSchema,
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

const fireStaff = {
  id: 'arcana:firestaff',
  targetKind: 'item',
  template: 'handheld_3d',
  textureSize: [32, 32],
  materials: {
    dark_oak: { color: '#4d2f1a' },
    fire_crystal: { color: '#ff6a00', emissive: true, tintIndex: 0 },
  },
  parts: [
    {
      id: 'handle',
      shape: 'cuboid',
      from: [7, 0, 7],
      to: [9, 13, 9],
      material: 'dark_oak',
    },
    {
      id: 'crystal',
      shape: 'cuboid',
      from: [6, 12, 6],
      to: [10, 16, 10],
      material: 'fire_crystal',
      parent: 'handle',
    },
  ],
  displayPreset: 'handheld_3d',
  display: {
    firstperson_righthand: {
      rotation: [0, -90, 25],
      translation: [70, 3, 1],
      scale: [0.68, 0.68, 0.68],
    },
  },
  connection: { carrierItem: 'minecraft:blaze_rod' },
} as const;

describe('paired visual workflow', () => {
  it('drafts, renders, repairs, connects, and atomically commits a custom item', async () => {
    const temporary = await temporaryWorkspace();
    cleanups.push(temporary.cleanup);
    await createDatapack(temporary.workspace, {
      packPath: 'firestaff-data',
      namespace: 'arcana',
      description: 'Fire staff behavior',
    });
    const workflow = new VisualWorkflow(temporary.workspace, path.join(temporary.root, 'cache'));

    const attached = await workflow.attachProject(
      VisualProjectAttachInputSchema.parse({
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
      }),
    );
    expect(attached).toMatchObject({ ok: true, resourcepackCreated: true });
    expect(
      JSON.parse(await readFile(path.join(temporary.root, 'firestaff-assets/pack.mcmeta'), 'utf8')),
    ).toMatchObject({ pack: { min_format: [88, 0], max_format: [88, 0] } });

    const draft = await workflow.upsertSpec(
      VisualSpecUpsertInputSchema.parse({
        projectId: 'firestaff',
        request: 'A crystal fire staff',
        spec: fireStaff,
      }),
    );
    const firstRender = await workflow.render(
      VisualRenderInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: draft.revisionId,
        viewSize: 64,
      }),
    );
    expect(firstRender.views).toHaveLength(15);
    expect(firstRender.contactSheet.size).toBeGreaterThan(100);

    const repaired = await workflow.revise(
      VisualRevisionCreateInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        parentRevisionId: draft.revisionId,
        expectedSpecSha256: draft.specSha256,
        instructions: 'The right-hand view is clipped; reset its translation.',
        repairs: [
          {
            kind: 'display',
            context: 'firstperson_righthand',
            transform: {
              rotation: [0, -90, 25],
              translation: [1.13, 3.2, 1.13],
              scale: [0.68, 0.68, 0.68],
            },
          },
        ],
      }),
    );
    expect(repaired.parentRevisionId).toBe(draft.revisionId);
    const repairedRender = await workflow.render(
      VisualRenderInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: repaired.revisionId,
        viewSize: 64,
      }),
    );
    expect(repairedRender.pixelSha256).not.toBe(firstRender.pixelSha256);
    const oldRevisionRender = await workflow.render(
      VisualRenderInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: draft.revisionId,
        includeContexts: false,
        viewSize: 64,
      }),
    );
    expect(oldRevisionRender.views).toHaveLength(8);
    expect((await workflow.validateDraft('firestaff')).revisionId).toBe(repaired.revisionId);

    const connected = await workflow.connect(
      VisualConnectInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: repaired.revisionId,
        carrierItem: 'minecraft:blaze_rod',
      }),
    );
    expect(connected.ok).toBe(true);
    expect(connected.proposalSha256).toMatch(/^[a-f0-9]{64}$/u);
    const originalStateUpdate = workflow.states.update.bind(workflow.states);
    let stateUpdates = 0;
    const failedCacheWrite = vi
      .spyOn(workflow.states, 'update')
      .mockImplementation(async (projectId, mutate) => {
        stateUpdates += 1;
        if (stateUpdates === 2) throw new Error('simulated cache write interruption');
        return await originalStateUpdate(projectId, mutate);
      });
    const committed = await workflow.commit(
      'firestaff',
      draft.runId,
      repaired.revisionId,
      connected.proposalSha256 ?? '',
    );
    failedCacheWrite.mockRestore();
    expect(
      (await workflow.states.read('firestaff')).revisions[repaired.revisionId]
        ?.committedTransactionId,
    ).toBeUndefined();
    const retried = await new VisualWorkflow(
      temporary.workspace,
      path.join(temporary.root, 'cache'),
    ).commit('firestaff', draft.runId, repaired.revisionId, connected.proposalSha256 ?? '');
    expect(retried.transactionId).toBe(committed.transactionId);
    const reconciled = (await workflow.states.read('firestaff')).revisions[repaired.revisionId];
    expect(reconciled?.committedTransactionId).toBe(committed.transactionId);
    expect(reconciled?.committedReceiptSha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      readFile(
        path.join(
          temporary.root,
          `.packwright/visual-commits/${connected.proposalSha256 ?? ''}.json`,
        ),
        'utf8',
      ),
    ).resolves.toContain(`"transactionId":"${committed.transactionId}"`);
    expect(committed.files.map((file) => file.path)).toContain(
      'firestaff-assets/assets/arcana/items/firestaff.json',
    );
    expect(
      await readFile(
        path.join(
          temporary.root,
          'firestaff-data/data/arcana/function/packwright/give/firestaff.mcfunction',
        ),
        'utf8',
      ),
    ).toBe('give @s minecraft:blaze_rod[minecraft:item_model="arcana:firestaff"] 1\n');
    expect(
      (
        await stat(
          path.join(
            temporary.root,
            'firestaff-assets/assets/arcana/textures/item/firestaff/dark_oak.png',
          ),
        )
      ).size,
    ).toBeGreaterThan(50);

    const inspection = await workflow.inspect('firestaff', 'arcana:firestaff');
    expect(inspection.readiness).toMatchObject({
      spec: true,
      textures: true,
      compiled: true,
      rendered: true,
      binding: true,
      committed: true,
    });
    const contact = await workflow.readResource({
      kind: 'contact_sheet',
      runId: draft.runId,
      revisionId: repaired.revisionId,
    });
    expect(contact.mimeType).toBe('image/png');
    expect(contact.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('rejects a reviewed proposal after the paired-pack manifest changes', async () => {
    const temporary = await temporaryWorkspace();
    cleanups.push(temporary.cleanup);
    await createDatapack(temporary.workspace, {
      packPath: 'firestaff-data',
      namespace: 'arcana',
      description: 'Fire staff behavior',
    });
    const workflow = new VisualWorkflow(temporary.workspace, path.join(temporary.root, 'cache'));
    const attached = await workflow.attachProject(
      VisualProjectAttachInputSchema.parse({
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
      }),
    );
    const draft = await workflow.upsertSpec(
      VisualSpecUpsertInputSchema.parse({
        projectId: 'firestaff',
        request: 'A crystal fire staff',
        spec: fireStaff,
      }),
    );
    await workflow.render(
      VisualRenderInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: draft.revisionId,
        viewSize: 32,
      }),
    );
    const connected = await workflow.connect(
      VisualConnectInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: draft.revisionId,
        carrierItem: 'minecraft:blaze_rod',
      }),
    );

    await workflow.attachProject(
      VisualProjectAttachInputSchema.parse({
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-alt-assets',
        expectedManifestSha256: attached.manifestSha256,
      }),
    );

    await expect(
      workflow.commit('firestaff', draft.runId, draft.revisionId, connected.proposalSha256 ?? ''),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
    await expect(
      stat(path.join(temporary.root, 'firestaff-alt-assets/assets/arcana/items/firestaff.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('regenerates generated texture pixels after a semantic material repair', async () => {
    const temporary = await temporaryWorkspace();
    cleanups.push(temporary.cleanup);
    await createDatapack(temporary.workspace, {
      packPath: 'firestaff-data',
      namespace: 'arcana',
      description: 'Fire staff behavior',
    });
    const workflow = new VisualWorkflow(temporary.workspace, path.join(temporary.root, 'cache'));
    await workflow.attachProject(
      VisualProjectAttachInputSchema.parse({
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
      }),
    );
    const draft = await workflow.upsertSpec(
      VisualSpecUpsertInputSchema.parse({
        projectId: 'firestaff',
        request: 'A crystal fire staff',
        spec: fireStaff,
      }),
    );
    await workflow.compile('firestaff', draft.runId, draft.revisionId);
    const before = await workflow.states.read('firestaff');
    const orange = before.revisions[draft.revisionId]?.textures.fire_crystal;
    expect(orange).toMatchObject({ source: 'generated' });

    const repaired = await workflow.revise(
      VisualRevisionCreateInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        parentRevisionId: draft.revisionId,
        expectedSpecSha256: draft.specSha256,
        instructions: 'Change the fire crystal from orange to blue.',
        repairs: [
          {
            kind: 'material',
            material: 'fire_crystal',
            value: { color: '#1677ff', emissive: true, tintIndex: 0 },
          },
        ],
      }),
    );
    await workflow.compile('firestaff', draft.runId, repaired.revisionId);
    const after = await workflow.states.read('firestaff');
    const blue = after.revisions[repaired.revisionId]?.textures.fire_crystal;
    expect(blue).toMatchObject({ source: 'generated' });
    expect(blue?.sha256).not.toBe(orange?.sha256);
  });

  it('does not resolve another workspace resource through a shared cache', async () => {
    const first = await temporaryWorkspace();
    const second = await temporaryWorkspace();
    const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'packwright-shared-visual-cache-'));
    cleanups.push(first.cleanup, second.cleanup, () =>
      rm(cacheRoot, { recursive: true, force: true }),
    );
    await createDatapack(first.workspace, {
      packPath: 'firestaff-data',
      namespace: 'arcana',
      description: 'First workspace',
    });
    const firstWorkflow = new VisualWorkflow(first.workspace, cacheRoot);
    const secondWorkflow = new VisualWorkflow(second.workspace, cacheRoot);
    await firstWorkflow.attachProject(
      VisualProjectAttachInputSchema.parse({
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
      }),
    );
    const draft = await firstWorkflow.upsertSpec(
      VisualSpecUpsertInputSchema.parse({
        projectId: 'firestaff',
        request: 'A crystal fire staff',
        spec: fireStaff,
      }),
    );

    expect(firstWorkflow.operationLockRoot).not.toBe(secondWorkflow.operationLockRoot);
    await expect(
      secondWorkflow.readResource({
        kind: 'spec',
        runId: draft.runId,
        revisionId: draft.revisionId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
