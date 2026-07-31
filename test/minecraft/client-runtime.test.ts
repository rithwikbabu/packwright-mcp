import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createClientRuntimeManifest,
  createDarwinGraphicalSessionProbe,
  currentClientRuntimePlatform,
  evaluateMojangRules,
  libraryClassifierMatchesArchitecture,
  planNativeExtraction,
  preflightClientRuntime,
  preflightGraphicalSession,
  type ClientRuntimePlatform,
  type NativeExtractionRequirement,
} from '../../src/minecraft/client-runtime.js';

function sha1(value: Uint8Array | string): string {
  return createHash('sha1').update(value).digest('hex');
}

const CLIENT = Buffer.from('client fixture');
const LOGGING = Buffer.from('logging fixture');
const LIBRARY = Buffer.from('library fixture');
const CLASSIFIER_LIBRARY = Buffer.from('classifier library fixture');
const MAC_NATIVE = Buffer.from('mac native fixture');
const ARM_LIBRARY = Buffer.from('arm library fixture');
const ASSET_ONE = Buffer.from('asset one');

const DARWIN_ARM: ClientRuntimePlatform = {
  os: 'osx',
  architecture: 'arm64',
  ruleArchitecture: 'aarch64',
  osVersion: '25.0.0',
  bits: 64,
};

describe('Minecraft 26.2 classified native architecture selection', () => {
  it.each([
    ['org.lwjgl:lwjgl:3.4.1:natives-macos-arm64', true],
    ['org.lwjgl:lwjgl:3.4.1:natives-macos', false],
    ['io.netty:netty-kqueue:4.2.15.Final:osx-aarch_64', true],
    ['io.netty:netty-kqueue:4.2.15.Final:osx-x86_64', false],
    ['example:native:1.0:macos-arm64', true],
    ['example:native:1.0:linux-aarch_64', false],
    ['example:native:1.0:windows-aarch_64', false],
    ['org.lwjgl:lwjgl:3.4.1:unsafe', true],
    ['org.lwjgl:lwjgl:3.4.1', true],
  ])('selects the Apple-silicon artifact for %s', (coordinate, expected) => {
    expect(libraryClassifierMatchesArchitecture(coordinate, DARWIN_ARM)).toBe(expected);
  });

  it('selects the historical unqualified macOS native on Intel', () => {
    expect(
      libraryClassifierMatchesArchitecture('org.lwjgl:lwjgl:3.4.1:natives-macos', {
        ...DARWIN_ARM,
        architecture: 'x86_64',
        ruleArchitecture: 'x86_64',
      }),
    ).toBe(true);
  });

  it('selects explicit 32-bit ARM classifiers only on 32-bit ARM', () => {
    expect(
      libraryClassifierMatchesArchitecture('example:native:1.0:linux-armv7', {
        os: 'linux',
        architecture: 'arm32',
        ruleArchitecture: 'arm',
        osVersion: 'fixture',
        bits: 32,
      }),
    ).toBe(true);
    expect(
      libraryClassifierMatchesArchitecture('example:native:1.0:linux-armv7', {
        os: 'linux',
        architecture: 'arm64',
        ruleArchitecture: 'aarch64',
        osVersion: 'fixture',
        bits: 64,
      }),
    ).toBe(false);
  });
});

function libraryDownload(relativePath: string, bytes: Buffer): Record<string, unknown> {
  return {
    path: relativePath,
    sha1: sha1(bytes),
    size: bytes.length,
    url: `https://libraries.minecraft.net/${relativePath}`,
  };
}

