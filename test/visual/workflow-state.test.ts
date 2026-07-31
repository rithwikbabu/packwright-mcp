import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  VisualWorkflowStateStore,
  type VisualProjectWorkflowState,
} from '../../src/visual/workflow-state.js';

const cleanups: (() => Promise<void>)[] = [];
const RUN_ID = 'a'.repeat(64);
const REVISION_ID = 'b'.repeat(64);
const SPEC_SHA256 = 'c'.repeat(64);
const TEXTURE_SHA256 = 'd'.repeat(64);
const SOURCE_SHA256 = 'e'.repeat(64);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'packwright-visual-state-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function stateWithTexture(projectId: string, workspaceId: string): VisualProjectWorkflowState {
  return {
    schemaVersion: 1,
    workspaceId,
    projectId,
    latest: { runId: RUN_ID, revisionId: REVISION_ID },
    revisions: {
      [REVISION_ID]: {
        runId: RUN_ID,
        revisionId: REVISION_ID,
        specSha256: SPEC_SHA256,
        textures: {
          crystal: {
            label: 'texture',
            sha256: TEXTURE_SHA256,
            width: 32,
            height: 32,
            bytes: 256,
            source: 'imported',
            sourceSha256: SOURCE_SHA256,
            strippedMetadata: true,
          },
        },
      },
    },
  };
}

describe('visual workflow state storage', () => {
  it('round-trips texture source and normalized-source provenance', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);

    await store.update('firestaff', () => stateWithTexture('firestaff', store.workspaceId));

    expect((await store.read('firestaff')).revisions[REVISION_ID]?.textures.crystal).toEqual({
      label: 'texture',
      sha256: TEXTURE_SHA256,
      width: 32,
      height: 32,
      bytes: 256,
      source: 'imported',
      sourceSha256: SOURCE_SHA256,
      strippedMetadata: true,
    });
  });

  it('rejects a symlink used as the configured cache root', async () => {
    const container = await temporaryDirectory();
    const actual = path.join(container, 'actual');
    const linked = path.join(container, 'linked');
    await mkdir(actual);
    await symlink(actual, linked, 'dir');
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(linked, workspaceRoot);

    await expect(store.read('firestaff')).rejects.toThrow(/not a real directory/u);
  });

  it('rejects symlinks and non-directories at the state-root component', async () => {
    const symlinkCache = await temporaryDirectory();
    const target = path.join(symlinkCache, 'target');
    await mkdir(target);
    await symlink(target, path.join(symlinkCache, 'visual-project-state'), 'dir');
    const symlinkWorkspace = await temporaryDirectory();
    await expect(
      new VisualWorkflowStateStore(symlinkCache, symlinkWorkspace).read('firestaff'),
    ).rejects.toThrow(/not a real directory/u);

    const fileCache = await temporaryDirectory();
    await writeFile(path.join(fileCache, 'visual-project-state'), 'not a directory');
    const fileWorkspace = await temporaryDirectory();
    await expect(
      new VisualWorkflowStateStore(fileCache, fileWorkspace).read('firestaff'),
    ).rejects.toThrow(/not a real directory/u);
  });

  it('rejects invalid texture provenance instead of persisting it', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);
    const invalid = stateWithTexture('firestaff', store.workspaceId) as unknown as {
      revisions: Record<string, { textures: Record<string, { source: string }> }>;
    };
    const revision = invalid.revisions[REVISION_ID];
    const texture = revision?.textures.crystal;
    if (texture === undefined) throw new Error('Test fixture texture is missing.');
    texture.source = 'remote';

    await expect(
      store.update('firestaff', () => invalid as unknown as VisualProjectWorkflowState),
    ).rejects.toThrow(/PNG source is invalid/u);
  });

  it('isolates project state for workspaces sharing one global cache', async () => {
    const cacheRoot = await temporaryDirectory();
    const firstWorkspace = await temporaryDirectory();
    const secondWorkspace = await temporaryDirectory();
    const first = new VisualWorkflowStateStore(cacheRoot, firstWorkspace);
    const second = new VisualWorkflowStateStore(cacheRoot, secondWorkspace);

    await first.update('firestaff', () => stateWithTexture('firestaff', first.workspaceId));

    expect(first.workspaceId).not.toBe(second.workspaceId);
    await expect(second.read('firestaff')).resolves.toEqual({
      schemaVersion: 1,
      workspaceId: second.workspaceId,
      projectId: 'firestaff',
      revisions: {},
    });
  });

  it('rejects state copied from another workspace namespace', async () => {
    const cacheRoot = await temporaryDirectory();
    const firstWorkspace = await temporaryDirectory();
    const secondWorkspace = await temporaryDirectory();
    const first = new VisualWorkflowStateStore(cacheRoot, firstWorkspace);
    const second = new VisualWorkflowStateStore(cacheRoot, secondWorkspace);
    await first.update('firestaff', () => stateWithTexture('firestaff', first.workspaceId));
    await mkdir(second.root, { recursive: true });
    const source = path.join(first.root, 'firestaff.json');
    const destination = path.join(second.root, 'firestaff.json');
    await writeFile(destination, await readFile(source));

    await expect(second.read('firestaff')).rejects.toThrow(/state identity is invalid/u);
  });
});
