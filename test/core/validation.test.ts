import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatapack, upsertResource, validateDatapack } from '../../src/core/index.js';
import { temporaryWorkspace } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('structural validation', () => {
  it('accepts a generated 26.2 datapack', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Valid',
      loadFunction: 'say ready',
    });
    const result = await validateDatapack(fixture.workspace, 'pack');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts a vanilla Test Function in a function-type GameTest', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Vanilla GameTest',
    });
    await upsertResource(fixture.workspace, 'pack', {
      type: 'test_instance',
      id: 'demo:smoke',
      content: `${JSON.stringify({
        type: 'function',
        environment: 'minecraft:default',
        structure: 'minecraft:empty',
        function: 'minecraft:always_pass',
      })}\n`,
    });

    const result = await validateDatapack(fixture.workspace, 'pack');
    expect(result).toMatchObject({ ok: true, diagnostics: [] });
  });

  it('rejects datapack functions used as vanilla GameTest Test Functions', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Invalid GameTest functions',
    });
    await upsertResource(fixture.workspace, 'pack', {
      type: 'function',
      id: 'demo:gametest',
      content: 'return 1\n',
    });
    for (const [id, type] of [
      ['demo:short_type', 'function'],
      ['demo:namespaced_type', 'minecraft:function'],
    ] as const) {
      await upsertResource(fixture.workspace, 'pack', {
        type: 'test_instance',
        id,
        content: `${JSON.stringify({
          type,
          environment: 'minecraft:default',
          structure: 'minecraft:empty',
          function: 'demo:gametest',
        })}\n`,
      });
    }

    const result = await validateDatapack(fixture.workspace, 'pack');
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.filter((entry) => entry.code === 'gametest.unavailable_test_function'),
    ).toEqual([
      expect.objectContaining({
        path: 'data/demo/test_instance/namespaced_type.json',
        authority: 'structural',
        severity: 'error',
      }),
      expect.objectContaining({
        path: 'data/demo/test_instance/short_type.json',
        authority: 'structural',
        severity: 'error',
      }),
    ]);
  });

  it('reports metadata, legacy layout, JSON, identifiers, and missing tag references', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await mkdir(path.join(fixture.root, 'broken/data/Bad Namespace/functions'), {
      recursive: true,
    });
    await mkdir(path.join(fixture.root, 'broken/data/demo/recipe'), { recursive: true });
    await mkdir(path.join(fixture.root, 'broken/data/minecraft/tags/function'), {
      recursive: true,
    });
    await writeFile(
      path.join(fixture.root, 'broken/pack.mcmeta'),
      JSON.stringify({ pack: { description: 'Broken', min_format: [1, 0], max_format: [1, 0] } }),
    );
    await writeFile(
      path.join(fixture.root, 'broken/data/Bad Namespace/functions/oops.mcfunction'),
      'say no\n',
    );
    await writeFile(path.join(fixture.root, 'broken/data/demo/recipe/bad.json'), '{');
    await writeFile(
      path.join(fixture.root, 'broken/data/minecraft/tags/function/load.json'),
      JSON.stringify({ values: ['demo:missing'] }),
    );

    const result = await validateDatapack(fixture.workspace, 'broken');
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(result.ok).toBe(false);
    expect(codes).toContain('pack.unsupported_min_format');
    expect(codes).toContain('pack.unsupported_max_format');
    expect(codes).toContain('layout.legacy_plural_directory');
    expect(codes).toContain('resource.invalid_namespace');
    expect(codes).toContain('json.invalid');
    expect(codes).toContain('tag.missing_reference');
  });

  it('normalizes adapter failures to an advisory warning', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Valid',
    });
    const result = await validateDatapack(fixture.workspace, 'pack', {
      adapters: [
        {
          name: 'fake-spyglass',
          validate() {
            return Promise.reject(new Error('not running'));
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        engine: 'fake-spyglass',
        severity: 'warning',
        code: 'adapter.failed',
      }),
    );
  });

  it('accepts custom JSON registries while enforcing extensions for known directories', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Custom registry checks',
    });
    await mkdir(path.join(fixture.root, 'pack/data/demo/modded_registry'), { recursive: true });
    await mkdir(path.join(fixture.root, 'pack/data/demo/recipe'), { recursive: true });
    await writeFile(path.join(fixture.root, 'pack/data/demo/modded_registry/example.json'), '{}\n');
    await writeFile(
      path.join(fixture.root, 'pack/data/demo/recipe/wrong.mcfunction'),
      'say wrong extension\n',
    );

    const result = await validateDatapack(fixture.workspace, 'pack');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'layout.invalid_extension',
        path: 'data/demo/recipe/wrong.mcfunction',
      }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ path: 'data/demo/modded_registry/example.json' }),
    );
  });

  it('rejects unsupported data files, invalid UTF-8, NUL text, and malformed basic SNBT', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Text checks',
    });
    await mkdir(path.join(fixture.root, 'pack/data/demo/function'), { recursive: true });
    await mkdir(path.join(fixture.root, 'pack/data/demo/structure'), { recursive: true });
    await mkdir(path.join(fixture.root, 'pack/data/demo/unknown'), { recursive: true });
    await writeFile(
      path.join(fixture.root, 'pack/data/demo/function/invalid.mcfunction'),
      Buffer.from([0xff, 0xfe]),
    );
    await writeFile(
      path.join(fixture.root, 'pack/data/demo/function/nul.mcfunction'),
      'say before\0say after\n',
    );
    await writeFile(path.join(fixture.root, 'pack/data/demo/structure/open.snbt'), '{foo:[1,2\n');
    await writeFile(path.join(fixture.root, 'pack/data/demo/unknown/nope.txt'), 'unsupported\n');

    const result = await validateDatapack(fixture.workspace, 'pack');
    const codes = result.diagnostics.map((entry) => entry.code);
    expect(codes).toContain('text.invalid_utf8');
    expect(codes).toContain('text.nul_byte');
    expect(codes).toContain('snbt.basic_structure');
    expect(codes).toContain('layout.unsupported_resource_directory');
  });
});