function fixture(): {
  readonly versionBytes: Buffer;
  readonly assetIndexBytes: Buffer;
  readonly contents: ReadonlyMap<string, Buffer>;
} {
  const assetHash = sha1(ASSET_ONE);
  const assetIndexBytes = Buffer.from(
    JSON.stringify({
      objects: {
        'minecraft/textures/item/one.png': { hash: assetHash, size: ASSET_ONE.length },
        'minecraft/textures/item/alias.png': { hash: assetHash, size: ASSET_ONE.length },
      },
    }),
  );
  const metadata = {
    id: '26.2',
    javaVersion: { component: 'java-runtime-delta', majorVersion: 25 },
    mainClass: 'net.minecraft.client.main.Main',
    downloads: {
      client: {
        sha1: sha1(CLIENT),
        size: CLIENT.length,
        url: 'https://piston-data.mojang.com/test/client.jar',
      },
    },
    assetIndex: {
      id: '26.2-test',
      sha1: sha1(assetIndexBytes),
      size: assetIndexBytes.length,
      totalSize: ASSET_ONE.length,
      url: 'https://piston-meta.mojang.com/test/assets.json',
    },
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        type: 'log4j2-xml',
        file: {
          id: 'client-26.2.xml',
          sha1: sha1(LOGGING),
          size: LOGGING.length,
          url: 'https://launcher.mojang.com/test/client.xml',
        },
      },
    },
    libraries: [
      {
        name: 'example:common:1.0',
        downloads: {
          artifact: libraryDownload('example/common/1.0/common-1.0.jar', LIBRARY),
        },
      },
      {
        name: 'example:classified:1.0:natives-linux',
        downloads: {
          artifact: libraryDownload(
            'example/classified/1.0/classified-1.0-natives-linux.jar',
            CLASSIFIER_LIBRARY,
          ),
        },
      },
      {
        name: 'example:windows-only:1.0',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: {
          artifact: libraryDownload('example/windows/1.0/windows-1.0.jar', LIBRARY),
        },
      },
      {
        name: 'example:native:1.0',
        natives: { osx: 'natives-macos-${arch}' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          classifiers: {
            'natives-macos-64': libraryDownload(
              'example/native/1.0/native-1.0-natives-macos-64.jar',
              MAC_NATIVE,
            ),
          },
        },
      },
      {
        name: 'example:arm:1.0',
        rules: [
          { action: 'disallow' },
          { action: 'allow', os: { name: 'osx', arch: '^aarch64$' } },
        ],
        downloads: {
          artifact: libraryDownload('example/arm/1.0/arm-1.0.jar', ARM_LIBRARY),
        },
      },
    ],
  };
  const versionBytes = Buffer.from(JSON.stringify(metadata));
  return {
    versionBytes,
    assetIndexBytes,
    contents: new Map([
      ['versions/26.2/26.2.json', versionBytes],
      ['versions/26.2/26.2.jar', CLIENT],
      ['assets/indexes/26.2-test.json', assetIndexBytes],
      ['assets/log_configs/client-26.2.xml', LOGGING],
      ['libraries/example/common/1.0/common-1.0.jar', LIBRARY],
      ['libraries/example/classified/1.0/classified-1.0-natives-linux.jar', CLASSIFIER_LIBRARY],
      ['libraries/example/native/1.0/native-1.0-natives-macos-64.jar', MAC_NATIVE],
      ['libraries/example/arm/1.0/arm-1.0.jar', ARM_LIBRARY],
      [`assets/objects/${assetHash.slice(0, 2)}/${assetHash}`, ASSET_ONE],
    ]),
  };
}

