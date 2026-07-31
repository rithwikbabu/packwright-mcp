import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { RuntimeConfig } from '../config.js';
import { PackwrightError } from '../core/errors.js';
import { MINECRAFT_26_2 } from '../core/version.js';
import { canonicalJsonBytes } from '../visual/run-store.js';
import {
  clientCaptureRuntimeManifestPath,
  createClientCaptureRuntimeManifest,
  mavenCoordinatePath,
} from './client-capture-runtime.js';
import {
  currentClientRuntimePlatform,
  preflightClientRuntime,
  type ClientRuntimeArtifact,
  type HashedClientRuntimeManifest,
} from './client-runtime.js';

const DOWNLOAD_CONCURRENCY = 8;
const ALLOWED_RUNTIME_HOSTS = new Set([
  'libraries.minecraft.net',
  'maven.fabricmc.net',
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
  'resources.download.minecraft.net',
]);

export interface ClientRuntimeSetupResult {
  readonly ready: true;
  readonly cacheDir: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly artifacts: number;
  readonly bytes: number;
  readonly platform: HashedClientRuntimeManifest['manifest']['platform'];
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new PackwrightError('cancelled', 'Client runtime setup was cancelled.');
}

async function stableBytes(filename: string, maximum: number): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximum) {
      throw new PackwrightError('invalid_content', `Cached setup input is invalid: ${filename}`);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== bytes.length ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new PackwrightError('precondition_failed', `Cached setup input changed: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function trustedRuntimeUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !ALLOWED_RUNTIME_HOSTS.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new PackwrightError('invalid_content', `Untrusted client runtime URL: ${url.origin}`);
  }
  return url;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new PackwrightError(
          'unsafe_path',
          `Client runtime cache parent is not a real directory: ${cursor}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(cursor, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new PackwrightError(
          'unsafe_path',
          `Client runtime cache parent is not a real directory: ${cursor}`,
        );
      }
    }
  }
}

async function existingArtifactMatches(
  filename: string,
  artifact: ClientRuntimeArtifact,
): Promise<boolean> {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size) return false;
  const bytes = await stableBytes(filename, artifact.size);
  return createHash('sha1').update(bytes).digest('hex') === artifact.sha1;
}

async function downloadArtifact(
  cacheDir: string,
  artifact: ClientRuntimeArtifact,
  offline: boolean,
  signal?: AbortSignal,
): Promise<void> {
  abortIfNeeded(signal);
  const filename = path.join(cacheDir, ...artifact.cachePath.split('/'));
  await ensureRealDirectory(path.dirname(filename));
  if (await existingArtifactMatches(filename, artifact)) return;
  const existing = await lstat(filename).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new PackwrightError(
      'unsafe_path',
      `Client runtime artifact destination is a symlink: ${artifact.cachePath}`,
    );
  }
  if (offline) {
    throw new PackwrightError(
      'not_found',
      `Client runtime artifact is missing or corrupt and offline mode forbids repair: ${artifact.cachePath}`,
    );
  }
  const url = trustedRuntimeUrl(artifact.url);
  const response = await fetch(url, {
    headers: { 'user-agent': 'packwright-mcp/0.4.1' },
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || response.body === null) {
    throw new Error(`Client runtime download failed (${String(response.status)}): ${url.href}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared !== 0 && declared !== artifact.size) {
    throw new Error(`Client runtime download size changed: ${artifact.cachePath}`);
  }
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    const reader = response.body.getReader();
    const sha1 = createHash('sha1');
    let bytes = 0;
    for (;;) {
      abortIfNeeded(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = Buffer.from(chunk.value);
      bytes += value.length;
      if (bytes > artifact.size) {
        await reader.cancel();
        throw new Error(
          `Client runtime download exceeded its declared size: ${artifact.cachePath}`,
        );
      }
      sha1.update(value);
      let offset = 0;
      while (offset < value.length) {
        const written = await handle.write(
          value,
          offset,
          value.length - offset,
          bytes - value.length + offset,
        );
        offset += written.bytesWritten;
      }
    }
    if (bytes !== artifact.size || sha1.digest('hex') !== artifact.sha1) {
      throw new Error(`Client runtime download failed verification: ${artifact.cachePath}`);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function runPool<T>(
  values: readonly T[],
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  let failure: Error | undefined;
  const run = async (): Promise<void> => {
    while (failure === undefined) {
      const selected = index;
      index += 1;
      const value = values[selected];
      if (value === undefined) return;
      try {
        await worker(value);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, values.length) }, run));
  if (failure !== undefined) throw failure;
}

export async function prepareClientCaptureRuntime(
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<ClientRuntimeSetupResult> {
  const versionDirectory = path.join(config.cacheDir, 'versions', '26.2');
  const versionMetadataPath = path.join(versionDirectory, 'version.json');
  const assetIndexPath = path.join(versionDirectory, 'asset-index.json');
  const [versionMetadata, assetIndex] = await Promise.all([
    stableBytes(versionMetadataPath, 16 * 1024 * 1024),
    stableBytes(assetIndexPath, 32 * 1024 * 1024),
  ]);
  const runtime = createClientCaptureRuntimeManifest(
    versionMetadata,
    assetIndex,
    currentClientRuntimePlatform(),
  );
  await ensureRealDirectory(config.cacheDir);
  await runPool(runtime.manifest.artifacts, (artifact) =>
    downloadArtifact(config.cacheDir, artifact, config.offline, signal),
  );
  const preflight = await preflightClientRuntime(config.cacheDir, runtime, signal);
  if (!preflight.ready) {
    throw new PackwrightError(
      'precondition_failed',
      'Minecraft client runtime changed before setup verification completed.',
      { issues: preflight.issues.slice(0, 32) },
    );
  }
  const verifiedByPath = new Map(preflight.verified.map((entry) => [entry.cachePath, entry]));
  for (const library of MINECRAFT_26_2.clientCapture.loader.libraries) {
    const artifactPath = `libraries/${mavenCoordinatePath(library.coordinate)}`;
    if (verifiedByPath.get(artifactPath)?.sha256 !== library.sha256) {
      throw new PackwrightError(
        'precondition_failed',
        `Pinned Fabric capture library failed SHA-256 verification: ${library.coordinate}`,
      );
    }
  }
  const manifestPath = clientCaptureRuntimeManifestPath(config.cacheDir);
  await ensureRealDirectory(path.dirname(manifestPath));
  const temporary = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(canonicalJsonBytes(runtime));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, manifestPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    ready: true,
    cacheDir: config.cacheDir,
    manifestPath,
    manifestSha256: runtime.sha256,
    artifacts: runtime.manifest.artifacts.length,
    bytes: runtime.manifest.artifacts.reduce((total, artifact) => total + artifact.size, 0),
    platform: runtime.manifest.platform,
  };
}
