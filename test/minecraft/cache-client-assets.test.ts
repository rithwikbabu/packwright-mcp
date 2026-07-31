import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/version.js', () => ({
  MINECRAFT_26_2: {
    minecraftVersion: '26.2',
    javaMajor: 25,
    supportedRegistries: [],
    artifacts: {
      versionMetadataUrl: 'https://piston-meta.mojang.com/test/26.2.json',
      versionMetadataSha1: '4605de0688ab80360142f232a71a19db9819e148',
      serverUrl: 'https://piston-data.mojang.com/test/server.jar',
      serverSha1: 'e5fbb7efa3017d4c96e302aee8bc25ff72f3b486',
      serverSize: 15,
    },
    resourcePack: {
      artifacts: {
        versionMetadataSha1: '4605de0688ab80360142f232a71a19db9819e148',
      },
    },
  },
  RESOURCE_TYPES: [],
}));

import type { RuntimeConfig } from '../../src/config.js';
import {
  VERSION_MANIFEST_URL,
  cachePaths,
  getCacheStatus,
  setupVersion,
} from '../../src/minecraft/cache.js';

const SERVER = 'server fixture\n';
const CLIENT = 'client fixture\n';
const ASSET_INDEX = '{"objects":{}}\n';
const METADATA =
  '{"id":"26.2","downloads":{"server":{"sha1":"e5fbb7efa3017d4c96e302aee8bc25ff72f3b486","size":15,"url":"https://piston-data.mojang.com/test/server.jar"},"client":{"sha1":"645ef8efd9830bf9a1d1bf5347ae34e60aa44bbc","size":15,"url":"https://piston-data.mojang.com/test/client.jar"}},"assetIndex":{"id":"26.2-test","sha1":"5a48d9fc5877b925eaa65ddef68cb5dbaee9df64","size":15,"totalSize":15,"url":"https://piston-meta.mojang.com/test/assets.json"}}';
const MANIFEST =
  '{"versions":[{"id":"26.2","url":"https://piston-meta.mojang.com/test/26.2.json","sha1":"4605de0688ab80360142f232a71a19db9819e148"}]}';

function response(value: string): Response {
  return new Response(value, {
    status: 200,
    headers: { 'content-length': String(Buffer.byteLength(value)) },
  });
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : input.toString();
}

function installOfficialFetch(): { readonly urls: string[] } {
  const responses = new Map<string, string>([
    [VERSION_MANIFEST_URL, MANIFEST],
    ['https://piston-meta.mojang.com/test/26.2.json', METADATA],
    ['https://piston-data.mojang.com/test/server.jar', SERVER],
    ['https://piston-data.mojang.com/test/client.jar', CLIENT],
    ['https://piston-meta.mojang.com/test/assets.json', ASSET_INDEX],
  ]);
  const urls: string[] = [];
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = urlOf(input);
    urls.push(url);
    const value = responses.get(url);
    if (value === undefined) throw new Error(`Unexpected test URL: ${url}`);
    return Promise.resolve(response(value));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { urls };
}

describe('Minecraft client-assets setup', () => {
  let root: string;
  let config: RuntimeConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'packwright-client-cache-'));
    const workspaceRoot = path.join(root, 'workspace');
    const javaCommand = path.join(root, 'java-25');
    await mkdir(workspaceRoot);
    await writeFile(
      javaCommand,
      [
        '#!/bin/sh',
        'if [ "$1" = "-version" ]; then',
        '  echo \'openjdk version "25.0.1"\' >&2',
        '  exit 0',
        'fi',
        'mkdir -p generated/reports',
        "printf '{}\\n' > generated/reports/commands.json",
        "printf '{}\\n' > generated/reports/registries.json",
      ].join('\n'),
      'utf8',
    );
    await chmod(javaCommand, 0o700);
    config = {
      workspaceRoot,
      javaCommand,
      cacheDir: path.join(root, 'cache'),
      readOnly: false,
      offline: false,
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it('downloads and records only explicitly selected manifest-verified client artifacts', async () => {
    const fetched = installOfficialFetch();

    const result = await setupVersion(config, true, undefined, { clientAssets: true });
    const paths = cachePaths(config.cacheDir);

    expect(result.clientAssets).toMatchObject({
      selected: true,
      ready: true,
      clientJar: paths.clientJar,
      clientSha1: '645ef8efd9830bf9a1d1bf5347ae34e60aa44bbc',
      assetIndex: paths.assetIndex,
      assetIndexId: '26.2-test',
      assetIndexSha1: '5a48d9fc5877b925eaa65ddef68cb5dbaee9df64',
    });
    await expect(readFile(paths.clientJar, 'utf8')).resolves.toBe(CLIENT);
    await expect(readFile(paths.assetIndex, 'utf8')).resolves.toBe(ASSET_INDEX);
    await expect(getCacheStatus(config.cacheDir, true)).resolves.toMatchObject({
      ready: true,
      clientAssets: {
        selected: true,
        ready: true,
        metadataVerified: true,
        clientJarVerified: true,
        assetIndexVerified: true,
      },
      record: {
        clientAssets: {
          versionMetadataSha1: '4605de0688ab80360142f232a71a19db9819e148',
        },
      },
    });
    expect(fetched.urls).toContain('https://piston-data.mojang.com/test/client.jar');

    vi.unstubAllGlobals();
    const offlineFetch = vi.fn(() => Promise.reject(new Error('network must not be used')));
    vi.stubGlobal('fetch', offlineFetch);
    const offlineResult = await setupVersion({ ...config, offline: true }, true, undefined, {
      clientAssets: true,
    });
    expect(offlineResult.clientAssets.ready).toBe(true);
    expect(offlineFetch).not.toHaveBeenCalled();
  });

  it('does not fetch client artifacts unless --client-assets is selected', async () => {
    const fetched = installOfficialFetch();

    const result = await setupVersion(config, true);
    const paths = cachePaths(config.cacheDir);

    expect(result.clientAssets).toEqual({ selected: false, ready: false });
    await expect(readFile(paths.clientJar)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.assetIndex)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetched.urls).not.toContain('https://piston-data.mojang.com/test/client.jar');
  });

  it('fails closed on a corrupted cached client artifact while offline', async () => {
    installOfficialFetch();
    await setupVersion(config, true, undefined, { clientAssets: true });
    await writeFile(cachePaths(config.cacheDir).clientJar, 'corrupt', 'utf8');

    await expect(
      setupVersion({ ...config, offline: true }, true, undefined, { clientAssets: true }),
    ).rejects.toMatchObject({
      name: 'PackwrightError',
      code: 'invalid_content',
    });
  });
});
