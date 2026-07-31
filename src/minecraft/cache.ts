import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PackwrightError } from '../core/errors.js';
import { readStableFile } from '../core/stable-file.js';
import type { Diagnostic } from '../core/types.js';
import { MINECRAFT_26_2, RESOURCE_TYPES } from '../core/version.js';
import { assertRuntimePathSeparation, type RuntimeConfig } from '../config.js';
import { getJavaVersion } from './java.js';
import { runProcess } from '../runtime/process.js';

export const VERSION_MANIFEST_URL =
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'launcher.mojang.com',
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
]);

interface VersionManifestEntry {
  readonly id: string;
  readonly url: string;
  readonly sha1?: string;
}

interface VersionManifest {
  readonly versions: readonly VersionManifestEntry[];
}

interface VersionMetadata {
  readonly id: string;
  readonly downloads: {
    readonly client?: DownloadArtifact;
    readonly server?: {
      readonly sha1: string;
      readonly size?: number;
      readonly url: string;
    };
  };
  readonly assetIndex?: AssetIndexArtifact;
}

interface DownloadArtifact {
  readonly sha1: string;
  readonly size: number;
  readonly url: string;
}

interface AssetIndexArtifact extends DownloadArtifact {
  readonly id: string;
  readonly totalSize?: number;
}

type JsonObject = Record<string, unknown>;

export interface SetupRecord {
  readonly minecraftVersion: '26.2';
  readonly acceptedMinecraftEulaAt: string;
  readonly generatedAt: string;
  readonly serverSha1: string;
  readonly versionManifestUrl: string;
  readonly clientAssets?: ClientAssetsSetupRecord;
}

export interface ClientAssetsSetupRecord {
  readonly preparedAt: string;
  readonly versionMetadataSha1: string;
  readonly clientSha1: string;
  readonly clientSize: number;
  readonly assetIndexId: string;
  readonly assetIndexSha1: string;
  readonly assetIndexSize: number;
}

export interface CachePaths {
  readonly versionDir: string;
  readonly serverJar: string;
  readonly clientJar: string;
  readonly assetIndex: string;
  readonly setupRecord: string;
  readonly versionMetadata: string;
  readonly commandsReport: string;
  readonly registriesReport: string;
}

export interface CacheStatus {
  readonly ready: boolean;
  readonly jar: boolean;
  readonly jarVerified: boolean;
  readonly versionMetadata: boolean;
  readonly versionMetadataVerified: boolean;
  readonly acceptedEula: boolean;
  readonly commands: boolean;
  readonly registries: boolean;
  /** Present in new Packwright versions; optional so existing API mocks remain source-compatible. */
  readonly clientAssets?: ClientAssetsCacheStatus;
  readonly record?: SetupRecord;
}

export interface ClientAssetsCacheStatus {
  readonly selected: boolean;
  readonly ready: boolean;
  readonly metadataVerified: boolean;
  readonly clientJar: boolean;
  readonly clientJarVerified: boolean;
  readonly assetIndex: boolean;
  readonly assetIndexVerified: boolean;
}

export interface SetupVersionOptions {
  readonly clientAssets?: boolean;
}

export interface SetupVersionResult {
  readonly ok: boolean;
  readonly minecraftVersion: '26.2';
  readonly cacheDir: string;
  readonly serverSha1: string;
  readonly commandsReport: string;
  readonly registriesReport: string;
  readonly generatedAt: string;
  readonly clientAssets: {
    readonly selected: boolean;
    readonly ready: boolean;
    readonly clientJar?: string;
    readonly clientSha1?: string;
    readonly assetIndex?: string;
    readonly assetIndexId?: string;
    readonly assetIndexSha1?: string;
  };
}

