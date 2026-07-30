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
import type { RuntimeConfig } from '../config.js';
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
    readonly server?: {
      readonly sha1: string;
      readonly size?: number;
      readonly url: string;
    };
  };
}

type JsonObject = Record<string, unknown>;

export interface SetupRecord {
  readonly minecraftVersion: '26.2';
  readonly acceptedMinecraftEulaAt: string;
  readonly generatedAt: string;
  readonly serverSha1: string;
  readonly versionManifestUrl: string;
}

export interface CachePaths {
  readonly versionDir: string;
  readonly serverJar: string;
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
  readonly record?: SetupRecord;
}

export interface SetupVersionResult {
  readonly ok: boolean;
  readonly minecraftVersion: '26.2';
  readonly cacheDir: string;
  readonly serverSha1: string;
  readonly commandsReport: string;
  readonly registriesReport: string;
  readonly generatedAt: string;
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

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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
  return object as unknown as SetupRecord;
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

async function writeJsonAtomic(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o755 });
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
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
): Promise<{ readonly value: unknown; readonly sha1: string }> {
  assertOfficialUrl(url);
  const response = await fetch(url, {
    headers: { 'user-agent': 'packwright-mcp/0.1.2' },
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
  };
}

async function sha1File(filename: string): Promise<string> {
  const hash = createHash('sha1');
  await pipeline(createReadStream(filename), hash);
  return hash.digest('hex');
}

const jarVerificationCache = new Map<
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

async function verifyCachedJar(
  filename: string,
  expected: string,
  expectedSize: number,
  force: boolean,
): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/u.test(expected)) return false;
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size !== expectedSize) return false;
    const cached = jarVerificationCache.get(filename);
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
    jarVerificationCache.set(filename, {
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
      headers: { 'user-agent': 'packwright-mcp/0.1.2' },
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok || response.body === null) {
      throw new Error(`Download failed (${String(response.status)}) for ${url.href}`);
    }
    const declaredSize = Number(response.headers.get('content-length') ?? '0');
    if (expectedSize !== undefined && declaredSize !== 0 && declaredSize !== expectedSize) {
      throw new Error(
        `Server jar size mismatch before download (expected ${String(expectedSize)}, received ${String(declaredSize)}).`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const info = await stat(temporary);
    if (expectedSize !== undefined && info.size !== expectedSize) {
      throw new Error(
        `Server jar size mismatch (expected ${String(expectedSize)}, received ${String(info.size)}).`,
      );
    }
    const actualSha1 = await sha1File(temporary);
    if (actualSha1 !== expectedSha1.toLowerCase()) {
      throw new Error(
        `Server jar SHA-1 mismatch (expected ${expectedSha1}, received ${actualSha1}).`,
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
  const [jar, versionMetadataPresent, commands, registries, acceptedEula] = await Promise.all([
    fileExists(paths.serverJar),
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
  if (versionMetadataPresent) {
    try {
      versionMetadata(await readJsonFile<unknown>(paths.versionMetadata));
      versionMetadataVerified = true;
    } catch {
      versionMetadataVerified = false;
    }
  }
  const artifacts = MINECRAFT_26_2.artifacts;
  const jarVerified =
    jar && record !== undefined
      ? await verifyCachedJar(
          paths.serverJar,
          artifacts.serverSha1,
          artifacts.serverSize,
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
    ...(record === undefined ? {} : { record }),
  };
}

async function prepareServerJar(
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<{
  readonly metadata: VersionMetadata;
  readonly sha1: string;
}> {
  const paths = cachePaths(config.cacheDir);
  let metadata: VersionMetadata | undefined;
  if (await fileExists(paths.versionMetadata)) {
    try {
      metadata = versionMetadata(await readJsonFile<unknown>(paths.versionMetadata));
    } catch (error) {
      if (config.offline) {
        throw new PackwrightError(
          'invalid_content',
          'The cached Minecraft 26.2 version metadata is malformed or does not match the pinned official artifact.',
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      metadata = undefined;
    }
  }

  if (metadata === undefined) {
    if (config.offline) {
      throw new PackwrightError(
        'not_found',
        'Minecraft 26.2 metadata is not cached and offline mode forbids setup downloads.',
      );
    }
    const manifestResponse = await fetchJson(VERSION_MANIFEST_URL, signal);
    const manifest = versionManifest(manifestResponse.value);
    const entry = manifest.versions.find((candidate) => candidate.id === '26.2');
    if (entry === undefined) {
      throw new Error("Minecraft 26.2 is absent from Mojang's official version manifest.");
    }
    const artifacts = MINECRAFT_26_2.artifacts;
    if (
      entry.url !== artifacts.versionMetadataUrl ||
      entry.sha1 !== artifacts.versionMetadataSha1
    ) {
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
    metadata = versionMetadata(metadataResponse.value);
    await writeJsonAtomic(paths.versionMetadata, metadata);
  }

  const server = metadata.downloads.server;
  if (server === undefined) throw new Error('Pinned Minecraft server metadata is unavailable.');

  if (await fileExists(paths.serverJar)) {
    const verified = await verifyCachedJar(
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

export async function setupVersion(
  config: RuntimeConfig,
  acceptMinecraftEula: boolean,
  signal?: AbortSignal,
): Promise<SetupVersionResult> {
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
  const { sha1 } = await prepareServerJar(config, signal);
  const paths = cachePaths(config.cacheDir);
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
    const record: SetupRecord = {
      minecraftVersion: '26.2',
      acceptedMinecraftEulaAt: generatedAt,
      generatedAt,
      serverSha1: sha1,
      versionManifestUrl: VERSION_MANIFEST_URL,
    };
    await writeJsonAtomic(paths.setupRecord, record);
    return {
      ok: true,
      minecraftVersion: '26.2',
      cacheDir: paths.versionDir,
      serverSha1: sha1,
      commandsReport: paths.commandsReport,
      registriesReport: paths.registriesReport,
      generatedAt,
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
