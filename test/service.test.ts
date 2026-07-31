import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatapack, upsertResource } from '../src/core/index.js';
import { DatapackBuildInputSchema, DatapackValidateInputSchema } from '../src/mcp/schemas.js';
import { assertPairedBuildByteBudget, PackwrightApplication } from '../src/service.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

function serviceContext() {
  return {
    signal: new AbortController().signal,
    reportProgress: () => Promise.resolve(),
  };
}

async function applicationWithoutMinecraftSetup(prefix: string): Promise<{
  application: PackwrightApplication;
  root: string;
}> {
  const container = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanups.push(async () => rm(container, { recursive: true, force: true }));
  const root = path.join(container, 'workspace');
  await mkdir(root);
  const application = await PackwrightApplication.open({
    workspaceRoot: root,
    cacheDir: path.join(container, 'missing-cache'),
    javaCommand: path.join(container, 'missing-java'),
    readOnly: false,
    offline: true,
  });
  await createDatapack(application.workspace, {
    packPath: 'example',
    namespace: 'example',
    description: 'Vanilla validation contract fixture',
    loadFunction: 'say ready',
  });
  return { application, root };
}

describe('Packwright application payload bounds', () => {
  it('fails startup when the cache is inside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-overlap-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));

    await expect(
      PackwrightApplication.open({
        workspaceRoot: root,
        cacheDir: path.join(root, '.cache'),
        javaCommand: 'java',
        readOnly: false,
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('accounts for JSON escaping when truncating a resource_read result', async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), 'packwright-service-'));
    cleanups.push(async () => rm(container, { recursive: true, force: true }));
    const root = path.join(container, 'workspace');
    await mkdir(root);

    const application = await PackwrightApplication.open({
      workspaceRoot: root,
      cacheDir: path.join(container, 'cache'),
      javaCommand: 'java',
      readOnly: false,
      offline: true,
    });
    await createDatapack(application.workspace, {
      packPath: 'example',
      namespace: 'example',
      description: 'Payload-bound regression fixture',
    });
    await upsertResource(application.workspace, 'example', {
      type: 'function',
      id: 'example:escaped',
      content: '\\'.repeat(900 * 1024),
    });

    const result = await application.readResource({
      project: 'example',
      selector: {
        kind: 'resource',
        resourceType: 'function',
        id: 'example:escaped',
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.bytesReturned).toBeLessThan(result.size);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(700 * 1024);
  });

  it('reports deep validators ready only when their runtime prerequisites work', async () => {
    const container = await mkdtemp(path.join(os.tmpdir(), 'packwright-readiness-'));
    cleanups.push(async () => rm(container, { recursive: true, force: true }));
    const root = path.join(container, 'workspace');
    await mkdir(root);

    const application = await PackwrightApplication.open({
      workspaceRoot: root,
      cacheDir: path.join(container, 'cache'),
      javaCommand: path.join(container, 'missing-java'),
      spyglassCommand: path.join(container, 'missing-spyglass'),
      readOnly: false,
      offline: true,
    });
    await createDatapack(application.workspace, {
      packPath: 'example',
      namespace: 'example',
      description: 'Readiness regression fixture',
    });

    const result = await application.inspectDatapack(
      { project: 'example' },
      {
        signal: new AbortController().signal,
        reportProgress: () => Promise.resolve(),
      },
    );

    expect(result.validationReadiness).toEqual({
      structural: true,
      spyglass: false,
      vanilla: false,
    });
  });
});

describe('Packwright application vanilla validation contract', () => {
  it('fails default validation authoritatively when Minecraft setup is missing', async () => {
    const { application } = await applicationWithoutMinecraftSetup('packwright-vanilla-required-');
    const input = DatapackValidateInputSchema.parse({
      project: 'example',
      includeSpyglass: false,
    });

    const result = await application.validateDatapack(input, serviceContext());

    expect(input.includeVanilla).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.vanilla).toMatchObject({ status: 'setup_required' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        engine: 'minecraft',
        authority: 'authoritative',
        severity: 'error',
        code: 'minecraft.setup_required',
      }),
    );
  });

  it('keeps reduced structural validation usable when vanilla validation is disabled', async () => {
    const { application } = await applicationWithoutMinecraftSetup('packwright-structural-only-');
    const input = DatapackValidateInputSchema.parse({
      project: 'example',
      includeSpyglass: false,
      includeVanilla: false,
    });

    const result = await application.validateDatapack(input, serviceContext());

    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    expect(result.vanilla).toBeUndefined();
  });

  it('refuses public builds and creates no ZIP when Minecraft setup is missing', async () => {
    const { application, root } = await applicationWithoutMinecraftSetup(
      'packwright-build-requires-vanilla-',
    );

    const result = await application.buildDatapack(
      DatapackBuildInputSchema.parse({ project: 'example' }),
      serviceContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.path).toBeUndefined();
    expect(result.vanilla).toMatchObject({ status: 'setup_required' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        authority: 'authoritative',
        severity: 'error',
        code: 'minecraft.setup_required',
      }),
    );
    await expect(access(path.join(root, 'example.zip'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Packwright paired-build overwrite contract', () => {
  it('does not reinterpret missing overwrite preconditions as absent output files', async () => {
    const { application } = await applicationWithoutMinecraftSetup(
      'packwright-paired-build-preconditions-',
    );

    await expect(
      application.buildProject(
        {
          projectId: 'missing-project',
          overwrite: true,
        },
        serviceContext(),
      ),
    ).rejects.toMatchObject({ code: 'precondition_required' });
    await expect(
      application.buildProject(
        {
          projectId: 'missing-project',
          overwrite: false,
          expectedDatapackSha256: null,
          expectedResourcepackSha256: null,
        },
        serviceContext(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('Packwright paired-build byte budget', () => {
  it('rejects oversized source snapshots and ZIP artifacts before installation', () => {
    expect(() => assertPairedBuildByteBudget('source snapshots', 64 * 1024 * 1024)).not.toThrow();
    expect(() => assertPairedBuildByteBudget('source snapshots', 64 * 1024 * 1024 + 1)).toThrow(
      expect.objectContaining({ code: 'size_limit' }),
    );
    expect(() => assertPairedBuildByteBudget('ZIP artifacts', Number.MAX_SAFE_INTEGER)).toThrow(
      expect.objectContaining({ code: 'size_limit' }),
    );
  });
});