function runtimeFixture() {
  const data = fixture();
  return {
    ...data,
    runtime: createClientRuntimeManifest(data.versionBytes, data.assetIndexBytes, DARWIN_ARM, {
      expectedVersionMetadataSha1: sha1(data.versionBytes),
      versionMetadataUrl: 'https://piston-meta.mojang.com/test/26.2.json',
    }),
  };
}

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe('Minecraft client runtime metadata', () => {
  it('selects platform libraries and natives and produces a canonical stable manifest', () => {
    const first = runtimeFixture();
    const second = runtimeFixture();

    expect(first.runtime.sha256).toBe(second.runtime.sha256);
    expect(first.runtime.manifest).toMatchObject({
      minecraftVersion: '26.2',
      javaMajor: 25,
      mainClass: 'net.minecraft.client.main.Main',
      assetIndexId: '26.2-test',
    });
    const paths = first.runtime.manifest.artifacts.map((artifact) => artifact.cachePath);
    expect(paths).toContain('libraries/example/common/1.0/common-1.0.jar');
    expect(paths).not.toContain(
      'libraries/example/classified/1.0/classified-1.0-natives-linux.jar',
    );
    expect(paths).toContain('libraries/example/arm/1.0/arm-1.0.jar');
    expect(paths).toContain('libraries/example/native/1.0/native-1.0-natives-macos-64.jar');
    expect(paths).not.toContain('libraries/example/windows/1.0/windows-1.0.jar');
    const asset = first.runtime.manifest.artifacts.find((artifact) => artifact.kind === 'asset');
    expect(asset?.logicalNames).toEqual([
      'minecraft/textures/item/alias.png',
      'minecraft/textures/item/one.png',
    ]);
    expect(first.runtime.manifest.nativeExtractions).toEqual([
      expect.objectContaining({ classifier: 'natives-macos-64', excludes: ['META-INF/'] }),
    ]);
  });

  it('implements Mojang ordered allow/disallow OS and architecture rules', () => {
    expect(
      evaluateMojangRules(
        [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx', arch: '^aarch64$' } }],
        DARWIN_ARM,
      ),
    ).toBe(false);
    expect(
      evaluateMojangRules(
        [{ action: 'disallow' }, { action: 'allow', os: { name: 'osx', version: '^25\\.' } }],
        DARWIN_ARM,
      ),
    ).toBe(true);
    expect(currentClientRuntimePlatform('darwin', 'arm64', '25.0.0')).toEqual(DARWIN_ARM);
  });

  it('fails closed on an unpinned version document, damaged asset index, or unsafe library path', () => {
    const data = fixture();
    expect(() =>
      createClientRuntimeManifest(data.versionBytes, data.assetIndexBytes, DARWIN_ARM, {
        expectedVersionMetadataSha1: '0'.repeat(40),
      }),
    ).toThrow(/pinned SHA-1/u);

    expect(() =>
      createClientRuntimeManifest(data.versionBytes, Buffer.from('{}'), DARWIN_ARM, {
        expectedVersionMetadataSha1: sha1(data.versionBytes),
      }),
    ).toThrow(/asset index/u);

    const metadata = JSON.parse(data.versionBytes.toString('utf8')) as Record<string, unknown>;
    const libraries = metadata.libraries as Record<string, unknown>[];
    const downloads = libraries[0]?.downloads as Record<string, unknown>;
    downloads.artifact = {
      ...(downloads.artifact as Record<string, unknown>),
      path: '../escape.jar',
      url: 'https://libraries.minecraft.net/escape.jar',
    };
    const unsafe = Buffer.from(JSON.stringify(metadata));
    expect(() =>
      createClientRuntimeManifest(unsafe, data.assetIndexBytes, DARWIN_ARM, {
        expectedVersionMetadataSha1: sha1(unsafe),
      }),
    ).toThrow(/path/u);
  });
});

describe('Minecraft client runtime preflight', () => {
  it('verifies every regular artifact by size, SHA-1, and SHA-256', async () => {
    const data = runtimeFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-client-runtime-'));
    cleanups.push(root);
    for (const [relative, content] of data.contents) {
      const filename = path.join(root, ...relative.split('/'));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content);
    }

    const result = await preflightClientRuntime(root, data.runtime);

    expect(result).toMatchObject({
      ready: true,
      status: 'ready',
      artifactsChecked: data.runtime.manifest.artifacts.length,
      issues: [],
    });
    expect(result.verified).toHaveLength(data.runtime.manifest.artifacts.length);
    expect(result.verified.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256))).toBe(true);
  });

  it('returns setup_required for missing, corrupt, and symlinked artifacts', async () => {
    const data = runtimeFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-client-runtime-'));
    cleanups.push(root);
    const entries = [...data.contents.entries()];
    for (const [relative, content] of entries.slice(0, -1)) {
      const filename = path.join(root, ...relative.split('/'));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content);
    }
    const corruptRelative = 'versions/26.2/26.2.jar';
    await writeFile(path.join(root, corruptRelative), Buffer.alloc(CLIENT.length, 1));
    const libraryDirectory = path.join(root, 'libraries/example/common/1.0');
    await rm(libraryDirectory, { recursive: true });
    await mkdir(path.dirname(libraryDirectory), { recursive: true });
    await symlink(path.join(root, 'versions'), libraryDirectory);

    const result = await preflightClientRuntime(root, data.runtime);

    expect(result.ready).toBe(false);
    expect(result.status).toBe('setup_required');
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['hash_mismatch', 'missing', 'symlink']),
    );
  });
});