export interface ReferenceCache {
  readonly generatedAt?: string;
  readonly commands: unknown;
  readonly registries: unknown;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function cachePaths(cacheDir: string): CachePaths {
  const versionDir = path.join(cacheDir, 'versions', '26.2');
  const reports = path.join(versionDir, 'reports');
  return {
    versionDir,
    serverJar: path.join(versionDir, 'server.jar'),
    clientJar: path.join(versionDir, 'client.jar'),
    assetIndex: path.join(versionDir, 'asset-index.json'),
    setupRecord: path.join(versionDir, 'setup.json'),
    versionMetadata: path.join(versionDir, 'version.json'),
    commandsReport: path.join(reports, 'commands.json'),
    registriesReport: path.join(reports, 'registries.json'),
  };
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filename: string, maxBytes = MAX_METADATA_BYTES): Promise<T> {
  const stable = await readStableFile(filename, {
    maxBytes,
    collect: true,
    pathLabel: filename,
  });
  if (stable.data === undefined) {
    throw new PackwrightError('invalid_content', `Cached JSON could not be read: ${filename}`);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stable.data)) as T;
}

async function readCachedVersionMetadata(filename: string): Promise<{
  readonly metadata: VersionMetadata;
  readonly manifestSha1Verified: boolean;
}> {
  const stable = await readStableFile(filename, {
    maxBytes: MAX_METADATA_BYTES,
    collect: true,
    pathLabel: filename,
  });
  if (stable.data === undefined) {
    throw new PackwrightError('invalid_content', 'Cached Minecraft version metadata is empty.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(stable.data);
  return {
    metadata: versionMetadata(JSON.parse(text) as unknown),
    manifestSha1Verified:
      createHash('sha1').update(stable.data).digest('hex') ===
      MINECRAFT_26_2.resourcePack.artifacts.versionMetadataSha1,
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSha1(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function clientAssetsSetupRecord(value: unknown): ClientAssetsSetupRecord | undefined {
  const object = asObject(value);
  if (
    !isIsoTimestamp(object?.preparedAt) ||
    object.versionMetadataSha1 !== MINECRAFT_26_2.resourcePack.artifacts.versionMetadataSha1 ||
    !isSha1(object.clientSha1) ||
    !isPositiveSafeInteger(object.clientSize) ||
    typeof object.assetIndexId !== 'string' ||
    object.assetIndexId.length === 0 ||
    !isSha1(object.assetIndexSha1) ||
    !isPositiveSafeInteger(object.assetIndexSize)
  ) {
    return undefined;
  }
  return object as unknown as ClientAssetsSetupRecord;
}

function setupRecord(value: unknown): SetupRecord | undefined {
  const object = asObject(value);
  if (
    object?.minecraftVersion !== '26.2' ||
    !isIsoTimestamp(object.acceptedMinecraftEulaAt) ||
    !isIsoTimestamp(object.generatedAt) ||
    object.serverSha1 !== MINECRAFT_26_2.artifacts.serverSha1 ||
    object.versionManifestUrl !== VERSION_MANIFEST_URL
  ) {
    return undefined;
  }
  if (Date.parse(object.acceptedMinecraftEulaAt) > Date.parse(object.generatedAt)) {
    return undefined;
  }
  const clientAssets =
    object.clientAssets === undefined ? undefined : clientAssetsSetupRecord(object.clientAssets);
  if (object.clientAssets !== undefined && clientAssets === undefined) return undefined;
  if (
    clientAssets !== undefined &&
    Date.parse(clientAssets.preparedAt) > Date.parse(object.generatedAt)
  ) {
    return undefined;
  }
  return {
    minecraftVersion: '26.2',
    acceptedMinecraftEulaAt: object.acceptedMinecraftEulaAt,
    generatedAt: object.generatedAt,
    serverSha1: MINECRAFT_26_2.artifacts.serverSha1,
    versionManifestUrl: VERSION_MANIFEST_URL,
    ...(clientAssets === undefined ? {} : { clientAssets }),
  };
}

function versionManifest(value: unknown): VersionManifest {
  const object = asObject(value);
  if (!Array.isArray(object?.versions)) {
    throw new PackwrightError('invalid_content', 'Mojang returned a malformed version manifest.');
  }
  const versions: VersionManifestEntry[] = [];
  for (const raw of object.versions) {
    const entry = asObject(raw);
    if (
      typeof entry?.id === 'string' &&
      typeof entry.url === 'string' &&
      (entry.sha1 === undefined || typeof entry.sha1 === 'string')
    ) {
      versions.push({
        id: entry.id,
        url: entry.url,
        ...(entry.sha1 === undefined ? {} : { sha1: entry.sha1 }),
      });
    }
  }
  return { versions };
}

function downloadArtifact(value: unknown, label: string): DownloadArtifact | undefined {
  if (value === undefined) return undefined;
  const object = asObject(value);
  if (
    !isSha1(object?.sha1) ||
    !isPositiveSafeInteger(object.size) ||
    typeof object.url !== 'string'
  ) {
    throw new PackwrightError(
      'invalid_content',
      `Minecraft 26.2 metadata contains a malformed ${label} artifact.`,
    );
  }
  assertOfficialUrl(object.url);
  return { sha1: object.sha1, size: object.size, url: object.url };
}

function assetIndexArtifact(value: unknown): AssetIndexArtifact | undefined {
  if (value === undefined) return undefined;
  const object = asObject(value);
  const download = downloadArtifact(value, 'asset index');
  if (download === undefined || typeof object?.id !== 'string' || object.id.length === 0) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft 26.2 metadata contains a malformed asset index.',
    );
  }
  const totalSize = object.totalSize;
  if (totalSize !== undefined && !isPositiveSafeInteger(totalSize)) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft 26.2 metadata contains an invalid asset-index total size.',
    );
  }
  return {
    ...download,
    id: object.id,
    ...(totalSize === undefined ? {} : { totalSize }),
  };
}

function versionMetadata(value: unknown): VersionMetadata {
  const object = asObject(value);
  const downloads = asObject(object?.downloads);
  const server = asObject(downloads?.server);
  const artifacts = MINECRAFT_26_2.artifacts;
  if (
    object?.id !== '26.2' ||
    server?.sha1 !== artifacts.serverSha1 ||
    server.url !== artifacts.serverUrl ||
    server.size !== artifacts.serverSize
  ) {
    throw new PackwrightError(
      'invalid_content',
      "Minecraft 26.2 metadata does not match Packwright's pinned official server artifact.",
    );
  }
  const client = downloadArtifact(downloads?.client, 'client');
  const assetIndex = assetIndexArtifact(object.assetIndex);
  return {
    id: '26.2',
    downloads: {
      ...(client === undefined ? {} : { client }),
      server: {
        sha1: artifacts.serverSha1,
        size: artifacts.serverSize,
        url: artifacts.serverUrl,
      },
    },
    ...(assetIndex === undefined ? {} : { assetIndex }),
  };
}

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  await writeTextAtomic(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filename: string, value: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, value, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyFileAtomic(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertOfficialUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
    throw new PackwrightError(
      'invalid_content',
      `Mojang metadata returned an untrusted download URL: ${url.origin}`,
    );
  }
  return url;
}

async function fetchJson(
  url: string,
  signal?: AbortSignal,
): Promise<{ readonly value: unknown; readonly sha1: string; readonly rawText: string }> {
  assertOfficialUrl(url);
  const response = await fetch(url, {
    headers: { 'user-agent': 'packwright-mcp/0.3.0' },
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Request failed (${String(response.status)}) for ${url}`);
  }
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > MAX_METADATA_BYTES) {
    throw new PackwrightError('size_limit', 'Mojang metadata response is unexpectedly large.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
    throw new PackwrightError('size_limit', 'Mojang metadata response is unexpectedly large.');
  }
  return {
    value: JSON.parse(text) as unknown,
    sha1: createHash('sha1').update(text, 'utf8').digest('hex'),
    rawText: text,
  };
}

async function sha1File(filename: string): Promise<string> {
  const hash = createHash('sha1');
  await pipeline(createReadStream(filename), hash);
  return hash.digest('hex');
}

const artifactVerificationCache = new Map<
  string,
  {
    readonly device: number;
    readonly inode: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
    readonly expected: string;
    readonly valid: boolean;
  }
>();

async function verifyCachedArtifact(
  filename: string,
  expected: string,
  expectedSize: number,
  force: boolean,
): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/u.test(expected)) return false;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size !== expectedSize) return false;
    const cached = artifactVerificationCache.get(filename);
    if (
      !force &&
      cached?.device === info.dev &&
      cached.inode === info.ino &&
      cached.size === info.size &&
      cached.mtimeMs === info.mtimeMs &&
      cached.ctimeMs === info.ctimeMs &&
      cached.expected === expected
    ) {
      return cached.valid;
    }

    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let valid = false;
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        before.size !== expectedSize
      ) {
        return false;
      }
      const hash = createHash('sha1');
      await pipeline(handle.createReadStream({ autoClose: false }), hash);
      const after = await handle.stat();
      const pathAfter = await lstat(filename);
      valid =
        hash.digest('hex') === expected &&
        sameFileIdentity(before, after) &&
        sameFileIdentity(after, pathAfter) &&
        !pathAfter.isSymbolicLink();
    } finally {
      await handle.close();
    }
    artifactVerificationCache.set(filename, {
      device: info.dev,
      inode: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      expected,
      valid,
    });
    return valid;
  } catch {
    return false;
  }
}

/** Copy the pinned server JAR through one no-follow handle into private execution staging. */
export async function copyVerifiedServerJar(
  cacheDir: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const source = cachePaths(cacheDir).serverJar;
  const artifacts = MINECRAFT_26_2.artifacts;
  const pathInfo = await lstat(source);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size !== artifacts.serverSize) {
    throw new PackwrightError('invalid_content', 'Cached Minecraft server JAR is not trusted.');
  }
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || !sameFileIdentity(pathInfo, before)) {
      throw new PackwrightError('precondition_failed', 'Cached server JAR changed before staging.');
    }
    destinationHandle = await open(destination, 'wx', 0o600);
    const hash = createHash('sha1');
    let position = 0;
    while (position < before.size) {
      if (signal?.aborted) {
        throw new PackwrightError('cancelled', 'Minecraft server JAR staging was cancelled.');
      }
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, before.size - position));
      const read = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await destinationHandle.write(
          chunk,
          written,
          chunk.length - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += read.bytesRead;
    }
    const after = await sourceHandle.stat();
    const finalPathInfo = await lstat(source);
    if (
      position !== artifacts.serverSize ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, finalPathInfo) ||
      hash.digest('hex') !== artifacts.serverSha1
    ) {
      throw new PackwrightError(
        'precondition_failed',
        'Cached server JAR changed or failed verification during staging.',
      );
    }
    await destinationHandle.sync();
  } catch (error) {
    await destinationHandle?.close().catch(() => undefined);
    destinationHandle = undefined;
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close();
  }
}

async function downloadVerified(
  urlValue: string,
  destination: string,
  expectedSha1: string,
  expectedSize?: number,
  signal?: AbortSignal,
): Promise<void> {
  const url = assertOfficialUrl(urlValue);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'packwright-mcp/0.3.0' },
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed (${String(response.status)}) for ${url.href}`);
    }
    const declaredSize = Number(response.headers.get('content-length') ?? '0');
    if (expectedSize !== undefined && declaredSize !== 0 && declaredSize !== expectedSize) {
      throw new Error(
        `Artifact size mismatch before download (expected ${String(expectedSize)}, received ${String(declaredSize)}).`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const info = await stat(temporary);
    if (expectedSize !== undefined && info.size !== expectedSize) {
      throw new Error(
        `Artifact size mismatch (expected ${String(expectedSize)}, received ${String(info.size)}).`,
      );
    }
    const actualSha1 = await sha1File(temporary);
    if (actualSha1 !== expectedSha1.toLowerCase()) {
      throw new Error(
        `Artifact SHA-1 mismatch (expected ${expectedSha1}, received ${actualSha1}).`,
      );
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getCacheStatus(
  cacheDir: string,
  forceJarVerification = false,
): Promise<CacheStatus> {
  const paths = cachePaths(cacheDir);
  const [jar, clientJar, assetIndex, versionMetadataPresent, commands, registries, acceptedEula] =
    await Promise.all([
      fileExists(paths.serverJar),
      fileExists(paths.clientJar),
      fileExists(paths.assetIndex),
      fileExists(paths.versionMetadata),
      fileExists(paths.commandsReport),
      fileExists(paths.registriesReport),
      fileExists(paths.setupRecord),
    ]);
  let record: SetupRecord | undefined;
  if (acceptedEula) {
    try {
      record = setupRecord(await readJsonFile<unknown>(paths.setupRecord));
    } catch {
      record = undefined;
    }
  }
  let versionMetadataVerified = false;
  let cachedMetadata:
    { readonly metadata: VersionMetadata; readonly manifestSha1Verified: boolean } | undefined;
  if (versionMetadataPresent) {
    try {
      cachedMetadata = await readCachedVersionMetadata(paths.versionMetadata);
      versionMetadataVerified = true;
    } catch {
      versionMetadataVerified = false;
    }
  }
  const artifacts = MINECRAFT_26_2.artifacts;
  const jarVerified =
    jar && record !== undefined
      ? await verifyCachedArtifact(
          paths.serverJar,
          artifacts.serverSha1,
          artifacts.serverSize,
          forceJarVerification,
        )
      : false;
  const clientRecord = record?.clientAssets;
  const clientMetadata = cachedMetadata?.metadata.downloads.client;
  const assetIndexMetadata = cachedMetadata?.metadata.assetIndex;
  const clientMetadataVerified =
    cachedMetadata?.manifestSha1Verified === true &&
    clientRecord !== undefined &&
    clientMetadata !== undefined &&
    assetIndexMetadata !== undefined &&
    clientRecord.versionMetadataSha1 ===
      MINECRAFT_26_2.resourcePack.artifacts.versionMetadataSha1 &&
    clientRecord.clientSha1 === clientMetadata.sha1 &&
    clientRecord.clientSize === clientMetadata.size &&
    clientRecord.assetIndexId === assetIndexMetadata.id &&
    clientRecord.assetIndexSha1 === assetIndexMetadata.sha1 &&
    clientRecord.assetIndexSize === assetIndexMetadata.size;
  const clientJarVerified =
    clientJar && clientMetadataVerified
      ? await verifyCachedArtifact(
          paths.clientJar,
          clientMetadata.sha1,
          clientMetadata.size,
          forceJarVerification,
        )
      : false;
  const assetIndexVerified =
    assetIndex && clientMetadataVerified
      ? await verifyCachedArtifact(
          paths.assetIndex,
          assetIndexMetadata.sha1,
          assetIndexMetadata.size,
          forceJarVerification,
        )
      : false;
  return {
    ready: jarVerified && versionMetadataVerified && commands && registries && record !== undefined,
    jar,
    jarVerified,
    versionMetadata: versionMetadataPresent,
    versionMetadataVerified,
    acceptedEula: record !== undefined,
    commands,
    registries,
    clientAssets: {
      selected: clientRecord !== undefined,
      ready: clientJarVerified && assetIndexVerified,
      metadataVerified: clientMetadataVerified,
      clientJar,
      clientJarVerified,
      assetIndex,
      assetIndexVerified,
    },
    ...(record === undefined ? {} : { record }),
  };
}

async function fetchPinnedVersionMetadata(signal?: AbortSignal): Promise<{
  readonly metadata: VersionMetadata;
  readonly rawText: string;
}> {
  const manifestResponse = await fetchJson(VERSION_MANIFEST_URL, signal);
  const manifest = versionManifest(manifestResponse.value);
  const entry = manifest.versions.find((candidate) => candidate.id === '26.2');
  if (entry === undefined) {
    throw new Error("Minecraft 26.2 is absent from Mojang's official version manifest.");
  }
  const artifacts = MINECRAFT_26_2.artifacts;
  if (entry.url !== artifacts.versionMetadataUrl || entry.sha1 !== artifacts.versionMetadataSha1) {
    throw new PackwrightError(
      'invalid_content',
      "Mojang's version manifest entry for 26.2 does not match Packwright's pinned metadata.",
    );
  }
  const metadataResponse = await fetchJson(entry.url, signal);
  if (metadataResponse.sha1 !== artifacts.versionMetadataSha1) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft 26.2 metadata failed its manifest SHA-1 verification.',
    );
  }
  return {
    metadata: versionMetadata(metadataResponse.value),
    rawText: metadataResponse.rawText,
  };
}

async function prepareServerJar(
  config: RuntimeConfig,
  signal?: AbortSignal,
  requireClientAssets = false,
): Promise<{
  readonly metadata: VersionMetadata;
  readonly sha1: string;
}> {
  const paths = cachePaths(config.cacheDir);
  let cachedMetadata:
    { readonly metadata: VersionMetadata; readonly manifestSha1Verified: boolean } | undefined;
  if (await fileExists(paths.versionMetadata)) {
    try {
      cachedMetadata = await readCachedVersionMetadata(paths.versionMetadata);
    } catch (error) {
      if (config.offline) {
        throw new PackwrightError(
          'invalid_content',
          'The cached Minecraft 26.2 version metadata is malformed or does not match the pinned official artifact.',
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      cachedMetadata = undefined;
    }
  }

  const clientMetadataMissing =
    cachedMetadata?.manifestSha1Verified !== true ||
    cachedMetadata.metadata.downloads.client === undefined ||
    cachedMetadata.metadata.assetIndex === undefined;
  if (cachedMetadata === undefined || (requireClientAssets && clientMetadataMissing)) {
    if (config.offline) {
      throw new PackwrightError(
        'not_found',
        requireClientAssets
          ? 'Manifest-verified Minecraft 26.2 client metadata is not cached and offline mode forbids setup downloads.'
          : 'Minecraft 26.2 metadata is not cached and offline mode forbids setup downloads.',
      );
    }
    const downloaded = await fetchPinnedVersionMetadata(signal);
    await writeTextAtomic(paths.versionMetadata, downloaded.rawText);
    cachedMetadata = { metadata: downloaded.metadata, manifestSha1Verified: true };
  }

  const metadata = cachedMetadata.metadata;
  const server = metadata.downloads.server;
  if (server === undefined) throw new Error('Pinned Minecraft server metadata is unavailable.');

  if (await fileExists(paths.serverJar)) {
    const verified = await verifyCachedArtifact(
      paths.serverJar,
      MINECRAFT_26_2.artifacts.serverSha1,
      MINECRAFT_26_2.artifacts.serverSize,
      true,
    );
    if (!verified) {
      if (config.offline) {
        throw new Error('The cached Minecraft server jar failed SHA-1 verification.');
      }
      await rm(paths.serverJar, { force: true });
    }
  }
  if (!(await fileExists(paths.serverJar))) {
    if (config.offline) {
      throw new PackwrightError(
        'not_found',
        'The Minecraft 26.2 server jar is not cached and offline mode forbids downloads.',
      );
    }
    await downloadVerified(
      MINECRAFT_26_2.artifacts.serverUrl,
      paths.serverJar,
      MINECRAFT_26_2.artifacts.serverSha1,
      MINECRAFT_26_2.artifacts.serverSize,
      signal,
    );
  }
  return { metadata, sha1: MINECRAFT_26_2.artifacts.serverSha1 };
}

async function ensureVerifiedArtifact(
  config: RuntimeConfig,
  artifact: DownloadArtifact,
  destination: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  if (await fileExists(destination)) {
    const verified = await verifyCachedArtifact(destination, artifact.sha1, artifact.size, true);
    if (!verified) {
      if (config.offline) {
        throw new PackwrightError(
          'invalid_content',
          `The cached Minecraft ${label} failed SHA-1 or size verification.`,
        );
      }
      await rm(destination, { force: true });
    }
  }
  if (!(await fileExists(destination))) {
    if (config.offline) {
      throw new PackwrightError(
        'not_found',
        `The Minecraft 26.2 ${label} is not cached and offline mode forbids downloads.`,
      );
    }
    await downloadVerified(artifact.url, destination, artifact.sha1, artifact.size, signal);
  }
}

async function prepareClientAssets(
  config: RuntimeConfig,
  metadata: VersionMetadata,
  signal?: AbortSignal,
): Promise<Omit<ClientAssetsSetupRecord, 'preparedAt'>> {
  const client = metadata.downloads.client;
  const assetIndex = metadata.assetIndex;
  if (client === undefined || assetIndex === undefined) {
    throw new PackwrightError(
      'invalid_content',
      'Manifest-verified Minecraft 26.2 metadata does not declare both a client and asset index.',
    );
  }
  const paths = cachePaths(config.cacheDir);
  await ensureVerifiedArtifact(config, client, paths.clientJar, 'client jar', signal);
  await ensureVerifiedArtifact(config, assetIndex, paths.assetIndex, 'asset index', signal);
  return {
    versionMetadataSha1: MINECRAFT_26_2.resourcePack.artifacts.versionMetadataSha1,
    clientSha1: client.sha1,
    clientSize: client.size,
    assetIndexId: assetIndex.id,
    assetIndexSha1: assetIndex.sha1,
    assetIndexSize: assetIndex.size,
  };
}

export async function setupVersion(
  config: RuntimeConfig,
  acceptMinecraftEula: boolean,
  signal?: AbortSignal,
  options: SetupVersionOptions = {},
): Promise<SetupVersionResult> {
  await assertRuntimePathSeparation(config);
  if (!acceptMinecraftEula) {
    throw new PackwrightError(
      'confirmation_required',
      'setup-version requires --accept-minecraft-eula from a human operator.',
    );
  }
  if (signal?.aborted) throw new PackwrightError('cancelled', 'Setup was cancelled.');

  const java = await getJavaVersion(config.javaCommand, signal);
  if (!java.available || java.major !== MINECRAFT_26_2.javaMajor) {
    throw new Error(
      `Minecraft 26.2 setup requires Java ${String(MINECRAFT_26_2.javaMajor)}; ${java.description}.`,
    );
  }
  const paths = cachePaths(config.cacheDir);
  const includeClientAssets = options.clientAssets === true;
  let previousClientAssets: ClientAssetsSetupRecord | undefined;
  if (!includeClientAssets && (await fileExists(paths.setupRecord))) {
    try {
      previousClientAssets = setupRecord(
        await readJsonFile<unknown>(paths.setupRecord),
      )?.clientAssets;
    } catch {
      previousClientAssets = undefined;
    }
  }
  const { metadata, sha1 } = await prepareServerJar(config, signal, includeClientAssets);
  const preparedClientAssets = includeClientAssets
    ? await prepareClientAssets(config, metadata, signal)
    : undefined;
  const work = path.join(paths.versionDir, `.data-${randomUUID()}`);
  const generated = path.join(work, 'generated', 'reports');
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    const stagedServerJar = path.join(work, 'server.jar');
    await copyVerifiedServerJar(config.cacheDir, stagedServerJar, signal);
    const processResult = await runProcess({
      command: config.javaCommand,
      args: ['-DbundlerMainClass=net.minecraft.data.Main', '-jar', stagedServerJar, '--reports'],
      cwd: work,
      timeoutMs: 300_000,
      ...(signal === undefined ? {} : { signal }),
    });
    if (processResult.cancelled) {
      throw new PackwrightError('cancelled', 'Minecraft report generation was cancelled.');
    }
    if (processResult.timedOut) {
      throw new Error('Minecraft report generation timed out after five minutes.');
    }
    if (processResult.exitCode !== 0) {
      throw new Error(
        `Minecraft report generation exited with ${String(processResult.exitCode)}: ${processResult.stderr.trim()}`,
      );
    }
    const generatedCommands = path.join(generated, 'commands.json');
    const generatedRegistries = path.join(generated, 'registries.json');
    if (!(await fileExists(generatedCommands)) || !(await fileExists(generatedRegistries))) {
      throw new Error('Minecraft did not produce commands.json and registries.json reports.');
    }
    await copyFileAtomic(generatedCommands, paths.commandsReport);
    await copyFileAtomic(generatedRegistries, paths.registriesReport);
    const generatedAt = new Date().toISOString();
    const recordedClientAssets =
      preparedClientAssets === undefined
        ? previousClientAssets
        : { ...preparedClientAssets, preparedAt: generatedAt };
    const record: SetupRecord = {
      minecraftVersion: '26.2',
      acceptedMinecraftEulaAt: generatedAt,
      generatedAt,
      serverSha1: sha1,
      versionManifestUrl: VERSION_MANIFEST_URL,
      ...(recordedClientAssets === undefined ? {} : { clientAssets: recordedClientAssets }),
    };
    await writeJsonAtomic(paths.setupRecord, record);
    const status = await getCacheStatus(config.cacheDir, true);
    const clientStatus = status.clientAssets;
    if (includeClientAssets && clientStatus?.ready !== true) {
      throw new PackwrightError(
        'precondition_failed',
        'Minecraft client assets changed before setup readiness could be recorded.',
      );
    }
    return {
      ok: true,
      minecraftVersion: '26.2',
      cacheDir: paths.versionDir,
      serverSha1: sha1,
      commandsReport: paths.commandsReport,
      registriesReport: paths.registriesReport,
      generatedAt,
      clientAssets: {
        selected: includeClientAssets,
        ready: clientStatus?.ready ?? false,
        ...(includeClientAssets && preparedClientAssets !== undefined
          ? {
              clientJar: paths.clientJar,
              clientSha1: preparedClientAssets.clientSha1,
              assetIndex: paths.assetIndex,
              assetIndexId: preparedClientAssets.assetIndexId,
              assetIndexSha1: preparedClientAssets.assetIndexSha1,
            }
          : {}),
      },
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function loadReferenceCache(cacheDir: string): Promise<ReferenceCache | undefined> {
  const status = await getCacheStatus(cacheDir);
  if (!status.ready) return undefined;
  const paths = cachePaths(cacheDir);
  return {
    ...(status.record?.generatedAt === undefined ? {} : { generatedAt: status.record.generatedAt }),
    commands: await readJsonFile<unknown>(paths.commandsReport, 64 * 1024 * 1024),
    registries: await readJsonFile<unknown>(paths.registriesReport, 128 * 1024 * 1024),
  };
}

export function cacheUnavailableDiagnostic(): Diagnostic {
  return {
    engine: 'packwright',
    authority: 'structural',
    severity: 'information',
    code: 'minecraft.setup_required',
    message:
      'Minecraft 26.2 reference data is not cached. A human operator can run setup-version 26.2 --accept-minecraft-eula.',
  };
}

export function emptyRegistryMap(): Record<string, string[]> {
  return Object.fromEntries(MINECRAFT_26_2.supportedRegistries.map((registry) => [registry, []]));
}

export const SUPPORTED_RESOURCE_TYPE_NAMES: readonly string[] = RESOURCE_TYPES;
