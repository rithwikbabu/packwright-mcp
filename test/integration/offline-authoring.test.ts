import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  Workspace,
  buildDatapack,
  createDatapack,
  inspectDatapack,
  upsertResource,
  validateDatapack,
} from '../../src/core/index.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

async function temporaryWorkspace(): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-integration-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  return { root, workspace: await Workspace.open(root) };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function centralDirectoryNames(archive: Buffer): string[] {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const names: string[] = [];
  let cursor = 0;

  for (;;) {
    const header = archive.indexOf(signature, cursor);
    if (header < 0) return names;
    if (header + 46 > archive.length) throw new Error('Truncated ZIP central directory header');
    const nameLength = archive.readUInt16LE(header + 28);
    const extraLength = archive.readUInt16LE(header + 30);
    const commentLength = archive.readUInt16LE(header + 32);
    const nameStart = header + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > archive.length) throw new Error('Truncated ZIP entry name');
    names.push(archive.subarray(nameStart, nameEnd).toString('utf8'));
    cursor = nameEnd + extraLength + commentLength;
  }
}

describe('offline authoring flow', () => {
  it('creates, extends, validates, inspects, and builds a 26.2 datapack', async () => {
    const { root, workspace } = await temporaryWorkspace();

    const created = await createDatapack(workspace, {
      packPath: 'packs/adventure',
      namespace: 'adventure',
      description: 'Offline end-to-end fixture',
      loadFunction: 'scoreboard objectives add adventure_ticks dummy',
    });
    expect(created.ok).toBe(true);

    await Promise.all([
      upsertResource(workspace, 'packs/adventure', {
        type: 'advancement',
        id: 'adventure:loaded',
        content: prettyJson({ criteria: { loaded: { trigger: 'minecraft:tick' } } }),
      }),
      upsertResource(workspace, 'packs/adventure', {
        type: 'recipe',
        id: 'adventure:stone_button',
        content: prettyJson({
          type: 'minecraft:crafting_shapeless',
          category: 'redstone',
          ingredients: ['minecraft:stone'],
          result: { id: 'minecraft:stone_button', count: 1 },
        }),
      }),
      upsertResource(workspace, 'packs/adventure', {
        type: 'predicate',
        id: 'adventure:player',
        content: prettyJson({
          condition: 'minecraft:entity_properties',
          entity: 'this',
          predicate: { type: 'minecraft:player' },
        }),
      }),
      upsertResource(workspace, 'packs/adventure', {
        type: 'loot_table',
        id: 'adventure:empty',
        content: prettyJson({ type: 'minecraft:generic', pools: [] }),
      }),
      upsertResource(workspace, 'packs/adventure', {
        type: 'damage_type',
        id: 'adventure:testing',
        content: prettyJson({
          message_id: 'adventure.testing',
          scaling: 'never',
          exhaustion: 0,
        }),
      }),
      upsertResource(workspace, 'packs/adventure', {
        type: 'test_instance',
        id: 'adventure:smoke',
        content: prettyJson({
          type: 'function',
          environment: 'minecraft:default',
          structure: 'minecraft:empty',
          max_ticks: 100,
          setup_ticks: 0,
          required: true,
          function: 'minecraft:always_pass',
        }),
      }),
    ]);

    const validation = await validateDatapack(workspace, 'packs/adventure');
    expect(validation).toMatchObject({ ok: true, diagnostics: [] });

    const inspection = await inspectDatapack(workspace, 'packs/adventure');
    expect(inspection.compatible).toBe(true);
    expect(inspection.namespaces).toEqual(['adventure', 'minecraft']);
    expect(new Set(inspection.resources.map((resource) => resource.resourceType))).toEqual(
      new Set([
        undefined,
        'advancement',
        'damage_type',
        'function',
        'function_tag',
        'loot_table',
        'predicate',
        'recipe',
        'test_instance',
      ]),
    );

    const build = await buildDatapack(workspace, 'packs/adventure', {
      outputPath: 'build/adventure.zip',
    });
    expect(build).toMatchObject({ ok: true, entries: inspection.files });
    expect(build.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await expect(stat(path.join(root, 'build/adventure.zip'))).resolves.toMatchObject({
      size: build.size,
    });

    const entries = centralDirectoryNames(await readFile(path.join(root, 'build/adventure.zip')));
    expect(entries).toContain('pack.mcmeta');
    expect(entries).toContain('data/adventure/test_instance/smoke.json');
    expect(entries.every((entry) => !entry.startsWith('adventure/'))).toBe(true);
  });
});

describe('checked-in Minecraft 26.2 fixtures', () => {
  it('accepts and packages the structurally valid multi-resource fixture', async () => {
    const { root, workspace } = await temporaryWorkspace();
    const source = fileURLToPath(new URL('../fixtures/valid-26.2', import.meta.url));
    await cp(source, path.join(root, 'valid'), { recursive: true });

    const validation = await validateDatapack(workspace, 'valid');
    expect(validation).toMatchObject({ ok: true, diagnostics: [] });

    const inspection = await inspectDatapack(workspace, 'valid');
    const resourceTypes = new Set(
      inspection.resources.flatMap((resource) =>
        resource.resourceType === undefined ? [] : [resource.resourceType],
      ),
    );
    expect(resourceTypes).toEqual(
      new Set([
        'advancement',
        'damage_type',
        'function',
        'function_tag',
        'loot_table',
        'predicate',
        'recipe',
        'test_environment',
        'test_instance',
      ]),
    );

    const build = await buildDatapack(workspace, 'valid', {
      outputPath: 'build/valid-26.2.zip',
    });
    expect(build.ok).toBe(true);
    expect(build.entries).toBe(inspection.files);
  });

  it('rejects the intentionally broken fixture with actionable diagnostics', async () => {
    const { root, workspace } = await temporaryWorkspace();
    const source = fileURLToPath(new URL('../fixtures/broken-26.2', import.meta.url));
    await cp(source, path.join(root, 'broken'), { recursive: true });

    const validation = await validateDatapack(workspace, 'broken');
    const codes = validation.diagnostics.map((diagnostic) => diagnostic.code);
    expect(validation.ok).toBe(false);
    expect(codes).toEqual(
      expect.arrayContaining([
        'json.invalid',
        'layout.legacy_plural_directory',
        'pack.unsupported_max_format',
        'pack.unsupported_min_format',
        'tag.missing_reference',
      ]),
    );

    const build = await buildDatapack(workspace, 'broken', {
      outputPath: 'build/broken-26.2.zip',
    });
    expect(build).toMatchObject({ ok: false, entries: 0 });
    await expect(stat(path.join(root, 'build/broken-26.2.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
