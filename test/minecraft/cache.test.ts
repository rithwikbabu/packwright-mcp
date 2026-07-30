import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '../../src/config.js';
import { MINECRAFT_26_2 } from '../../src/core/version.js';
import {
  VERSION_MANIFEST_URL,
  cachePaths,
  getCacheStatus,
  loadReferenceCache,
  setupVersion,
  type SetupRecord,
} from '../../src/minecraft/cache.js';

const GENERATED_AT = '2026-07-30T00:00:00.000Z';

function validSetupRecord(): SetupRecord {
  return {
    minecraftVersion: '26.2',
    acceptedMinecraftEulaAt: GENERATED_AT,
    generatedAt: GENERATED_AT,
    serverSha1: MINECRAFT_26_2.artifacts.serverSha1,
    versionManifestUrl: VERSION_MANIFEST_URL,
  };
}

function validVersionMetadata(): Record<string, unknown> {
  const artifacts = MINECRAFT_26_2.artifacts;
  return {
    id: '26.2',
    downloads: {
      server: {
        sha1: artifacts.serverSha1,
        size: artifacts.serverSize,
        url: artifacts.serverUrl,
      },
    },
  };
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value)}\n`, 'utf8');
}

describe('Minecraft validation cache trust', () => {
  let root: string;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'packwright-cache-'));
    cacheDir = path.join(root, 'cache');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('treats malformed setup JSON as no EULA acceptance', async () => {
    const paths = cachePaths(cacheDir);
    await mkdir(path.dirname(paths.setupRecord), { recursive: true });
    await writeFile(paths.setupRecord, '{not valid JSON', 'utf8');

    const status = await getCacheStatus(cacheDir);

    expect(status.acceptedEula).toBe(false);
    expect(status.record).toBeUndefined();
    expect(status.ready).toBe(false);
  });

  it.each([
    {
      name: 'a jar digest supplied by the cache record',
      changes: { serverSha1: '0'.repeat(40) },
    },
    {
      name: 'a non-canonical timestamp',
      changes: { acceptedMinecraftEulaAt: '0' },
    },
    {
      name: 'EULA acceptance after record generation',
      changes: { acceptedMinecraftEulaAt: '2026-07-31T00:00:00.000Z' },
    },
  ])('rejects a setup record forged with $name', async ({ changes }) => {
    const paths = cachePaths(cacheDir);
    await writeJson(paths.setupRecord, { ...validSetupRecord(), ...changes });

    const status = await getCacheStatus(cacheDir);

    expect(status.acceptedEula).toBe(false);
    expect(status.record).toBeUndefined();
    expect(status.jarVerified).toBe(false);
    expect(status.ready).toBe(false);
  });

  it('reports pinned version metadata independently from file presence', async () => {
    const paths = cachePaths(cacheDir);
    await writeJson(paths.versionMetadata, validVersionMetadata());

    await expect(getCacheStatus(cacheDir)).resolves.toMatchObject({
      versionMetadata: true,
      versionMetadataVerified: true,
      ready: false,
    });

    await writeJson(paths.versionMetadata, {
      id: '26.2',
      downloads: {
        server: {
          sha1: '0'.repeat(40),
          size: MINECRAFT_26_2.artifacts.serverSize,
          url: MINECRAFT_26_2.artifacts.serverUrl,
        },
      },
    });

    await expect(getCacheStatus(cacheDir)).resolves.toMatchObject({
      versionMetadata: true,
      versionMetadataVerified: false,
      ready: false,
    });
  });

  it('fails closed on invalid cached metadata while offline', async () => {
    const paths = cachePaths(cacheDir);
    await writeJson(paths.versionMetadata, {
      id: '26.2',
      downloads: {
        server: {
          sha1: '0'.repeat(40),
          size: MINECRAFT_26_2.artifacts.serverSize,
          url: MINECRAFT_26_2.artifacts.serverUrl,
        },
      },
    });

    const workspaceRoot = path.join(root, 'workspace');
    const fakeJava = path.join(root, 'java-25');
    await mkdir(workspaceRoot);
    await writeFile(fakeJava, '#!/bin/sh\necho \'openjdk version "25.0.1"\' >&2\n', 'utf8');
    await chmod(fakeJava, 0o700);
    const config: RuntimeConfig = {
      workspaceRoot,
      javaCommand: fakeJava,
      cacheDir,
      readOnly: false,
      offline: true,
    };

    await expect(setupVersion(config, true)).rejects.toMatchObject({
      name: 'PackwrightError',
      code: 'invalid_content',
    });
  });

  it('verifies a correctly sized jar against the built-in Mojang digest', async () => {
    const paths = cachePaths(cacheDir);
    await writeJson(paths.setupRecord, validSetupRecord());
    await writeJson(paths.versionMetadata, validVersionMetadata());
    await writeJson(paths.commandsReport, {});
    await writeJson(paths.registriesReport, {});
    await writeFile(paths.serverJar, 'not the official server', 'utf8');
    await truncate(paths.serverJar, MINECRAFT_26_2.artifacts.serverSize);

    const status = await getCacheStatus(cacheDir, true);

    expect(status).toMatchObject({
      jar: true,
      jarVerified: false,
      versionMetadataVerified: true,
      acceptedEula: true,
      commands: true,
      registries: true,
      ready: false,
    });
  });

  it('does not follow a cached server.jar symlink', async () => {
    const paths = cachePaths(cacheDir);
    const outsideJar = path.join(root, 'outside.jar');
    await writeJson(paths.setupRecord, validSetupRecord());
    await writeJson(paths.versionMetadata, validVersionMetadata());
    await writeFile(outsideJar, 'not the official server', 'utf8');
    await truncate(outsideJar, MINECRAFT_26_2.artifacts.serverSize);
    await symlink(outsideJar, paths.serverJar);

    const status = await getCacheStatus(cacheDir, true);

    expect(status.jar).toBe(false);
    expect(status.jarVerified).toBe(false);
    expect(status.ready).toBe(false);
  });

  it('does not trust orphaned command and registry reports as a ready reference cache', async () => {
    const paths = cachePaths(cacheDir);
    await writeJson(paths.commandsReport, { children: {} });
    await writeJson(paths.registriesReport, {});

    await expect(loadReferenceCache(cacheDir)).resolves.toBeUndefined();
  });

  it('does not follow symlinked reference reports', async () => {
    const paths = cachePaths(cacheDir);
    const outside = path.join(root, 'outside-commands.json');
    await writeFile(outside, '{"secret":true}\n', 'utf8');
    await mkdir(path.dirname(paths.commandsReport), { recursive: true });
    await symlink(outside, paths.commandsReport);

    await expect(getCacheStatus(cacheDir)).resolves.toMatchObject({
      commands: false,
      ready: false,
    });
    await expect(loadReferenceCache(cacheDir)).resolves.toBeUndefined();
  });
});
