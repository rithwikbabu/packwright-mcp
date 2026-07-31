import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VersionProfile } from '../../src/core/version.js';

const fixture = vi.hoisted(() => ({
  serverContents: 'packwright tiny server jar fixture\n',
  serverSha1: '9dc262198ab842acaa46144e76a5b3d3d0870c65',
  serverSize: 35,
  versionMetadataSha1: 'e2f8be8f8a5a9eb1ffce17bfe18c21e78d905660',
  serverUrl:
    'https://piston-data.mojang.com/v1/objects/823e2250d24b3ddac457a60c92a6a941943fcd6a/server.jar',
}));

vi.mock('../../src/core/version.js', async () => {
  const actual = await vi.importActual<
    Record<string, unknown> & { readonly MINECRAFT_26_2: VersionProfile }
  >('../../src/core/version.js');
  const dataPack = {
    ...actual.MINECRAFT_26_2.dataPack,
    artifacts: {
      ...actual.MINECRAFT_26_2.dataPack.artifacts,
      serverSha1: fixture.serverSha1,
      serverSize: fixture.serverSize,
    },
  };
  const resourcePack = {
    ...actual.MINECRAFT_26_2.resourcePack,
    artifacts: {
      ...actual.MINECRAFT_26_2.resourcePack.artifacts,
      versionMetadataSha1: fixture.versionMetadataSha1,
    },
  };
  return {
    ...actual,
    MINECRAFT_26_2: {
      ...actual.MINECRAFT_26_2,
      dataPack,
      resourcePack,
      artifacts: dataPack.artifacts,
    },
  };
});

import {
  VERSION_MANIFEST_URL,
  cachePaths,
  getCacheStatus,
  loadReferenceCache,
} from '../../src/minecraft/cache.js';

const GENERATED_AT = '2026-07-30T00:00:00.000Z';
const VERSION_METADATA = `${JSON.stringify({
  id: '26.2',
  downloads: {
    server: {
      sha1: fixture.serverSha1,
      size: fixture.serverSize,
      url: fixture.serverUrl,
    },
  },
})}\n`;

describe('optional client capture setup migration', () => {
  let root: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'packwright-cache-runtime-migration-'));
    cacheDir = path.join(root, 'cache');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps verified command-validation readiness when a stale capture runtime is dropped', async () => {
    const paths = cachePaths(cacheDir);
    await mkdir(path.dirname(paths.setupRecord), { recursive: true });
    await mkdir(path.dirname(paths.commandsReport), { recursive: true });
    await writeFile(paths.serverJar, fixture.serverContents, 'utf8');
    await writeFile(paths.versionMetadata, VERSION_METADATA, 'utf8');
    await writeFile(paths.commandsReport, '{"type":"root","children":{}}\n', 'utf8');
    await writeFile(paths.registriesReport, '{}\n', 'utf8');
    await writeFile(
      paths.setupRecord,
      `${JSON.stringify({
        minecraftVersion: '26.2',
        acceptedMinecraftEulaAt: GENERATED_AT,
        generatedAt: GENERATED_AT,
        serverSha1: fixture.serverSha1,
        versionManifestUrl: VERSION_MANIFEST_URL,
        clientCaptureRuntime: {
          preparedAt: GENERATED_AT,
          manifestSha256: '3'.repeat(64),
          platform: 'darwin',
          architecture: 'arm64',
          artifacts: 1,
          bytes: 1,
          loaderVersion: '0.19.3',
          captureProtocolVersion: 2,
        },
      })}\n`,
      'utf8',
    );

    const status = await getCacheStatus(cacheDir, true);

    expect(status).toMatchObject({
      ready: true,
      jarVerified: true,
      versionMetadataVerified: true,
      acceptedEula: true,
      commands: true,
      registries: true,
    });
    expect(status.record?.clientCaptureRuntime).toBeUndefined();
    await expect(loadReferenceCache(cacheDir)).resolves.toEqual({
      generatedAt: GENERATED_AT,
      commands: { type: 'root', children: {} },
      registries: {},
    });
  });
});