describe('native extraction planning', () => {
  const requirement: NativeExtractionRequirement = {
    library: 'example:native:1.0',
    classifier: 'natives-macos-64',
    artifactCachePath: 'libraries/example/native.jar',
    artifactSha1: 'a'.repeat(40),
    excludes: ['META-INF/'],
  };

  it('filters excluded metadata and returns sorted confined destinations', () => {
    expect(
      planNativeExtraction(
        requirement,
        [
          { name: 'z.dylib', compressedSize: 5, uncompressedSize: 10 },
          { name: 'META-INF/MANIFEST.MF', compressedSize: 5, uncompressedSize: 10 },
          { name: 'nested/a.dylib', compressedSize: 5, uncompressedSize: 10 },
        ],
        'natives/26.2/darwin-arm64',
      ),
    ).toMatchObject({
      totalBytes: 20,
      entries: [
        { destinationPath: 'natives/26.2/darwin-arm64/nested/a.dylib' },
        { destinationPath: 'natives/26.2/darwin-arm64/z.dylib' },
      ],
    });
  });

  it.each([
    { entries: [{ name: '../escape.dylib', compressedSize: 1, uncompressedSize: 1 }] },
    {
      entries: [{ name: 'link.dylib', compressedSize: 1, uncompressedSize: 1, unixMode: 0o120777 }],
    },
    { entries: [{ name: 'bomb.dylib', compressedSize: 1, uncompressedSize: 10_001 }] },
  ])('rejects unsafe native archive entries', ({ entries }) => {
    expect(() => planNativeExtraction(requirement, entries, 'natives/26.2')).toThrow();
  });
});

describe('graphical-session readiness', () => {
  it('parses an interactive macOS Aqua login domain through an injected runner', async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: 'type = login\ncreator = loginwindow[381]\nsession = Aqua',
        stderr: '',
      }),
    );
    const probe = createDarwinGraphicalSessionProbe(run, 501);

    await expect(preflightGraphicalSession(DARWIN_ARM, probe)).resolves.toEqual({
      ready: true,
      status: 'ready',
      probe: 'darwin-launchctl-aqua',
      message: 'An interactive logged-in macOS console session is available.',
    });
    expect(run).toHaveBeenCalledWith('/bin/launchctl', ['print', 'gui/501'], undefined);
  });

  it('returns setup_required without a probe or an interactive session', async () => {
    await expect(preflightGraphicalSession(DARWIN_ARM)).resolves.toMatchObject({
      ready: false,
      status: 'setup_required',
    });
    const probe = createDarwinGraphicalSessionProbe(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: 'type = login;\nsession = Background;',
          stderr: '',
        }),
      501,
    );
    await expect(preflightGraphicalSession(DARWIN_ARM, probe)).resolves.toMatchObject({
      ready: false,
      status: 'setup_required',
    });
  });
});
