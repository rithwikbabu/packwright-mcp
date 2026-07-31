import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_PNG_LIMITS, decodePng, normalizePng, type PngLimits } from './png.js';

const CONTENT_ID = /^[a-f0-9]{64}$/u;
const ARTIFACT_LABEL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_COMPILED_FILES = 2048;
const MAX_COMPILED_BYTES = 64 * 1024 * 1024;
const DEFAULT_PNG_READ_LIMIT = 8 * 1024 * 1024;
const MAX_CAPTURE_BLOB_BYTES = 16 * 1024 * 1024;

export const VISUAL_RUN_STORE_LIMITS = Object.freeze({
  maxJsonBytes: MAX_JSON_BYTES,
  maxCompiledFiles: MAX_COMPILED_FILES,
  maxCompiledBytes: MAX_COMPILED_BYTES,
  maxPngBytes: DEFAULT_PNG_READ_LIMIT,
});

type JsonPrimitive = boolean | null | number | string;
export type CanonicalJson =
  JsonPrimitive | readonly CanonicalJson[] | { readonly [key: string]: CanonicalJson };

export interface CreateVisualRunInput {
  readonly request: unknown;
  readonly modelSpec: unknown;
  readonly provenance: unknown;
  readonly signal?: AbortSignal | undefined;
}

export interface VisualRunRecord {
  readonly runId: string;
  readonly directory: string;
  readonly requestSha256: string;
  readonly modelSpecSha256: string;
  readonly provenanceSha256: string;
}

export interface CreateRevisionInput {
  readonly modelSpec: unknown;
  readonly provenance: unknown;
  readonly parentRevisionId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface VisualRevisionRecord {
  readonly runId: string;
  readonly revisionId: string;
  readonly directory: string;
  readonly modelSpecSha256: string;
  readonly provenanceSha256: string;
  readonly parentRevisionId?: string | undefined;
}

export interface StoredPngArtifact {
  readonly runId: string;
  readonly kind: 'capture' | 'render' | 'texture';
  readonly sha256: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sourceSha256: string;
  readonly strippedMetadata: boolean;
}

export interface StoredJsonArtifact {
  readonly runId: string;
  readonly kind: 'review';
  readonly sha256: string;
  readonly path: string;
  readonly bytes: number;
}

export interface StoredCaptureBlob {
  readonly runId: string;
  readonly label: string;
  readonly extension: 'json' | 'log' | 'png';
  readonly sha256: string;
  readonly path: string;
  readonly bytes: number;
}

export interface ReadCaptureBlob extends StoredCaptureBlob {
  readonly data: Buffer;
}

export interface StoredCompiledArtifact {
  readonly runId: string;
  readonly artifactId: string;
  readonly directory: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  readonly totalBytes: number;
}

export interface VisualRunSnapshot extends VisualRunRecord {
  readonly request: unknown;
  readonly modelSpec: unknown;
  readonly provenance: unknown;
}

export interface VisualRevisionSnapshot extends VisualRevisionRecord {
  readonly modelSpec: unknown;
  readonly provenance: unknown;
}

export interface ReadPngArtifact extends StoredPngArtifact {
  readonly data: Buffer;
}

export interface ReadJsonArtifact extends StoredJsonArtifact {
  readonly value: unknown;
}

export interface ReadCompiledArtifact extends StoredCompiledArtifact {
  readonly contents: Readonly<Record<string, Buffer>>;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Visual run operation was cancelled.');
}

function hash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Canonical JSON cannot contain a non-finite number.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw new Error(`Canonical JSON cannot contain ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new Error('Canonical JSON cannot contain a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Canonical JSON only accepts arrays and plain objects.');
    }
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .sort(compareKeys)
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key], ancestors)}`);
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** RFC-8259 JSON with recursively sorted object keys and a single trailing newline. */
export function canonicalJsonBytes(value: unknown): Buffer {
  const bytes = Buffer.from(`${canonicalize(value, new Set())}\n`, 'utf8');
  if (bytes.length > MAX_JSON_BYTES) {
    throw new Error(`Canonical JSON exceeds the ${String(MAX_JSON_BYTES)}-byte artifact limit.`);
  }
  return bytes;
}

function requireContentId(value: string, label: string): void {
  if (!CONTENT_ID.test(value)) throw new Error(`${label} is not a canonical content ID.`);
}

function requireArtifactLabel(value: string): void {
  if (!ARTIFACT_LABEL.test(value)) throw new Error('Artifact label is not canonical.');
}

function normalizeCompiledPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    path.posix.isAbsolute(value)
  ) {
    throw new Error('Compiled artifact path must be a non-empty relative POSIX path.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Compiled artifact path contains traversal or non-canonical segments.');
  }
  return normalized;
}

