import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatapack,
  deleteResource,
  inspectDatapack,
  MAX_TEXT_WRITE_BYTES,
  readResource,
  upsertResource,
  Workspace,
} from '../../src/core/index.js';
import { temporaryWorkspace } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function created() {
  const fixture = await temporaryWorkspace();
  cleanups.push(fixture.cleanup);
  await createDatapack(fixture.workspace, {
    packPath: 'packs/demo',
    namespace: 'demo',
    description: 'Demo',
    loadFunction: 'scoreboard objectives add ticks dummy',
    tickFunction: 'scoreboard players add #clock ticks 1\n',
  });
  return fixture;
}

describe('datapack authoring', () => {
  it('previews creation without touching the workspace', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const result = await createDatapack(fixture.workspace, {
      packPath: 'packs/demo',
      namespace: 'demo',
      description: { text: 'Demo' },
      loadFunction: 'say loading',
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.value?.files.map((file) => file.path)).toContain(
      'data/demo/function/load.mcfunction',
    );
    await expect(stat(path.join(fixture.root, 'packs/demo'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('creates metadata, exact function content with a normalized newline, and tags', async () => {
    const fixture = await created();
    await expect(
      readFile(path.join(fixture.root, 'packs/demo/data/demo/function/load.mcfunction'), 'utf8'),
    ).resolves.toBe('scoreboard objectives add ticks dummy\n');
    const manifest = JSON.parse(
      await readFile(path.join(fixture.root, 'packs/demo/pack.mcmeta'), 'utf8'),
    ) as { pack: { min_format: number[] } };
    expect(manifest.pack.min_format).toEqual([107, 1]);
    const inspection = await inspectDatapack(fixture.workspace, 'packs/demo');
    expect(inspection.namespaces).toEqual(['demo', 'minecraft']);
    expect(inspection.compatible).toBe(true);
  });

  it('requires optimistic concurrency for overwrite and delete', async () => {
    const fixture = await created();
    const locator = { type: 'function' as const, id: 'demo:load' };
    const initial = await readResource(fixture.workspace, 'packs/demo', locator);

    await expect(
      upsertResource(fixture.workspace, 'packs/demo', {
        ...locator,
        content: 'say changed\n',
      }),
    ).rejects.toMatchObject({ code: 'precondition_required' });
    await expect(
      upsertResource(fixture.workspace, 'packs/demo', {
        ...locator,
        content: 'say changed\n',
        overwrite: true,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });

    const preview = await upsertResource(fixture.workspace, 'packs/demo', {
      ...locator,
      content: 'say changed\n',
      overwrite: true,
      expectedSha256: initial.sha256,
      dryRun: true,
    });
    expect(preview.diff?.unified).toContain('+say changed');
    expect((await readResource(fixture.workspace, 'packs/demo', locator)).content).toBe(
      initial.content,
    );

    const written = await upsertResource(fixture.workspace, 'packs/demo', {
      ...locator,
      content: 'say changed\n',
      overwrite: true,
      expectedSha256: initial.sha256,
    });
    expect(written.sha256).toBeDefined();
    const writtenSha256 = written.sha256 ?? '';
    await expect(
      deleteResource(fixture.workspace, 'packs/demo', {
        ...locator,
        confirm: false,
        expectedSha256: writtenSha256,
      }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    await deleteResource(fixture.workspace, 'packs/demo', {
      ...locator,
      confirm: true,
      expectedSha256: writtenSha256,
    });
    await expect(readResource(fixture.workspace, 'packs/demo', locator)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('allows new text files but rejects malformed JSON and oversized writes', async () => {
    const fixture = await created();
    await expect(
      upsertResource(fixture.workspace, 'packs/demo', {
        type: 'recipe',
        id: 'demo:new_recipe',
        content: 'not json',
      }),
    ).rejects.toMatchObject({ code: 'invalid_content' });
    await expect(
      upsertResource(fixture.workspace, 'packs/demo', {
        path: 'data/demo/function/huge.mcfunction',
        content: 'x'.repeat(MAX_TEXT_WRITE_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: 'size_limit' });
  });

  it('serializes concurrent writes to the same new path', async () => {
    const fixture = await created();
    const writes = await Promise.allSettled([
      upsertResource(fixture.workspace, 'packs/demo', {
        type: 'function',
        id: 'demo:concurrent',
        content: 'say first\n',
      }),
      upsertResource(fixture.workspace, 'packs/demo', {
        type: 'function',
        id: 'demo:concurrent',
        content: 'say second\n',
      }),
    ]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('never replaces a concurrently created datapack target', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const creations = await Promise.allSettled([
      createDatapack(fixture.workspace, {
        packPath: 'packs/race',
        namespace: 'first',
        description: 'First',
        loadFunction: 'say first',
      }),
      createDatapack(fixture.workspace, {
        packPath: 'packs/race',
        namespace: 'second',
        description: 'Second',
        loadFunction: 'say second',
      }),
    ]);

    expect(creations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(creations.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const inspection = await inspectDatapack(fixture.workspace, 'packs/race');
    expect(inspection.compatible).toBe(true);
    expect(inspection.namespaces).toHaveLength(2);
    expect(inspection.namespaces).toContain('minecraft');
  });

  it('enforces read-only mode', async () => {
    const fixture = await created();
    const readOnly = await Workspace.open(fixture.root, { readOnly: true });
    await expect(
      upsertResource(readOnly, 'packs/demo', {
        type: 'function',
        id: 'demo:new',
        content: 'say no\n',
      }),
    ).rejects.toMatchObject({ code: 'read_only' });
  });
});
