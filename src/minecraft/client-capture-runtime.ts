import path from 'node:path';

import { sha256Buffer } from '../core/hash.js';
import { MINECRAFT_26_2 } from '../core/version.js';
import { canonicalJsonBytes } from '../visual/run-store.js';
import {
  createClientRuntimeManifest,
  type ClientRuntimeArtifact,
  type ClientRuntimePlatform,
  type HashedClientRuntimeManifest,
} from './client-runtime.js';

const COORDINATE_PATTERN =
  /^(?<group>[A-Za-z0-9_.-]+):(?<artifact>[A-Za-z0-9_.-]+):(?<version>[A-Za-z0-9_.+-]+)$/u;

export const CLIENT_CAPTURE_RUNTIME_MANIFEST = 'client-capture-runtime.json' as const;

export function mavenCoordinatePath(coordinate: string): string {
  const groups = COORDINATE_PATTERN.exec(coordinate)?.groups;
  if (
    groups?.group === undefined ||
    groups.artifact === undefined ||
    groups.version === undefined
  ) {
    throw new Error(`Invalid pinned Maven coordinate: ${coordinate}`);
  }
  return `${groups.group.replaceAll('.', '/')}/${groups.artifact}/${groups.version}/${groups.artifact}-${groups.version}.jar`;
}

function fabricArtifacts(): readonly ClientRuntimeArtifact[] {
  return MINECRAFT_26_2.clientCapture.loader.libraries.map((library) => {
    const artifactPath = mavenCoordinatePath(library.coordinate);
    return {
      id: `fabric-library:${library.coordinate}`,
      kind: 'library',
      cachePath: `libraries/${artifactPath}`,
      sha1: library.sha1,
      size: library.size,
      url: new URL(artifactPath, library.repository).href,
    };
  });
}

export function addPinnedCaptureLoader(
  runtime: HashedClientRuntimeManifest,
): HashedClientRuntimeManifest {
  const byPath = new Map(
    runtime.manifest.artifacts.map((artifact) => [artifact.cachePath, artifact]),
  );
  for (const artifact of fabricArtifacts()) {
    const previous = byPath.get(artifact.cachePath);
    if (
      previous !== undefined &&
      !canonicalJsonBytes(previous).equals(canonicalJsonBytes(artifact))
    ) {
      throw new Error(`Pinned capture runtime conflicts at ${artifact.cachePath}.`);
    }
    byPath.set(artifact.cachePath, artifact);
  }
  const artifacts = [...byPath.values()].sort((left, right) =>
    left.cachePath < right.cachePath ? -1 : left.cachePath > right.cachePath ? 1 : 0,
  );
  const manifest = { ...runtime.manifest, artifacts };
  return { manifest, sha256: sha256Buffer(canonicalJsonBytes(manifest)) };
}

export function createClientCaptureRuntimeManifest(
  versionMetadata: Uint8Array | string,
  assetIndex: Uint8Array | string,
  platform: ClientRuntimePlatform,
): HashedClientRuntimeManifest {
  return addPinnedCaptureLoader(createClientRuntimeManifest(versionMetadata, assetIndex, platform));
}

export function clientCaptureRuntimeManifestPath(cacheDir: string): string {
  if (!path.isAbsolute(cacheDir)) throw new Error('Client capture cache root must be absolute.');
  return path.join(cacheDir, 'versions', '26.2', CLIENT_CAPTURE_RUNTIME_MANIFEST);
}

export function clientCaptureClasspath(
  cacheDir: string,
  runtime: HashedClientRuntimeManifest,
): readonly string[] {
  const eligible = runtime.manifest.artifacts.filter(
    (artifact) => artifact.kind === 'client' || artifact.kind === 'library',
  );
  return eligible.map((artifact) => path.join(cacheDir, ...artifact.cachePath.split('/')));
}
