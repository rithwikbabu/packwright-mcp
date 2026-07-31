import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../../src/config.js';
import { sha256Buffer } from '../../src/core/hash.js';
import type * as CoreVersionModule from '../../src/core/version.js';
import type * as ClientCaptureRuntimeModule from '../../src/minecraft/client-capture-runtime.js';
import { canonicalJsonBytes } from '../../src/visual/run-store.js';

const setupState = vi.hoisted(() => ({
  artifact: Buffer.from('verified client runtime fixture'),
  artifactCount: 1,
  url: 'https://libraries.minecraft.net/fixture/runtime.jar',
}));

vi.mock('../../src/core/version.js', async (importOriginal) => {
  const original = await importOriginal<typeof CoreVersionModule>();
  return {
    ...original,
    MINECRAFT_26_2: {
      ...original.MINECRAFT_26_2,
      clientCapture: {
        ...original.MINECRAFT_26_2.clientCapture,
        loader: {
          ...original.MINECRAFT_26_2.clientCapture.loader,
          libraries: [],
        },
      },
    },
  };
});

vi.mock('../../src/minecraft/client-capture-runtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof ClientCaptureRuntimeModule>();
  return {
    ...original,
    createClientCaptureRuntimeManifest: () => {
      const artifact = Buffer.from(setupState.artifact);
      const manifest = {
        schemaVersion: 1 as const,
        minecraftVersion: '26.2' as const,
        javaMajor: 25 as const,
        platform: {
          os: 'osx' as const,
          architecture: 'arm64' as const,
          ruleArchitecture: 'aarch64',
          osVersion: 'test',
          bits: 64 as const,
        },
        mainClass: 'net.minecraft.client.main.Main',
        assetIndexId: 'fixture',
        versionMetadataSha1: '1'.repeat(40),
        assetIndexSha1: '2'.repeat(40),
        artifacts: Array.from({ length: setupState.artifactCount }, (_, index) => {
          const suffix = index === 0 ? '' : `-${String(index)}`;
          return {
            id: `fixture-library${suffix}`,
            kind: 'library' as const,
            cachePath: `libraries/fixture/runtime${suffix}.jar`,
            sha1: createHash('sha1').update(artifact).digest('hex'),
            size: artifact.length,
            url: setupState.url.replace('runtime.jar', `runtime${suffix}.jar`),
          };
        }).sort((left, right) =>
          left.cachePath < right.cachePath ? -1 : left.cachePath > right.cachePath ? 1 : 0,
        ),
        nativeExtractions: [],
      };
      return {
        manifest,
        sha256: sha256Buffer(canonicalJsonBytes(manifest)),
      };
    },
  };
});

import { prepareClientCaptureRuntime } from '../../src/minecraft/client-runtime-setup.js';

const cleanups: string[] = [];

afterEach(async () => {
  setupState.artifact = Buffer.from('verified client runtime fixture');
  setupState.artifactCount = 1;
  setupState.url = 'https://libraries.minecraft.net/fixture/runtime.jar';
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setupFixture(offline: boolean): Promise<RuntimeConfig> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'packwright-runtime-setup-test-')));
  cleanups.push(root);
  const cacheDir = path.join(root, 'cache');
  await mkdir(path.join(cacheDir, 'versions/26.2'), { recursive: true });
  await writeFile(path.join(cacheDir, 'versions/26.2/version.json'), '{}');
  await writeFile(path.join(cacheDir, 'versions/26.2/asset-index.json'), '{}');
  return {
    workspaceRoot: path.join(root, 'workspace'),
    cacheDir,
    javaCommand: 'java',
    readOnly: false,
    offline,
  };
}

describe('Minecraft client runtime setup boundaries', () => {
  it('downloads an exact trusted artifact atomically, then reuses it without network access', async () => {
    const config = await setupFixture(false);
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(setupState.artifact, {
          status: 200,
          headers: { 'content-length': String(setupState.artifact.length) },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await prepareClientCaptureRuntime(config);

    expect(result).toMatchObject({ ready: true, artifacts: 1, bytes: setupState.artifact.length });
    expect(await readFile(path.join(config.cacheDir, 'libraries/fixture/runtime.jar'))).toEqual(
      setupState.artifact,
    );
    expect(JSON.parse(await readFile(result.manifestPath, 'utf8'))).toMatchObject({
      sha256: result.manifestSha256,
      manifest: { minecraftVersion: '26.2' },
    });
    const requested = fetchMock.mock.calls[0]?.[0];
    expect(requested).toBeInstanceOf(URL);
    if (!(requested instanceof URL)) throw new Error('Expected the trusted runtime URL.');
    expect(requested.href).toBe(setupState.url);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });

    fetchMock.mockRejectedValueOnce(new Error('network must not be used'));
    await expect(prepareClientCaptureRuntime({ ...config, offline: true })).resolves.toMatchObject({
      ready: true,
      artifacts: 1,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed for offline misses, untrusted URLs, and symlink destinations', async () => {
    const offline = await setupFixture(true);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(prepareClientCaptureRuntime(offline)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const untrusted = await setupFixture(false);
    setupState.url = 'https://evil.example/runtime.jar';
    await expect(prepareClientCaptureRuntime(untrusted)).rejects.toMatchObject({
      code: 'invalid_content',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    setupState.url = 'https://libraries.minecraft.net/fixture/runtime.jar';
    const linked = await setupFixture(false);
    const target = path.join(path.dirname(linked.cacheDir), 'outside.jar');
    await writeFile(target, setupState.artifact);
    await mkdir(path.join(linked.cacheDir, 'libraries/fixture'), { recursive: true });
    await symlink(target, path.join(linked.cacheDir, 'libraries/fixture/runtime.jar'));
    await expect(prepareClientCaptureRuntime(linked)).rejects.toMatchObject({
      code: 'unsafe_path',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prepares concurrent artifacts that share newly created cache parents', async () => {
    const config = await setupFixture(false);
    setupState.artifactCount = 16;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(setupState.artifact, {
            status: 200,
            headers: { 'content-length': String(setupState.artifact.length) },
          }),
        ),
      ),
    );

    const result = await prepareClientCaptureRuntime(config);

    expect(result).toMatchObject({ ready: true, artifacts: 16 });
    await expect(
      readFile(path.join(config.cacheDir, 'libraries/fixture/runtime-15.jar')),
    ).resolves.toEqual(setupState.artifact);
  });
});
