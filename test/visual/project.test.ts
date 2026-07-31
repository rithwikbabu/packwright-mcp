import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PackwrightError } from '../../src/core/errors.js';
import { createPackMetadata, createResourcePackMetadata } from '../../src/core/version.js';
import { temporaryWorkspace } from '../core/helpers.js';
import {
  attachVisualProject,
  inspectVisualProject,
  parseVisualProjectManifest,
  visualProjectManifestPath,
  VISUAL_PROJECT_SCHEMA_VERSION,
} from '../../src/visual/project.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function writePack(
  root: string,
  relative: string,
  kind: 'datapack' | 'resourcepack',
): Promise<void> {
  const absolute = path.join(root, ...relative.split('/'));
  await mkdir(absolute, { recursive: true });
  const metadata =
    kind === 'datapack'
      ? createPackMetadata('Data pack')
      : createResourcePackMetadata('Resource pack');
  await writeFile(path.join(absolute, 'pack.mcmeta'), `${JSON.stringify(metadata, null, 2)}\n`);
  await mkdir(path.join(absolute, kind === 'datapack' ? 'data' : 'assets'));
}

async function pairedWorkspace(): Promise<Awaited<ReturnType<typeof temporaryWorkspace>>> {
  const temporary = await temporaryWorkspace();
  cleanups.push(temporary.cleanup);
  await writePack(temporary.root, 'firestaff-data', 'datapack');
  await writePack(temporary.root, 'firestaff-assets', 'resourcepack');
  return temporary;
}

describe('paired visual projects', () => {
  it('attaches sibling packs with a deterministic optional manifest and inspects both sides', async () => {
    const temporary = await pairedWorkspace();
    const attached = await attachVisualProject(temporary.workspace, {
      id: 'firestaff',
      datapack: 'firestaff-data',
      resourcepack: 'firestaff-assets',
    });

    expect(attached).toMatchObject({
      ok: true,
      operation: 'visual_project_attach',
      changed: true,
      dryRun: false,
      path: '.packwright/projects/firestaff.json',
    });
    expect(attached.value).toMatchObject({
      ready: true,
      manifest: {
        schemaVersion: 1,
        id: 'firestaff',
        minecraftVersion: '26.2',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
        target: 'vanilla',
      },
      datapack: { actualFormat: [107, 1], compatible: true },
      resourcepack: { actualFormat: [88, 0], compatible: true },
    });

    const stored = JSON.parse(
      await readFile(path.join(temporary.root, visualProjectManifestPath('firestaff')), 'utf8'),
    ) as unknown;
    expect(stored).toEqual(attached.value?.manifest);
    expect(await inspectVisualProject(temporary.workspace, 'firestaff')).toEqual(attached.value);
  });

  it('supports a no-write proposal', async () => {
    const temporary = await pairedWorkspace();
    const proposed = await attachVisualProject(temporary.workspace, {
      id: 'firestaff',
      datapack: 'firestaff-data',
      resourcepack: 'firestaff-assets',
      dryRun: true,
    });
    expect(proposed).toMatchObject({ changed: true, dryRun: true });
    await expect(inspectVisualProject(temporary.workspace, 'firestaff')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('requires overwrite and a current hash to change an association', async () => {
    const temporary = await pairedWorkspace();
    await writePack(temporary.root, 'firestaff-assets-v2', 'resourcepack');
    const first = await attachVisualProject(temporary.workspace, {
      id: 'firestaff',
      datapack: 'firestaff-data',
      resourcepack: 'firestaff-assets',
    });
    const replacement = {
      id: 'firestaff',
      datapack: 'firestaff-data',
      resourcepack: 'firestaff-assets-v2',
    } as const;

    await expect(attachVisualProject(temporary.workspace, replacement)).rejects.toMatchObject({
      code: 'precondition_required',
    });
    await expect(
      attachVisualProject(temporary.workspace, {
        ...replacement,
        overwrite: true,
        expectedSha256: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'precondition_failed' });

    const updated = await attachVisualProject(temporary.workspace, {
      ...replacement,
      overwrite: true,
      expectedSha256: first.sha256,
    });
    expect(updated).toMatchObject({
      changed: true,
      previousSha256: first.sha256,
      value: { manifest: { resourcepack: 'firestaff-assets-v2' } },
    });
  });

  it('rejects unsafe, non-canonical, reserved, and non-sibling associations', async () => {
    const temporary = await pairedWorkspace();
    const inputs = [
      { datapack: '../firestaff-data', resourcepack: 'firestaff-assets' },
      { datapack: 'firestaff-data/', resourcepack: 'firestaff-assets' },
      { datapack: '.packwright/data', resourcepack: '.packwright/assets' },
      { datapack: 'nested/firestaff-data', resourcepack: 'firestaff-assets' },
      { datapack: 'firestaff-data', resourcepack: 'firestaff-data' },
    ];
    for (const input of inputs) {
      await expect(
        attachVisualProject(temporary.workspace, { id: 'unsafe', ...input }),
      ).rejects.toBeInstanceOf(PackwrightError);
    }
    expect(() => visualProjectManifestPath('../unsafe')).toThrow(/Visual project id/u);
  });

  it('refuses missing or format-incompatible pack roots', async () => {
    const temporary = await pairedWorkspace();
    await writeFile(
      path.join(temporary.root, 'firestaff-assets', 'pack.mcmeta'),
      `${JSON.stringify(createPackMetadata('Wrong side'))}\n`,
    );
    await expect(
      attachVisualProject(temporary.workspace, {
        id: 'wrong_format',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      attachVisualProject(temporary.workspace, {
        id: 'missing',
        datapack: 'firestaff-data',
        resourcepack: 'missing-assets',
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects symlinked packs and strict-schema manifest fields', async () => {
    const temporary = await pairedWorkspace();
    await symlink('firestaff-assets', path.join(temporary.root, 'linked-assets'));
    await expect(
      attachVisualProject(temporary.workspace, {
        id: 'linked',
        datapack: 'firestaff-data',
        resourcepack: 'linked-assets',
      }),
    ).rejects.toMatchObject({ code: 'unsafe_path' });

    expect(() =>
      parseVisualProjectManifest(temporary.workspace, {
        schemaVersion: VISUAL_PROJECT_SCHEMA_VERSION,
        id: 'firestaff',
        minecraftVersion: '26.2',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
        target: 'vanilla',
        surprise: true,
      }),
    ).toThrow(/unsupported fields/u);
  });

  it('reports readiness loss when an attached pack metadata becomes incompatible', async () => {
    const temporary = await pairedWorkspace();
    await attachVisualProject(temporary.workspace, {
      id: 'firestaff',
      datapack: 'firestaff-data',
      resourcepack: 'firestaff-assets',
    });
    await writeFile(
      path.join(temporary.root, 'firestaff-assets', 'pack.mcmeta'),
      '{"pack":{"min_format":[1,0],"max_format":[1,0]}}\n',
    );
    const inspection = await inspectVisualProject(temporary.workspace, 'firestaff');
    expect(inspection.ready).toBe(false);
    expect(inspection.resourcepack).toMatchObject({
      compatible: false,
      actualFormat: [1, 0],
    });
    expect(inspection.resourcepack.issues[0]).toMatch(/does not match/u);
  });
});