function confinedPngLimits(overrides: PngLimits | undefined): PngLimits {
  return {
    maxFileBytes: Math.min(
      overrides?.maxFileBytes ?? DEFAULT_PNG_LIMITS.maxFileBytes,
      DEFAULT_PNG_LIMITS.maxFileBytes,
    ),
    maxWidth: Math.min(
      overrides?.maxWidth ?? DEFAULT_PNG_LIMITS.maxWidth,
      DEFAULT_PNG_LIMITS.maxWidth,
    ),
    maxHeight: Math.min(
      overrides?.maxHeight ?? DEFAULT_PNG_LIMITS.maxHeight,
      DEFAULT_PNG_LIMITS.maxHeight,
    ),
    maxPixels: Math.min(
      overrides?.maxPixels ?? DEFAULT_PNG_LIMITS.maxPixels,
      DEFAULT_PNG_LIMITS.maxPixels,
    ),
    maxDecodedBytes: Math.min(
      overrides?.maxDecodedBytes ?? DEFAULT_PNG_LIMITS.maxDecodedBytes,
      DEFAULT_PNG_LIMITS.maxDecodedBytes,
    ),
  };
}

async function assertDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Run-store path is not a real directory.');
}

async function optionalRealDirectory(directory: string, label: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`${label} is not a real directory.`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function writeImmutableFile(filename: string, content: Uint8Array): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await assertDirectory(path.dirname(filename));
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, filename);
      await chmod(filename, 0o444);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readStableNoFollow(filename, content.byteLength);
      if (!existing.equals(Buffer.from(content))) {
        throw new Error('Immutable run-store artifact already exists with different content.');
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readStableNoFollow(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error('Run-store artifact is not a regular file.');
    }
    if (before.size > BigInt(maxBytes))
      throw new Error('Run-store artifact exceeds its read limit.');
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathInfo = await lstat(filename, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== pathInfo.dev ||
      after.ino !== pathInfo.ino ||
      pathInfo.isSymbolicLink()
    ) {
      throw new Error('Run-store artifact changed while it was read.');
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function readImmutableFile(
  filename: string,
  expectedSha256: string,
  maxBytes = MAX_COMPILED_BYTES,
): Promise<Buffer> {
  const content = await readStableNoFollow(filename, maxBytes);
  if (hash(content) !== expectedSha256) {
    throw new Error('Immutable run-store artifact failed its hash check.');
  }
  return content;
}

async function readBoundedJson(filename: string): Promise<{ value: unknown; bytes: Buffer }> {
  const bytes = await readStableNoFollow(filename, MAX_JSON_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('Run-store JSON artifact is malformed.');
  }
  return { value, bytes };
}

async function readCanonicalJson(filename: string): Promise<unknown> {
  const { value, bytes } = await readBoundedJson(filename);
  if (!bytes.equals(canonicalJsonBytes(value))) {
    throw new Error('Run-store JSON artifact is not in canonical form.');
  }
  return value;
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function jsonString(object: Readonly<Record<string, unknown>>, field: string): string {
  const value = object[field];
  if (typeof value !== 'string') throw new Error(`Run-store manifest field ${field} is invalid.`);
  return value;
}

function jsonNumber(object: Readonly<Record<string, unknown>>, field: string): number {
  const value = object[field];
  if (!Number.isSafeInteger(value))
    throw new Error(`Run-store manifest field ${field} is invalid.`);
  return value as number;
}

async function installImmutableDirectory(temporary: string, destination: string): Promise<boolean> {
  try {
    await rename(temporary, destination);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    await assertDirectory(destination);
    return false;
  }
}

export class VisualRunStore {
  readonly cacheRoot: string;
  readonly runsRoot: string;

  constructor(cacheRoot: string) {
    if (!path.isAbsolute(cacheRoot)) throw new Error('Visual run cache root must be absolute.');
    this.cacheRoot = path.resolve(cacheRoot);
    this.runsRoot = path.join(this.cacheRoot, 'visual-runs');
  }

  private async ensureSafeRoot(create: boolean): Promise<boolean> {
    let cachePresent = await optionalRealDirectory(this.cacheRoot, 'Visual run cache root');
    if (!cachePresent) {
      if (!create) return false;
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      cachePresent = await optionalRealDirectory(this.cacheRoot, 'Visual run cache root');
      if (!cachePresent) throw new Error('Visual run cache root could not be created safely.');
    }

    let runsPresent = await optionalRealDirectory(this.runsRoot, 'Visual runs root');
    if (!runsPresent) {
      if (!create) return false;
      await mkdir(this.runsRoot, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      runsPresent = await optionalRealDirectory(this.runsRoot, 'Visual runs root');
      if (!runsPresent) throw new Error('Visual runs root could not be created safely.');
    }

    // Recheck the configured root after inspecting/creating its child so a
    // replaced parent cannot silently redirect subsequent artifact access.
    if (!(await optionalRealDirectory(this.cacheRoot, 'Visual run cache root'))) {
      throw new Error('Visual run cache root disappeared during validation.');
    }
    if (!(await optionalRealDirectory(this.runsRoot, 'Visual runs root'))) {
      throw new Error('Visual runs root disappeared during validation.');
    }
    return true;
  }

  private runDirectory(runId: string): string {
    requireContentId(runId, 'Run ID');
    return path.join(this.runsRoot, runId);
  }

  async readRun(runId: string): Promise<VisualRunSnapshot> {
    await this.ensureSafeRoot(false);
    const directory = this.runDirectory(runId);
    await assertDirectory(directory);
    const manifest = jsonObject(
      await readCanonicalJson(path.join(directory, 'manifest.json')),
      'Visual run manifest',
    );
    if (jsonNumber(manifest, 'schemaVersion') !== 1 || jsonString(manifest, 'runId') !== runId) {
      throw new Error('Visual run manifest identity is invalid.');
    }
    const requestSha256 = jsonString(manifest, 'requestSha256');
    const modelSpecSha256 = jsonString(manifest, 'modelSpecSha256');
    const provenanceSha256 = jsonString(manifest, 'provenanceSha256');
    requireContentId(requestSha256, 'Request hash');
    requireContentId(modelSpecSha256, 'Model specification hash');
    requireContentId(provenanceSha256, 'Provenance hash');
    const expectedRunId = hash(
      canonicalJsonBytes({ requestSha256, modelSpecSha256, provenanceSha256 }),
    );
    if (expectedRunId !== runId) throw new Error('Visual run manifest does not match its run ID.');
    const [requestBytes, modelSpecBytes, provenanceBytes] = await Promise.all([
      readImmutableFile(path.join(directory, 'request.json'), requestSha256, MAX_JSON_BYTES),
      readImmutableFile(path.join(directory, 'model-spec.json'), modelSpecSha256, MAX_JSON_BYTES),
      readImmutableFile(path.join(directory, 'provenance.json'), provenanceSha256, MAX_JSON_BYTES),
    ]);
    const parse = (bytes: Buffer, label: string): unknown => {
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new Error(`${label} is malformed.`);
      }
      if (!bytes.equals(canonicalJsonBytes(value))) throw new Error(`${label} is not canonical.`);
      return value;
    };
    return {
      runId,
      directory,
      requestSha256,
      modelSpecSha256,
      provenanceSha256,
      request: parse(requestBytes, 'Visual request'),
      modelSpec: parse(modelSpecBytes, 'Visual model specification'),
      provenance: parse(provenanceBytes, 'Visual provenance'),
    };
  }

  async createRun(input: CreateVisualRunInput): Promise<VisualRunRecord> {
    abortIfNeeded(input.signal);
    await this.ensureSafeRoot(true);
    const requestBytes = canonicalJsonBytes(input.request);
    const modelSpecBytes = canonicalJsonBytes(input.modelSpec);
    const provenanceBytes = canonicalJsonBytes(input.provenance);
    const requestSha256 = hash(requestBytes);
    const modelSpecSha256 = hash(modelSpecBytes);
    const provenanceSha256 = hash(provenanceBytes);
    const identity = canonicalJsonBytes({ requestSha256, modelSpecSha256, provenanceSha256 });
    const runId = hash(identity);
    const directory = this.runDirectory(runId);
    const temporary = path.join(this.runsRoot, `.${runId}.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      abortIfNeeded(input.signal);
      await writeFile(path.join(temporary, 'request.json'), requestBytes, {
        flag: 'wx',
        mode: 0o444,
      });
      await writeFile(path.join(temporary, 'model-spec.json'), modelSpecBytes, {
        flag: 'wx',
        mode: 0o444,
      });
      await writeFile(path.join(temporary, 'provenance.json'), provenanceBytes, {
        flag: 'wx',
        mode: 0o444,
      });
      await writeFile(
        path.join(temporary, 'manifest.json'),
        canonicalJsonBytes({
          schemaVersion: 1,
          runId,
          requestSha256,
          modelSpecSha256,
          provenanceSha256,
        }),
        { flag: 'wx', mode: 0o444 },
      );
      const installed = await installImmutableDirectory(temporary, directory);
      if (!installed) {
        await Promise.all([
          readImmutableFile(path.join(directory, 'request.json'), requestSha256),
          readImmutableFile(path.join(directory, 'model-spec.json'), modelSpecSha256),
          readImmutableFile(path.join(directory, 'provenance.json'), provenanceSha256),
        ]);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
    return { runId, directory, requestSha256, modelSpecSha256, provenanceSha256 };
  }

  async createRevision(runId: string, input: CreateRevisionInput): Promise<VisualRevisionRecord> {
    abortIfNeeded(input.signal);
    await this.ensureSafeRoot(false);
    const runDirectory = this.runDirectory(runId);
    await assertDirectory(runDirectory);
    if (input.parentRevisionId !== undefined) {
      requireContentId(input.parentRevisionId, 'Parent revision ID');
      await assertDirectory(path.join(runDirectory, 'revisions', input.parentRevisionId));
    }
    const modelSpecBytes = canonicalJsonBytes(input.modelSpec);
    const provenanceBytes = canonicalJsonBytes(input.provenance);
    const modelSpecSha256 = hash(modelSpecBytes);
    const provenanceSha256 = hash(provenanceBytes);
    const identity = canonicalJsonBytes({
      runId,
      modelSpecSha256,
      provenanceSha256,
      ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
    });
    const revisionId = hash(identity);
    const revisions = path.join(runDirectory, 'revisions');
    await mkdir(revisions, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await assertDirectory(revisions);
    const directory = path.join(revisions, revisionId);
    const temporary = path.join(revisions, `.${revisionId}.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeFile(path.join(temporary, 'model-spec.json'), modelSpecBytes, {
        flag: 'wx',
        mode: 0o444,
      });
      await writeFile(path.join(temporary, 'provenance.json'), provenanceBytes, {
        flag: 'wx',
        mode: 0o444,
      });
      await writeFile(
        path.join(temporary, 'revision.json'),
        canonicalJsonBytes({
          schemaVersion: 1,
          runId,
          revisionId,
          modelSpecSha256,
          provenanceSha256,
          ...(input.parentRevisionId === undefined
            ? {}
            : { parentRevisionId: input.parentRevisionId }),
        }),
        { flag: 'wx', mode: 0o444 },
      );
      const installed = await installImmutableDirectory(temporary, directory);
      if (!installed) {
        await Promise.all([
          readImmutableFile(path.join(directory, 'model-spec.json'), modelSpecSha256),
          readImmutableFile(path.join(directory, 'provenance.json'), provenanceSha256),
        ]);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      runId,
      revisionId,
      directory,
      modelSpecSha256,
      provenanceSha256,
      ...(input.parentRevisionId === undefined ? {} : { parentRevisionId: input.parentRevisionId }),
    };
  }

  async readRevision(runId: string): Promise<VisualRunSnapshot>;
  async readRevision(runId: string, revisionId: string): Promise<VisualRevisionSnapshot>;
  async readRevision(
    runId: string,
    revisionId?: string,
  ): Promise<VisualRunSnapshot | VisualRevisionSnapshot> {
    if (revisionId === undefined) return this.readRun(runId);
    await this.ensureSafeRoot(false);
    requireContentId(revisionId, 'Revision ID');
    const directory = path.join(this.runDirectory(runId), 'revisions', revisionId);
    await assertDirectory(directory);
    const manifest = jsonObject(
      await readCanonicalJson(path.join(directory, 'revision.json')),
      'Visual revision manifest',
    );
    if (
      jsonNumber(manifest, 'schemaVersion') !== 1 ||
      jsonString(manifest, 'runId') !== runId ||
      jsonString(manifest, 'revisionId') !== revisionId
    ) {
      throw new Error('Visual revision manifest identity is invalid.');
    }
    const modelSpecSha256 = jsonString(manifest, 'modelSpecSha256');
    const provenanceSha256 = jsonString(manifest, 'provenanceSha256');
    requireContentId(modelSpecSha256, 'Model specification hash');
    requireContentId(provenanceSha256, 'Provenance hash');
    const parentValue = manifest.parentRevisionId;
    if (parentValue !== undefined && typeof parentValue !== 'string') {
      throw new Error('Visual revision parent ID is invalid.');
    }
    if (parentValue !== undefined) requireContentId(parentValue, 'Parent revision ID');
    const expectedRevisionId = hash(
      canonicalJsonBytes({
        runId,
        modelSpecSha256,
        provenanceSha256,
        ...(parentValue === undefined ? {} : { parentRevisionId: parentValue }),
      }),
    );
    if (expectedRevisionId !== revisionId) {
      throw new Error('Visual revision manifest does not match its revision ID.');
    }
    const [modelSpecBytes, provenanceBytes] = await Promise.all([
      readImmutableFile(path.join(directory, 'model-spec.json'), modelSpecSha256, MAX_JSON_BYTES),
      readImmutableFile(path.join(directory, 'provenance.json'), provenanceSha256, MAX_JSON_BYTES),
    ]);
    const parse = (bytes: Buffer, label: string): unknown => {
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new Error(`${label} is malformed.`);
      }
      if (!bytes.equals(canonicalJsonBytes(value))) throw new Error(`${label} is not canonical.`);
      return value;
    };
    return {
      runId,
      revisionId,
      directory,
      modelSpecSha256,
      provenanceSha256,
      modelSpec: parse(modelSpecBytes, 'Visual model specification'),
      provenance: parse(provenanceBytes, 'Visual provenance'),
      ...(parentValue === undefined ? {} : { parentRevisionId: parentValue }),
    };
  }

  async listRevisions(runId: string): Promise<readonly string[]> {
    if (!(await this.ensureSafeRoot(false))) return [];
    const revisions = path.join(this.runDirectory(runId), 'revisions');
    let entries;
    try {
      entries = await readdir(revisions, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!CONTENT_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('Visual revision path is not a real directory.');
      }
      ids.push(entry.name);
    }
    return ids.sort(compareKeys);
  }

  async putTexture(
    runId: string,
    png: Uint8Array,
    options: {
      readonly limits?: PngLimits | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<StoredPngArtifact> {
    return this.putPng(runId, 'texture', 'texture', png, options);
  }

  async putRender(
    runId: string,
    label: string,
    png: Uint8Array,
    options: {
      readonly limits?: PngLimits | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<StoredPngArtifact> {
    requireArtifactLabel(label);
    return this.putPng(runId, 'render', label, png, options);
  }

  async putCapture(
    runId: string,
    label: string,
    png: Uint8Array,
    options: {
      readonly limits?: PngLimits | undefined;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<StoredPngArtifact> {
    requireArtifactLabel(label);
    return this.putPng(runId, 'capture', label, png, options);
  }

  private async putPng(
    runId: string,
    kind: StoredPngArtifact['kind'],
    label: string,
    input: Uint8Array,
    options: { readonly limits?: PngLimits | undefined; readonly signal?: AbortSignal | undefined },
  ): Promise<StoredPngArtifact> {
    abortIfNeeded(options.signal);
    await this.ensureSafeRoot(false);
    const runDirectory = this.runDirectory(runId);
    await assertDirectory(runDirectory);
    const normalized = normalizePng(input, confinedPngLimits(options.limits));
    abortIfNeeded(options.signal);
    const collection =
      kind === 'texture' ? 'textures' : kind === 'capture' ? 'captures' : 'renders';
    const filename = `${label}-${normalized.sha256}.png`;
    const destination = path.join(runDirectory, collection, filename);
    await writeImmutableFile(destination, normalized.png);
    const record: StoredPngArtifact = {
      runId,
      kind,
      sha256: normalized.sha256,
      path: destination,
      width: normalized.image.width,
      height: normalized.image.height,
      bytes: normalized.png.length,
      sourceSha256: normalized.sourceSha256,
      strippedMetadata: normalized.strippedMetadata,
    };
    return record;
  }

  async readPng(
    runId: string,
    kind: StoredPngArtifact['kind'],
    label: string,
    sha256: string,
  ): Promise<ReadPngArtifact> {
    await this.ensureSafeRoot(false);
    requireArtifactLabel(label);
    requireContentId(sha256, 'PNG hash');
    const collection =
      kind === 'texture' ? 'textures' : kind === 'capture' ? 'captures' : 'renders';
    const base = path.join(this.runDirectory(runId), collection, `${label}-${sha256}`);
    const data = await readImmutableFile(`${base}.png`, sha256, DEFAULT_PNG_READ_LIMIT);
    const decoded = decodePng(data);
    return {
      runId,
      kind,
      sha256,
      path: `${base}.png`,
      width: decoded.width,
      height: decoded.height,
      bytes: data.length,
      sourceSha256: sha256,
      strippedMetadata: false,
      data,
    };
  }

  async listPngArtifacts(
    runId: string,
    kind: StoredPngArtifact['kind'],
  ): Promise<readonly { readonly label: string; readonly sha256: string }[]> {
    if (!(await this.ensureSafeRoot(false))) return [];
    const collection =
      kind === 'texture' ? 'textures' : kind === 'capture' ? 'captures' : 'renders';
    const directory = path.join(this.runDirectory(runId), collection);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const artifacts: { label: string; sha256: string }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.png')) continue;
      const match =
        /^(?<label>[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)-(?<hash>[a-f0-9]{64})\.png$/u.exec(
          entry.name,
        );
      if (match?.groups === undefined) continue;
      const labelValue = match.groups.label;
      const hashValue = match.groups.hash;
      if (labelValue !== undefined && hashValue !== undefined) {
        artifacts.push({ label: labelValue, sha256: hashValue });
      }
    }
    return artifacts.sort((left, right) =>
      compareKeys(`${left.label}-${left.sha256}`, `${right.label}-${right.sha256}`),
    );
  }

  async putReview(
    runId: string,
    review: unknown,
    signal?: AbortSignal,
  ): Promise<StoredJsonArtifact> {
    abortIfNeeded(signal);
    await this.ensureSafeRoot(false);
    const runDirectory = this.runDirectory(runId);
    await assertDirectory(runDirectory);
    const bytes = canonicalJsonBytes(review);
    const sha256 = hash(bytes);
    const destination = path.join(runDirectory, 'reviews', `${sha256}.json`);
    await writeImmutableFile(destination, bytes);
    return { runId, kind: 'review', sha256, path: destination, bytes: bytes.length };
  }

  async putCaptureBlob(
    runId: string,
    label: string,
    extension: StoredCaptureBlob['extension'],
    input: Uint8Array,
    signal?: AbortSignal,
  ): Promise<StoredCaptureBlob> {
    abortIfNeeded(signal);
    requireArtifactLabel(label);
    const data = Buffer.from(input);
    if (data.length === 0 || data.length > MAX_CAPTURE_BLOB_BYTES) {
      throw new Error(
        `Capture evidence blob must contain 1-${String(MAX_CAPTURE_BLOB_BYTES)} bytes.`,
      );
    }
    await this.ensureSafeRoot(false);
    const runDirectory = this.runDirectory(runId);
    await assertDirectory(runDirectory);
    const sha256 = hash(data);
    const destination = path.join(
      runDirectory,
      'captures',
      'evidence',
      `${label}-${sha256}.${extension}`,
    );
    await writeImmutableFile(destination, data);
    return { runId, label, extension, sha256, path: destination, bytes: data.length };
  }

  async readCaptureBlob(
    runId: string,
    label: string,
    extension: StoredCaptureBlob['extension'],
    sha256: string,
  ): Promise<ReadCaptureBlob> {
    await this.ensureSafeRoot(false);
    requireArtifactLabel(label);
    requireContentId(sha256, 'Capture evidence hash');
    const filename = path.join(
      this.runDirectory(runId),
      'captures',
      'evidence',
      `${label}-${sha256}.${extension}`,
    );
    const data = await readImmutableFile(filename, sha256, MAX_CAPTURE_BLOB_BYTES);
    return {
      runId,
      label,
      extension,
      sha256,
      path: filename,
      bytes: data.length,
      data,
    };
  }

  async readReview(runId: string, sha256: string): Promise<ReadJsonArtifact> {
    await this.ensureSafeRoot(false);
    requireContentId(sha256, 'Review hash');
    const filename = path.join(this.runDirectory(runId), 'reviews', `${sha256}.json`);
    const bytes = await readImmutableFile(filename, sha256, MAX_JSON_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new Error('Visual review is malformed.');
    }
    if (!bytes.equals(canonicalJsonBytes(value)))
      throw new Error('Visual review is not canonical.');
    return {
      runId,
      kind: 'review',
      sha256,
      path: filename,
      bytes: bytes.length,
      value,
    };
  }

  async putCompiled(
    runId: string,
    files: Readonly<Record<string, Uint8Array | string>>,
    signal?: AbortSignal,
  ): Promise<StoredCompiledArtifact> {
    abortIfNeeded(signal);
    await this.ensureSafeRoot(false);
    const runDirectory = this.runDirectory(runId);
    await assertDirectory(runDirectory);
    const entries = Object.entries(files)
      .map(([filename, content]) => ({
        path: normalizeCompiledPath(filename),
        content: typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content),
      }))
      .sort((left, right) => compareKeys(left.path, right.path));
    if (entries.length === 0) throw new Error('Compiled artifact must contain at least one file.');
    if (entries.length > MAX_COMPILED_FILES) {
      throw new Error(`Compiled artifact exceeds the ${String(MAX_COMPILED_FILES)}-file limit.`);
    }
    const duplicate = entries.find((entry, index) => entry.path === entries[index - 1]?.path);
    if (duplicate !== undefined)
      throw new Error(`Compiled artifact repeats path ${duplicate.path}.`);
    let totalBytes = 0;
    const manifestFiles = entries.map((entry) => {
      totalBytes += entry.content.length;
      if (totalBytes > MAX_COMPILED_BYTES) {
        throw new Error(`Compiled artifact exceeds the ${String(MAX_COMPILED_BYTES)}-byte limit.`);
      }
      return { path: entry.path, sha256: hash(entry.content), bytes: entry.content.length };
    });
    const artifactId = hash(canonicalJsonBytes({ files: manifestFiles }));
    const compiledRoot = path.join(runDirectory, 'compiled');
    await mkdir(compiledRoot, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await assertDirectory(compiledRoot);
    const directory = path.join(compiledRoot, artifactId);
    const temporary = path.join(compiledRoot, `.${artifactId}.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      for (const entry of entries) {
        abortIfNeeded(signal);
        const filename = path.join(temporary, ...entry.path.split('/'));
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, entry.content, { flag: 'wx', mode: 0o444 });
      }
      await writeFile(
        path.join(temporary, 'artifact.json'),
        canonicalJsonBytes({ schemaVersion: 1, artifactId, files: manifestFiles, totalBytes }),
        { flag: 'wx', mode: 0o444 },
      );
      const installed = await installImmutableDirectory(temporary, directory);
      if (!installed) {
        await Promise.all(
          manifestFiles.map((entry) =>
            readImmutableFile(path.join(directory, ...entry.path.split('/')), entry.sha256),
          ),
        );
      }
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
    return { runId, artifactId, directory, files: manifestFiles, totalBytes };
  }

  async readCompiled(runId: string, artifactId: string): Promise<ReadCompiledArtifact> {
    await this.ensureSafeRoot(false);
    requireContentId(artifactId, 'Compiled artifact ID');
    const directory = path.join(this.runDirectory(runId), 'compiled', artifactId);
    await assertDirectory(directory);
    const manifest = jsonObject(
      await readCanonicalJson(path.join(directory, 'artifact.json')),
      'Compiled artifact manifest',
    );
    if (
      jsonNumber(manifest, 'schemaVersion') !== 1 ||
      jsonString(manifest, 'artifactId') !== artifactId
    ) {
      throw new Error('Compiled artifact manifest identity is invalid.');
    }
    const filesValue = manifest.files;
    if (
      !Array.isArray(filesValue) ||
      filesValue.length === 0 ||
      filesValue.length > MAX_COMPILED_FILES
    ) {
      throw new Error('Compiled artifact manifest file list is invalid.');
    }
    const files = filesValue.map((entryValue) => {
      const entry = jsonObject(entryValue, 'Compiled artifact entry');
      const entryPath = normalizeCompiledPath(jsonString(entry, 'path'));
      const entrySha256 = jsonString(entry, 'sha256');
      requireContentId(entrySha256, 'Compiled file hash');
      const bytes = jsonNumber(entry, 'bytes');
      if (bytes < 0 || bytes > MAX_COMPILED_BYTES) {
        throw new Error('Compiled artifact file byte count is invalid.');
      }
      return { path: entryPath, sha256: entrySha256, bytes };
    });
    const sorted = [...files].sort((left, right) => compareKeys(left.path, right.path));
    if (files.some((entry, index) => entry.path !== sorted[index]?.path)) {
      throw new Error('Compiled artifact manifest file list is not sorted.');
    }
    if (files.some((entry, index) => entry.path === files[index - 1]?.path)) {
      throw new Error('Compiled artifact manifest contains duplicate paths.');
    }
    const expectedArtifactId = hash(canonicalJsonBytes({ files }));
    if (expectedArtifactId !== artifactId) {
      throw new Error('Compiled artifact manifest does not match its artifact ID.');
    }
    const totalBytes = jsonNumber(manifest, 'totalBytes');
    const computedTotal = files.reduce((total, entry) => total + entry.bytes, 0);
    if (totalBytes !== computedTotal || totalBytes > MAX_COMPILED_BYTES) {
      throw new Error('Compiled artifact total byte count is invalid.');
    }
    const contents: Record<string, Buffer> = {};
    for (const entry of files) {
      const content = await readImmutableFile(
        path.join(directory, ...entry.path.split('/')),
        entry.sha256,
        entry.bytes,
      );
      if (content.length !== entry.bytes) {
        throw new Error('Compiled artifact file byte count does not match its manifest.');
      }
      contents[entry.path] = content;
    }
    return { runId, artifactId, directory, files, totalBytes, contents };
  }

  async listCompiledArtifacts(runId: string): Promise<readonly string[]> {
    if (!(await this.ensureSafeRoot(false))) return [];
    const directory = path.join(this.runDirectory(runId), 'compiled');
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!CONTENT_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('Compiled artifact path is not a real directory.');
      }
      ids.push(entry.name);
    }
    return ids.sort(compareKeys);
  }
}
