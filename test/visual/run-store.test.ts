import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encodePng } from '../../src/visual/png.js';
import { VisualRunStore, canonicalJsonBytes } from '../../src/visual/run-store.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function storeFixture(): Promise<VisualRunStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-visual-runs-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return new VisualRunStore(root);
}

describe('immutable visual run storage', () => {
  it('canonicalizes JSON and gives equivalent requests the same content ID', async () => {
    const store = await storeFixture();
    const first = await store.createRun({
      request: { prompt: 'staff', constraints: { b: 2, a: 1 } },
      modelSpec: { id: 'arcana:staff', parts: [] },
      provenance: { provider: 'agent' },
    });
    const second = await store.createRun({
      request: { constraints: { a: 1, b: 2 }, prompt: 'staff' },
      modelSpec: { parts: [], id: 'arcana:staff' },
      provenance: { provider: 'agent' },
    });
    const read = await store.readRun(first.runId);

    expect(second.runId).toBe(first.runId);
    expect(read.request).toEqual({ prompt: 'staff', constraints: { a: 1, b: 2 } });
    expect(canonicalJsonBytes({ b: 2, a: 1 }).toString()).toBe('{"a":1,"b":2}\n');
  });

  it('stores and safely reads revisions, PNGs, reviews, and compiled trees', async () => {
    const store = await storeFixture();
    const run = await store.createRun({
      request: { prompt: 'staff' },
      modelSpec: { revision: 0 },
      provenance: { provider: 'agent' },
    });
    const revision = await store.createRevision(run.runId, {
      modelSpec: { revision: 1 },
      provenance: { repair: 'shorten blade' },
    });
    const png = encodePng({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) });
    const texture = await store.putTexture(run.runId, png);
    const render = await store.putRender(run.runId, 'turntable-front', png);
    const review = await store.putReview(run.runId, { accepted: false, issue: 'too long' });
    const compiled = await store.putCompiled(run.runId, {
      'assets/arcana/models/item/staff.json': '{"parent":"minecraft:item/handheld"}\n',
      'assets/arcana/textures/item/staff.png': png,
    });

    expect((await store.readRevision(run.runId, revision.revisionId)).modelSpec).toEqual({
      revision: 1,
    });
    expect(await store.listRevisions(run.runId)).toEqual([revision.revisionId]);
    expect((await store.readPng(run.runId, 'texture', 'texture', texture.sha256)).data).toEqual(
      png,
    );
    expect(
      (await store.readPng(run.runId, 'render', 'turntable-front', render.sha256)).data,
    ).toEqual(png);
    expect((await store.readReview(run.runId, review.sha256)).value).toEqual({
      accepted: false,
      issue: 'too long',
    });
    expect(
      Object.keys((await store.readCompiled(run.runId, compiled.artifactId)).contents),
    ).toEqual(['assets/arcana/models/item/staff.json', 'assets/arcana/textures/item/staff.png']);
    expect(await store.listCompiledArtifacts(run.runId)).toEqual([compiled.artifactId]);
    expect(await store.listPngArtifacts(run.runId, 'render')).toEqual([
      { label: 'turntable-front', sha256: render.sha256 },
    ]);
  });

  it('scopes otherwise identical revision content to its run', async () => {
    const store = await storeFixture();
    const firstRun = await store.createRun({
      request: { prompt: 'first' },
      modelSpec: { revision: 0 },
      provenance: { provider: 'agent' },
    });
    const secondRun = await store.createRun({
      request: { prompt: 'second' },
      modelSpec: { revision: 0 },
      provenance: { provider: 'agent' },
    });
    const revisionInput = {
      modelSpec: { revision: 1 },
      provenance: { action: 'repair', instruction: 'shorten blade' },
    };

    const firstRevision = await store.createRevision(firstRun.runId, revisionInput);
    const secondRevision = await store.createRevision(secondRun.runId, revisionInput);

    expect(firstRun.runId).not.toBe(secondRun.runId);
    expect(firstRevision.revisionId).not.toBe(secondRevision.revisionId);
    expect((await store.readRevision(firstRun.runId, firstRevision.revisionId)).runId).toBe(
      firstRun.runId,
    );
    expect((await store.readRevision(secondRun.runId, secondRevision.revisionId)).runId).toBe(
      secondRun.runId,
    );
  });

  it('rejects a symlink used as the configured cache root before writing artifacts', async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), 'packwright-visual-cache-link-'));
    cleanups.push(() => rm(container, { recursive: true, force: true }));
    const target = path.join(container, 'target');
    const linked = path.join(container, 'linked');
    await mkdir(target);
    await symlink(target, linked, 'dir');
    const store = new VisualRunStore(linked);

    await expect(store.createRun({ request: {}, modelSpec: {}, provenance: {} })).rejects.toThrow(
      /cache root is not a real directory/u,
    );
    expect(await readdir(target)).toEqual([]);
  });

  it('rejects a symlinked visual-runs root on create and every later operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-visual-runs-link-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new VisualRunStore(root);
    const run = await store.createRun({ request: {}, modelSpec: {}, provenance: {} });
    const runsRoot = path.join(root, 'visual-runs');
    const movedRoot = path.join(root, 'visual-runs-real');
    await rename(runsRoot, movedRoot);
    await symlink(movedRoot, runsRoot, 'dir');

    await expect(store.readRun(run.runId)).rejects.toThrow(
      /Visual runs root is not a real directory/u,
    );
    await expect(
      store.createRevision(run.runId, { modelSpec: {}, provenance: {} }),
    ).rejects.toThrow(/Visual runs root is not a real directory/u);
    await expect(store.listRevisions(run.runId)).rejects.toThrow(
      /Visual runs root is not a real directory/u,
    );
  });

  it('detects mutation of a supposedly immutable content-addressed artifact', async () => {
    const store = await storeFixture();
    const run = await store.createRun({ request: {}, modelSpec: {}, provenance: {} });
    const review = await store.putReview(run.runId, { accepted: true });
    await chmod(review.path, 0o644);
    await writeFile(review.path, '{"accepted":false}\n');

    await expect(store.readReview(run.runId, review.sha256)).rejects.toThrow(/hash check/u);
  });

  it('never overwrites a content-addressed artifact with different bytes', async () => {
    const store = await storeFixture();
    const run = await store.createRun({ request: {}, modelSpec: {}, provenance: {} });
    const review = await store.putReview(run.runId, { accepted: true });
    const before = await readFile(review.path);
    await store.putReview(run.runId, { accepted: true });
    expect(await readFile(review.path)).toEqual(before);
  });
});
