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
const REQUIRED_CAPTURE_VIEW = 'first_person_vanilla--fp_right_steve';
const SUPPLEMENTAL_CAPTURE_VIEW = 'first_person_scale_reference--fp_right_steve';

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

interface ClientCaptureStateOptions {
  readonly requiredViewIds?: readonly string[] | undefined;
  readonly supplementalViewIds?: readonly string[] | undefined;
  readonly includeSupplementalView?: boolean | undefined;
  readonly includeScaleReferenceContactSheet?: boolean | undefined;
}

function capturePng(label: string, hashCharacter: string, source: 'captured' | 'generated') {
  return {
    label,
    sha256: hashCharacter.repeat(64),
    width: 1280,
    height: 720,
    bytes: 4096,
    source,
    sourceSha256: hashCharacter.repeat(64),
    strippedMetadata: true,
  } as const;
}

function stateWithClientCapture(
  projectId: string,
  workspaceId: string,
  options: ClientCaptureStateOptions = {},
): VisualProjectWorkflowState {
  const includeSupplementalView = options.includeSupplementalView ?? true;
  const includeScaleReferenceContactSheet = options.includeScaleReferenceContactSheet ?? true;
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
        textures: {},
        compiledArtifactId: '0'.repeat(64),
        proposalArtifactId: '1'.repeat(64),
        clientCapture: {
          authority: 'authoritative_environment_capture',
          authorityScope: 'required_views_only',
          rendererVersion: 'minecraft-client-26.2',
          profileId: 'held_item',
          profileVersion: 1,
          planSha256: '2'.repeat(64),
          reportSha256: '3'.repeat(64),
          sourceReportSha256: '4'.repeat(64),
          specSha256: SPEC_SHA256,
          compiledArtifactId: '0'.repeat(64),
          proposalArtifactId: '1'.repeat(64),
          manifestSha256: '5'.repeat(64),
          datapackContentSha256: '6'.repeat(64),
          resourcepackContentSha256: '7'.repeat(64),
          runtimeManifestSha256: '8'.repeat(64),
          clientJarSha1: '9'.repeat(40),
          clientJarSha256: 'a'.repeat(64),
          captureModSha256: 'b'.repeat(64),
          log: { label: 'minecraft-log', sha256: 'c'.repeat(64), bytes: 1024 },
          contactSheet: capturePng('vanilla-contact', 'd', 'generated'),
          ...(includeScaleReferenceContactSheet
            ? {
                scaleReferenceContactSheet: capturePng('scale-reference-contact', 'e', 'generated'),
              }
            : {}),
          views: {
            [REQUIRED_CAPTURE_VIEW]: capturePng('vanilla-view', 'f', 'captured'),
            ...(includeSupplementalView
              ? {
                  [SUPPLEMENTAL_CAPTURE_VIEW]: capturePng('scale-reference-view', '0', 'captured'),
                }
              : {}),
          },
          requiredViewIds: options.requiredViewIds ?? [REQUIRED_CAPTURE_VIEW],
          supplementalViewIds: options.supplementalViewIds ?? [SUPPLEMENTAL_CAPTURE_VIEW],
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

  it('round-trips authoritative, supplemental, and scale-reference capture evidence separately', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);

    await store.update('firestaff', () => stateWithClientCapture('firestaff', store.workspaceId));

    const capture = (await store.read('firestaff')).revisions[REVISION_ID]?.clientCapture;
    expect(capture).toMatchObject({
      authority: 'authoritative_environment_capture',
      authorityScope: 'required_views_only',
      requiredViewIds: [REQUIRED_CAPTURE_VIEW],
      supplementalViewIds: [SUPPLEMENTAL_CAPTURE_VIEW],
      scaleReferenceContactSheet: {
        label: 'scale-reference-contact',
        source: 'generated',
      },
      views: {
        [REQUIRED_CAPTURE_VIEW]: { label: 'vanilla-view', source: 'captured' },
        [SUPPLEMENTAL_CAPTURE_VIEW]: {
          label: 'scale-reference-view',
          source: 'captured',
        },
      },
    });
  });

  it('round-trips a vanilla-only capture without an optional scale-reference sheet', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);

    await store.update('firestaff', () =>
      stateWithClientCapture('firestaff', store.workspaceId, {
        supplementalViewIds: [],
        includeSupplementalView: false,
        includeScaleReferenceContactSheet: false,
      }),
    );

    const capture = (await store.read('firestaff')).revisions[REVISION_ID]?.clientCapture;
    expect(capture?.requiredViewIds).toEqual([REQUIRED_CAPTURE_VIEW]);
    expect(capture?.supplementalViewIds).toEqual([]);
    expect(capture?.scaleReferenceContactSheet).toBeUndefined();
    expect(Object.keys(capture?.views ?? {})).toEqual([REQUIRED_CAPTURE_VIEW]);
  });

  it('rejects supplemental IDs whose captured views are missing', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          includeSupplementalView: false,
        }),
      ),
    ).rejects.toThrow(/scale-reference client-capture view is invalid or missing/u);
  });

  it('rejects unclassified views and a scale-reference sheet without matching supplemental views', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          supplementalViewIds: [],
          includeScaleReferenceContactSheet: false,
        }),
      ),
    ).rejects.toThrow(/views are not completely classified/u);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          supplementalViewIds: [],
          includeSupplementalView: false,
        }),
      ),
    ).rejects.toThrow(/contact sheet does not match its supplemental views/u);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          includeScaleReferenceContactSheet: false,
        }),
      ),
    ).rejects.toThrow(/contact sheet does not match its supplemental views/u);
  });

  it('rejects duplicate and overlapping authoritative or supplemental view IDs', async () => {
    const cacheRoot = await temporaryDirectory();
    const workspaceRoot = await temporaryDirectory();
    const store = new VisualWorkflowStateStore(cacheRoot, workspaceRoot);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          requiredViewIds: [REQUIRED_CAPTURE_VIEW, REQUIRED_CAPTURE_VIEW],
        }),
      ),
    ).rejects.toThrow(/required client-capture views are duplicated/u);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          supplementalViewIds: [SUPPLEMENTAL_CAPTURE_VIEW, SUPPLEMENTAL_CAPTURE_VIEW],
        }),
      ),
    ).rejects.toThrow(/scale-reference client-capture views are duplicated/u);

    await expect(
      store.update('firestaff', () =>
        stateWithClientCapture('firestaff', store.workspaceId, {
          supplementalViewIds: [REQUIRED_CAPTURE_VIEW],
        }),
      ),
    ).rejects.toThrow(/scale-reference client-capture views are duplicated/u);
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
