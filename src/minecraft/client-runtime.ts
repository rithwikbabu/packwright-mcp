import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import path from 'node:path';

import { PackwrightError } from '../core/errors.js';
import { sha256Buffer } from '../core/hash.js';
import { MINECRAFT_26_2 } from '../core/version.js';
import { canonicalJsonBytes } from '../visual/run-store.js';

const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_ID = '26.2' as const;
const MAX_VERSION_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_OBJECTS = 200_000;
const MAX_LIBRARIES = 4_096;
const MAX_NATIVE_ENTRIES = 4_096;
const MAX_NATIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_NATIVE_COMPRESSION_RATIO = 1_000;

const METADATA_HOSTS = new Set([
  'launcher.mojang.com',
  'piston-data.mojang.com',
  'piston-meta.mojang.com',
]);
const LIBRARY_HOSTS = new Set(['libraries.minecraft.net', 'maven.fabricmc.net']);

type JsonObject = Readonly<Record<string, unknown>>;

export type MojangOsName = 'linux' | 'osx' | 'windows';
export type ClientRuntimeArchitecture = 'arm32' | 'arm64' | 'x86' | 'x86_64';

export interface ClientRuntimePlatform {
  readonly os: MojangOsName;
  readonly architecture: ClientRuntimeArchitecture;
  /** Value matched against Mojang's optional rule `os.arch` regular expression. */
  readonly ruleArchitecture: string;
  /** Value matched against Mojang's optional rule `os.version` regular expression. */
  readonly osVersion: string;
  readonly bits: 32 | 64;
}

export interface MojangOsRule {
  readonly name?: MojangOsName | undefined;
  readonly arch?: string | undefined;
  readonly version?: string | undefined;
}

export interface MojangRule {
  readonly action: 'allow' | 'disallow';
  readonly os?: MojangOsRule | undefined;
  readonly features?: Readonly<Record<string, boolean>> | undefined;
}

export type ClientRuntimeArtifactKind =
  'asset' | 'asset_index' | 'client' | 'library' | 'logging' | 'native' | 'version_metadata';

export interface ClientRuntimeArtifact {
  readonly id: string;
  readonly kind: ClientRuntimeArtifactKind;
  readonly cachePath: string;
  readonly sha1: string;
  readonly size: number;
  readonly url: string;
  /** Asset-index logical names sharing this content-addressed object. */
  readonly logicalNames?: readonly string[] | undefined;
}

export interface NativeExtractionRequirement {
  readonly library: string;
  readonly classifier: string;
  readonly artifactCachePath: string;
  readonly artifactSha1: string;
  readonly excludes: readonly string[];
}

export interface ClientRuntimeManifest {
  readonly schemaVersion: 1;
  readonly minecraftVersion: typeof VERSION_ID;
  readonly javaMajor: 25;
  readonly platform: ClientRuntimePlatform;
  readonly mainClass: string;
  readonly assetIndexId: string;
  readonly versionMetadataSha1: string;
  readonly assetIndexSha1: string;
  readonly artifacts: readonly ClientRuntimeArtifact[];
  readonly nativeExtractions: readonly NativeExtractionRequirement[];
}

export interface HashedClientRuntimeManifest {
  readonly manifest: ClientRuntimeManifest;
  readonly sha256: string;
}

export interface ParseClientRuntimeOptions {
  /** Defaults to Packwright's pinned official 26.2 metadata digest. */
  readonly expectedVersionMetadataSha1?: string | undefined;
  /** Defaults to Packwright's pinned official 26.2 metadata URL. */
  readonly versionMetadataUrl?: string | undefined;
  /** Feature values used only when a library rule contains a `features` predicate. */
  readonly features?: Readonly<Record<string, boolean>> | undefined;
}

export type ClientRuntimePreflightIssueCode =
  | 'changed'
  | 'hash_mismatch'
  | 'missing'
  | 'not_directory'
  | 'not_file'
  | 'size_mismatch'
  | 'symlink'
  | 'unreadable';

export interface ClientRuntimePreflightIssue {
  readonly cachePath: string;
  readonly code: ClientRuntimePreflightIssueCode;
  readonly message: string;
}

export interface VerifiedClientRuntimeArtifact {
  readonly cachePath: string;
  readonly sha1: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ClientRuntimePreflightResult {
  readonly ready: boolean;
  readonly status: 'ready' | 'setup_required';
  readonly manifestSha256: string;
  readonly artifactsChecked: number;
  readonly verified: readonly VerifiedClientRuntimeArtifact[];
  readonly issues: readonly ClientRuntimePreflightIssue[];
}

export interface NativeZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly directory?: boolean | undefined;
  /** Unix file mode from the ZIP external attributes, when available. */
  readonly unixMode?: number | undefined;
}

export interface NativeExtractionPlanEntry {
  readonly sourceEntry: string;
  readonly destinationPath: string;
  readonly size: number;
}

export interface NativeExtractionPlan {
  readonly sourceCachePath: string;
  readonly sourceSha1: string;
  readonly extractionRoot: string;
  readonly entries: readonly NativeExtractionPlanEntry[];
  readonly totalBytes: number;
}

export interface GraphicalSessionProbeResult {
  readonly available: boolean;
  readonly interactive: boolean;
  readonly description: string;
}

export interface GraphicalSessionProbe {
  readonly name: string;
  probe(signal?: AbortSignal): Promise<GraphicalSessionProbeResult>;
}

export interface GraphicalSessionReadiness {
  readonly ready: boolean;
  readonly status: 'ready' | 'setup_required';
  readonly probe: string;
  readonly message: string;
}

export interface GraphicalSessionCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GraphicalSessionCommandRunner = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<GraphicalSessionCommandResult>;

interface DownloadArtifact {
  readonly sha1: string;
  readonly size: number;
  readonly url: string;
  readonly path?: string | undefined;
}

interface ParsedAssetIndex {
  readonly id: string;
  readonly sha1: string;
  readonly size: number;
  readonly url: string;
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PackwrightError('invalid_content', `${label} must be a JSON object.`);
  }
  return value as JsonObject;
}

function jsonText(bytes: Uint8Array, label: string, maximumBytes: number): string {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new PackwrightError(
      'size_limit',
      `${label} must contain between 1 and ${String(maximumBytes)} bytes.`,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new PackwrightError('invalid_content', `${label} is not valid UTF-8.`);
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string, maximumBytes: number): unknown {
  try {
    return JSON.parse(jsonText(bytes, label, maximumBytes)) as unknown;
  } catch (error) {
    if (error instanceof PackwrightError) throw error;
    throw new PackwrightError('invalid_content', `${label} is not valid JSON.`);
  }
}

function sha1(value: Uint8Array | string): string {
  return createHash('sha1').update(value).digest('hex');
}

function requiredString(object: JsonObject, field: string, label: string): string {
  const value = object[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PackwrightError('invalid_content', `${label}.${field} must be a non-empty string.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PackwrightError('invalid_content', `${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireSha1(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA1_PATTERN.test(value)) {
    throw new PackwrightError('invalid_content', `${label} must be a lowercase SHA-1 digest.`);
  }
  return value;
}

function safeRelativePath(value: string, label: string): string {
  let containsControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      containsControlCharacter = true;
      break;
    }
  }
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes('\\') ||
    value.includes('\0') ||
    containsControlCharacter ||
    path.posix.isAbsolute(value)
  ) {
    throw new PackwrightError('unsafe_path', `${label} is not a safe relative POSIX path.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new PackwrightError('unsafe_path', `${label} contains non-canonical path segments.`);
  }
  return value;
}

function safePathPrefix(value: string, label: string): string {
  const withoutSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  return `${safeRelativePath(withoutSlash, label)}/`;
}

function officialUrl(value: string, hosts: ReadonlySet<string>, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PackwrightError('invalid_content', `${label} has an invalid URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    !hosts.has(url.hostname) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new PackwrightError('invalid_content', `${label} does not use an allowed official URL.`);
  }
  return url.href;
}

function metadataArtifact(value: unknown, label: string): DownloadArtifact {
  const object = jsonObject(value, label);
  return {
    sha1: requireSha1(object.sha1, `${label}.sha1`),
    size: positiveSafeInteger(object.size, `${label}.size`),
    url: officialUrl(requiredString(object, 'url', label), METADATA_HOSTS, `${label}.url`),
  };
}

function libraryArtifact(value: unknown, label: string): DownloadArtifact {
  const object = jsonObject(value, label);
  const artifactPath = safeRelativePath(requiredString(object, 'path', label), `${label}.path`);
  const url = officialUrl(requiredString(object, 'url', label), LIBRARY_HOSTS, `${label}.url`);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(new URL(url).pathname);
  } catch {
    throw new PackwrightError('invalid_content', `${label}.url contains invalid path encoding.`);
  }
  if (decodedPath !== `/${artifactPath}`) {
    throw new PackwrightError(
      'invalid_content',
      `${label}.url does not match its launcher library path.`,
    );
  }
  return {
    path: artifactPath,
    sha1: requireSha1(object.sha1, `${label}.sha1`),
    size: positiveSafeInteger(object.size, `${label}.size`),
    url,
  };
}

function parseAssetIndexMetadata(value: unknown): ParsedAssetIndex {
  const object = jsonObject(value, 'Minecraft assetIndex');
  const id = requiredString(object, 'id', 'Minecraft assetIndex');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new PackwrightError('invalid_content', 'Minecraft assetIndex.id is not canonical.');
  }
  const artifact = metadataArtifact(value, 'Minecraft assetIndex');
  return { id, ...artifact };
}

function optionalRegex(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new PackwrightError('invalid_content', `${label} must be a bounded regular expression.`);
  }
  try {
    new RegExp(value, 'u');
  } catch {
    throw new PackwrightError('invalid_content', `${label} is not a valid regular expression.`);
  }
  return value;
}

function parseRule(value: unknown, label: string): MojangRule {
  const object = jsonObject(value, label);
  if (object.action !== 'allow' && object.action !== 'disallow') {
    throw new PackwrightError('invalid_content', `${label}.action is invalid.`);
  }
  let osRule: MojangOsRule | undefined;
  if (object.os !== undefined) {
    const os = jsonObject(object.os, `${label}.os`);
    const name = os.name;
    if (name !== undefined && name !== 'linux' && name !== 'osx' && name !== 'windows') {
      throw new PackwrightError('invalid_content', `${label}.os.name is invalid.`);
    }
    const arch = optionalRegex(os.arch, `${label}.os.arch`);
    const version = optionalRegex(os.version, `${label}.os.version`);
    osRule = {
      ...(name === undefined ? {} : { name }),
      ...(arch === undefined ? {} : { arch }),
      ...(version === undefined ? {} : { version }),
    };
  }
  let features: Readonly<Record<string, boolean>> | undefined;
  if (object.features !== undefined) {
    const raw = jsonObject(object.features, `${label}.features`);
    const parsed: Record<string, boolean> = {};
    for (const [feature, enabled] of Object.entries(raw)) {
      if (!/^[a-z][a-z0-9_]{0,127}$/u.test(feature) || typeof enabled !== 'boolean') {
        throw new PackwrightError('invalid_content', `${label}.features is invalid.`);
      }
      parsed[feature] = enabled;
    }
    features = parsed;
  }
  return {
    action: object.action,
    ...(osRule === undefined ? {} : { os: osRule }),
    ...(features === undefined ? {} : { features }),
  };
}

function parseRules(value: unknown, label: string): readonly MojangRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new PackwrightError('invalid_content', `${label} must be a non-empty bounded array.`);
  }
  return value.map((rule, index) => parseRule(rule, `${label}[${String(index)}]`));
}

function regexMatches(pattern: string, value: string): boolean {
  return new RegExp(pattern, 'u').test(value);
}

export function mojangRuleMatches(
  rule: MojangRule,
  platform: ClientRuntimePlatform,
  features: Readonly<Record<string, boolean>> = {},
): boolean {
  if (rule.os?.name !== undefined && rule.os.name !== platform.os) return false;
  if (rule.os?.arch !== undefined && !regexMatches(rule.os.arch, platform.ruleArchitecture)) {
    return false;
  }
  if (rule.os?.version !== undefined && !regexMatches(rule.os.version, platform.osVersion)) {
    return false;
  }
  return Object.entries(rule.features ?? {}).every(
    ([feature, required]) => (features[feature] ?? false) === required,
  );
}

/** Mojang evaluates matching rules in declaration order; the last matching action wins. */
export function evaluateMojangRules(
  rules: readonly MojangRule[],
  platform: ClientRuntimePlatform,
  features: Readonly<Record<string, boolean>> = {},
): boolean {
  if (rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (mojangRuleMatches(rule, platform, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

/**
 * Minecraft 26.2 publishes native JARs as ordinary four-part Maven
 * coordinates. Their launcher rules select the operating system, but do not
 * distinguish `natives-macos` (Intel) from `natives-macos-arm64` (Apple
 * silicon), or the equivalent Netty classifiers. Keep exactly one native
 * architecture on the classpath instead of relying on JAR ordering when two
 * artifacts contain the same native resource name.
 */
export function libraryClassifierMatchesArchitecture(
  coordinate: string,
  platform: ClientRuntimePlatform,
): boolean {
  const classifier = coordinate.split(':')[3]?.toLowerCase();
  if (classifier === undefined) return true;

  const nativeOs =
    classifier.startsWith('natives-linux') || classifier.startsWith('linux-')
      ? 'linux'
      : classifier.startsWith('natives-macos') ||
          classifier.startsWith('osx-') ||
          classifier.startsWith('macos-')
        ? 'osx'
        : classifier.startsWith('natives-windows') || classifier.startsWith('windows-')
          ? 'windows'
          : undefined;
  if (nativeOs !== undefined && nativeOs !== platform.os) return false;

  if (/(?:^|[-_])(?:arm64|aarch64|aarch_64)(?:$|[-_])/u.test(classifier)) {
    return platform.architecture === 'arm64';
  }
  if (/(?:^|[-_])(?:x86_64|x86-64|amd64)(?:$|[-_])/u.test(classifier)) {
    return platform.architecture === 'x86_64';
  }
  if (/(?:^|[-_])(?:x86|i386)(?:$|[-_])/u.test(classifier)) {
    return platform.architecture === 'x86';
  }
  if (/(?:^|[-_])(?:arm32|armv7|arm)(?:$|[-_])/u.test(classifier)) {
    return platform.architecture === 'arm32';
  }

  // Unqualified native classifiers in Mojang's metadata are the historical
  // x86_64 variants. Non-native classifiers such as `unsafe` remain portable.
  if (/^natives-(?:linux|macos|windows)$/u.test(classifier)) {
    return platform.architecture === 'x86_64';
  }
  return true;
}

export function currentClientRuntimePlatform(
  nodePlatform: NodeJS.Platform = process.platform,
  nodeArchitecture: string = process.arch,
  osVersion = osRelease(),
): ClientRuntimePlatform {
  const os: MojangOsName =
    nodePlatform === 'darwin'
      ? 'osx'
      : nodePlatform === 'win32'
        ? 'windows'
        : nodePlatform === 'linux'
          ? 'linux'
          : (() => {
              throw new PackwrightError(
                'invalid_argument',
                `Minecraft client capture does not support platform ${nodePlatform}.`,
              );
            })();
  switch (nodeArchitecture) {
    case 'x64':
      return { os, architecture: 'x86_64', ruleArchitecture: 'x86_64', osVersion, bits: 64 };
    case 'ia32':
      return { os, architecture: 'x86', ruleArchitecture: 'x86', osVersion, bits: 32 };
    case 'arm64':
      return { os, architecture: 'arm64', ruleArchitecture: 'aarch64', osVersion, bits: 64 };
    case 'arm':
      return { os, architecture: 'arm32', ruleArchitecture: 'arm', osVersion, bits: 32 };
    default:
      throw new PackwrightError(
        'invalid_argument',
        `Minecraft client capture does not support architecture ${nodeArchitecture}.`,
      );
  }
}

function nativeClassifier(
  library: JsonObject,
  downloads: JsonObject,
  platform: ClientRuntimePlatform,
  label: string,
): { readonly key: string; readonly artifact: DownloadArtifact } | undefined {
  if (library.natives === undefined) return undefined;
  const natives = jsonObject(library.natives, `${label}.natives`);
  const template = natives[platform.os];
  if (template === undefined) return undefined;
  if (typeof template !== 'string' || template.length === 0 || template.length > 256) {
    throw new PackwrightError('invalid_content', `${label}.natives.${platform.os} is invalid.`);
  }
  const key = template.replaceAll('${arch}', String(platform.bits));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(key)) {
    throw new PackwrightError('invalid_content', `${label} selected an invalid native classifier.`);
  }
  const classifiers = jsonObject(downloads.classifiers, `${label}.downloads.classifiers`);
  if (classifiers[key] === undefined) {
    throw new PackwrightError(
      'invalid_content',
      `${label} does not provide selected native classifier ${key}.`,
    );
  }
  return {
    key,
    artifact: libraryArtifact(classifiers[key], `${label}.downloads.classifiers.${key}`),
  };
}

function nativeExcludes(library: JsonObject, label: string): readonly string[] {
  if (library.extract === undefined) return [];
  const extract = jsonObject(library.extract, `${label}.extract`);
  if (extract.exclude === undefined) return [];
  if (!Array.isArray(extract.exclude) || extract.exclude.length > 128) {
    throw new PackwrightError('invalid_content', `${label}.extract.exclude is invalid.`);
  }
  return extract.exclude
    .map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new PackwrightError(
          'invalid_content',
          `${label}.extract.exclude[${String(index)}] is invalid.`,
        );
      }
      return safePathPrefix(entry, `${label}.extract.exclude[${String(index)}]`);
    })
    .sort();
}

function artifactOrder(left: ClientRuntimeArtifact, right: ClientRuntimeArtifact): number {
  return left.cachePath < right.cachePath
    ? -1
    : left.cachePath > right.cachePath
      ? 1
      : left.kind < right.kind
        ? -1
        : left.kind > right.kind
          ? 1
          : left.id < right.id
            ? -1
            : left.id > right.id
              ? 1
              : 0;
}

function addArtifact(
  artifacts: Map<string, ClientRuntimeArtifact>,
  artifact: ClientRuntimeArtifact,
): void {
  safeRelativePath(artifact.cachePath, `Runtime artifact ${artifact.id} cache path`);
  const previous = artifacts.get(artifact.cachePath);
  if (previous === undefined) {
    artifacts.set(artifact.cachePath, artifact);
    return;
  }
  if (
    previous.sha1 !== artifact.sha1 ||
    previous.size !== artifact.size ||
    previous.url !== artifact.url
  ) {
    throw new PackwrightError(
      'invalid_content',
      `Runtime artifacts conflict at cache path ${artifact.cachePath}.`,
    );
  }
  const logicalNames = [...(previous.logicalNames ?? []), ...(artifact.logicalNames ?? [])].sort();
  artifacts.set(artifact.cachePath, {
    ...previous,
    ...(logicalNames.length === 0 ? {} : { logicalNames: [...new Set(logicalNames)] }),
  });
}

function assetObjectArtifacts(assetIndexValue: unknown): readonly ClientRuntimeArtifact[] {
  const assetIndex = jsonObject(assetIndexValue, 'Minecraft asset index');
  const objects = jsonObject(assetIndex.objects, 'Minecraft asset index.objects');
  const entries = Object.entries(objects);
  if (entries.length > MAX_ASSET_OBJECTS) {
    throw new PackwrightError(
      'size_limit',
      `Minecraft asset index exceeds ${String(MAX_ASSET_OBJECTS)} objects.`,
    );
  }
  const byHash = new Map<string, { readonly size: number; readonly logicalNames: string[] }>();
  for (const [logicalName, raw] of entries) {
    safeRelativePath(logicalName, `Minecraft asset object ${logicalName}`);
    const object = jsonObject(raw, `Minecraft asset object ${logicalName}`);
    const hash = requireSha1(object.hash, `Minecraft asset object ${logicalName}.hash`);
    const size = positiveSafeInteger(object.size, `Minecraft asset object ${logicalName}.size`);
    const previous = byHash.get(hash);
    if (previous !== undefined && previous.size !== size) {
      throw new PackwrightError(
        'invalid_content',
        `Minecraft asset object hash ${hash} has conflicting sizes.`,
      );
    }
    if (previous === undefined) byHash.set(hash, { size, logicalNames: [logicalName] });
    else previous.logicalNames.push(logicalName);
  }
  return [...byHash.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([hash, object]) => ({
      id: `asset:${hash}`,
      kind: 'asset' as const,
      cachePath: `assets/objects/${hash.slice(0, 2)}/${hash}`,
      sha1: hash,
      size: object.size,
      url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
      logicalNames: object.logicalNames.sort(),
    }));
}

/**
 * Parse manifest-verified Minecraft 26.2 client metadata and its exact asset index into a
 * platform-specific, content-addressed runtime manifest. This function never accesses the network.
 */
export function createClientRuntimeManifest(
  versionMetadataInput: Uint8Array | string,
  assetIndexInput: Uint8Array | string,
  platform: ClientRuntimePlatform,
  options: ParseClientRuntimeOptions = {},
): HashedClientRuntimeManifest {
  const versionBytes =
    typeof versionMetadataInput === 'string'
      ? Buffer.from(versionMetadataInput, 'utf8')
      : Buffer.from(versionMetadataInput);
  const assetIndexBytes =
    typeof assetIndexInput === 'string'
      ? Buffer.from(assetIndexInput, 'utf8')
      : Buffer.from(assetIndexInput);
  const expectedMetadataSha1 =
    options.expectedVersionMetadataSha1 ??
    MINECRAFT_26_2.resourcePack.artifacts.versionMetadataSha1;
  requireSha1(expectedMetadataSha1, 'Expected Minecraft version metadata SHA-1');
  const actualMetadataSha1 = sha1(versionBytes);
  if (actualMetadataSha1 !== expectedMetadataSha1) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft 26.2 version metadata does not match its pinned SHA-1.',
      { expected: expectedMetadataSha1, actual: actualMetadataSha1 },
    );
  }
  const metadata = jsonObject(
    parseJsonBytes(versionBytes, 'Minecraft 26.2 version metadata', MAX_VERSION_METADATA_BYTES),
    'Minecraft 26.2 version metadata',
  );
  if (metadata.id !== VERSION_ID) {
    throw new PackwrightError('invalid_content', 'Minecraft client metadata is not version 26.2.');
  }
  const javaVersion = jsonObject(metadata.javaVersion, 'Minecraft javaVersion');
  if (javaVersion.majorVersion !== 25) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft 26.2 client metadata must require Java 25.',
    );
  }
  const mainClass = requiredString(metadata, 'mainClass', 'Minecraft client metadata');
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(mainClass)) {
    throw new PackwrightError('invalid_content', 'Minecraft client mainClass is invalid.');
  }
  const downloads = jsonObject(metadata.downloads, 'Minecraft client downloads');
  const client = metadataArtifact(downloads.client, 'Minecraft client download');
  const assetIndex = parseAssetIndexMetadata(metadata.assetIndex);
  if (assetIndexBytes.byteLength !== assetIndex.size || sha1(assetIndexBytes) !== assetIndex.sha1) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft asset index does not match the version metadata hash and size.',
    );
  }
  const assetIndexValue = parseJsonBytes(
    assetIndexBytes,
    'Minecraft asset index',
    MAX_ASSET_INDEX_BYTES,
  );
  const logging = jsonObject(metadata.logging, 'Minecraft logging');
  const loggingClient = jsonObject(logging.client, 'Minecraft logging.client');
  const loggingFileObject = jsonObject(loggingClient.file, 'Minecraft logging.client.file');
  const loggingFile = metadataArtifact(loggingFileObject, 'Minecraft logging.client.file');
  const loggingId = requiredString(loggingFileObject, 'id', 'Minecraft logging.client.file');
  safeRelativePath(loggingId, 'Minecraft logging.client.file.id');

  const metadataUrl = officialUrl(
    options.versionMetadataUrl ?? MINECRAFT_26_2.resourcePack.artifacts.versionMetadataUrl,
    METADATA_HOSTS,
    'Minecraft version metadata URL',
  );
  const artifacts = new Map<string, ClientRuntimeArtifact>();
  addArtifact(artifacts, {
    id: `version-metadata:${VERSION_ID}`,
    kind: 'version_metadata',
    cachePath: `versions/${VERSION_ID}/${VERSION_ID}.json`,
    sha1: actualMetadataSha1,
    size: versionBytes.byteLength,
    url: metadataUrl,
  });
  addArtifact(artifacts, {
    id: `client:${VERSION_ID}`,
    kind: 'client',
    cachePath: `versions/${VERSION_ID}/${VERSION_ID}.jar`,
    ...client,
  });
  addArtifact(artifacts, {
    id: `asset-index:${assetIndex.id}`,
    kind: 'asset_index',
    cachePath: `assets/indexes/${assetIndex.id}.json`,
    sha1: assetIndex.sha1,
    size: assetIndex.size,
    url: assetIndex.url,
  });
  addArtifact(artifacts, {
    id: `logging:${loggingId}`,
    kind: 'logging',
    cachePath: `assets/log_configs/${loggingId}`,
    ...loggingFile,
  });

  if (!Array.isArray(metadata.libraries) || metadata.libraries.length > MAX_LIBRARIES) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft libraries list is invalid or unbounded.',
    );
  }
  const nativeExtractions: NativeExtractionRequirement[] = [];
  for (const [index, rawLibrary] of metadata.libraries.entries()) {
    const label = `Minecraft libraries[${String(index)}]`;
    const library = jsonObject(rawLibrary, label);
    const name = requiredString(library, 'name', label);
    if (
      name.length > 512 ||
      !/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.+-]+(?::[A-Za-z0-9_.+-]+)?$/u.test(name)
    ) {
      throw new PackwrightError('invalid_content', `${label}.name is invalid.`);
    }
    const rules = parseRules(library.rules, `${label}.rules`);
    if (!evaluateMojangRules(rules, platform, options.features)) continue;
    if (!libraryClassifierMatchesArchitecture(name, platform)) continue;
    const libraryDownloads = jsonObject(library.downloads, `${label}.downloads`);
    if (libraryDownloads.artifact !== undefined) {
      const artifact = libraryArtifact(libraryDownloads.artifact, `${label}.downloads.artifact`);
      addArtifact(artifacts, {
        id: `library:${name}`,
        kind: 'library',
        cachePath: `libraries/${artifact.path ?? ''}`,
        sha1: artifact.sha1,
        size: artifact.size,
        url: artifact.url,
      });
    }
    const selectedNative = nativeClassifier(library, libraryDownloads, platform, label);
    if (selectedNative !== undefined) {
      const artifact = selectedNative.artifact;
      const cachePath = `libraries/${artifact.path ?? ''}`;
      addArtifact(artifacts, {
        id: `native:${name}:${selectedNative.key}`,
        kind: 'native',
        cachePath,
        sha1: artifact.sha1,
        size: artifact.size,
        url: artifact.url,
      });
      nativeExtractions.push({
        library: name,
        classifier: selectedNative.key,
        artifactCachePath: cachePath,
        artifactSha1: artifact.sha1,
        excludes: nativeExcludes(library, label),
      });
    }
  }
  for (const artifact of assetObjectArtifacts(assetIndexValue)) addArtifact(artifacts, artifact);

  const manifest: ClientRuntimeManifest = {
    schemaVersion: 1,
    minecraftVersion: VERSION_ID,
    javaMajor: 25,
    platform,
    mainClass,
    assetIndexId: assetIndex.id,
    versionMetadataSha1: actualMetadataSha1,
    assetIndexSha1: assetIndex.sha1,
    artifacts: [...artifacts.values()].sort(artifactOrder),
    nativeExtractions: nativeExtractions.sort((left, right) =>
      left.artifactCachePath < right.artifactCachePath
        ? -1
        : left.artifactCachePath > right.artifactCachePath
          ? 1
          : 0,
    ),
  };
  return { manifest, sha256: sha256Buffer(canonicalJsonBytes(manifest)) };
}

function sameIdentity(
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

function preflightIssue(
  artifact: ClientRuntimeArtifact,
  code: ClientRuntimePreflightIssueCode,
  message: string,
): ClientRuntimePreflightIssue {
  return { cachePath: artifact.cachePath, code, message };
}

function validateRuntimeManifest(runtime: HashedClientRuntimeManifest): void {
  const manifest = runtime.manifest;
  const identity = manifest as unknown as Readonly<Record<string, unknown>>;
  if (
    identity.schemaVersion !== 1 ||
    identity.minecraftVersion !== VERSION_ID ||
    identity.javaMajor !== 25 ||
    manifest.artifacts.length === 0 ||
    manifest.artifacts.length > MAX_ASSET_OBJECTS + MAX_LIBRARIES * 2 + 4 ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(manifest.mainClass) ||
    !SHA1_PATTERN.test(manifest.versionMetadataSha1) ||
    !SHA1_PATTERN.test(manifest.assetIndexSha1)
  ) {
    throw new PackwrightError('invalid_content', 'Minecraft client runtime manifest is invalid.');
  }
  const seenPaths = new Set<string>();
  let previousArtifact: ClientRuntimeArtifact | undefined;
  for (const artifact of manifest.artifacts) {
    safeRelativePath(artifact.cachePath, `Runtime artifact ${artifact.id} cache path`);
    requireSha1(artifact.sha1, `Runtime artifact ${artifact.id} SHA-1`);
    positiveSafeInteger(artifact.size, `Runtime artifact ${artifact.id} size`);
    if (
      artifact.id.length === 0 ||
      artifact.id.length > 1_024 ||
      seenPaths.has(artifact.cachePath)
    ) {
      throw new PackwrightError(
        'invalid_content',
        'Runtime artifact identity is duplicated or invalid.',
      );
    }
    seenPaths.add(artifact.cachePath);
    if (previousArtifact !== undefined && artifactOrder(previousArtifact, artifact) >= 0) {
      throw new PackwrightError(
        'invalid_content',
        'Runtime artifacts are not canonically ordered.',
      );
    }
    previousArtifact = artifact;
    if (artifact.kind === 'asset') {
      const expectedUrl = `https://resources.download.minecraft.net/${artifact.sha1.slice(0, 2)}/${artifact.sha1}`;
      if (
        artifact.url !== expectedUrl ||
        artifact.cachePath !== `assets/objects/${artifact.sha1.slice(0, 2)}/${artifact.sha1}` ||
        artifact.logicalNames === undefined ||
        artifact.logicalNames.length === 0
      ) {
        throw new PackwrightError('invalid_content', 'Runtime asset-object identity is invalid.');
      }
      for (const logicalName of artifact.logicalNames) {
        safeRelativePath(logicalName, 'Runtime asset logical name');
      }
    } else if (artifact.kind === 'library' || artifact.kind === 'native') {
      officialUrl(artifact.url, LIBRARY_HOSTS, `Runtime artifact ${artifact.id} URL`);
      if (!artifact.cachePath.startsWith('libraries/')) {
        throw new PackwrightError('invalid_content', 'Runtime library cache path is invalid.');
      }
    } else {
      officialUrl(artifact.url, METADATA_HOSTS, `Runtime artifact ${artifact.id} URL`);
    }
  }
  const nativeArtifacts = new Map(
    manifest.artifacts
      .filter((artifact) => artifact.kind === 'native')
      .map((artifact) => [artifact.cachePath, artifact] as const),
  );
  let previousNativePath: string | undefined;
  for (const extraction of manifest.nativeExtractions) {
    const artifact = nativeArtifacts.get(extraction.artifactCachePath);
    if (
      artifact?.sha1 !== extraction.artifactSha1 ||
      extraction.library.length === 0 ||
      extraction.classifier.length === 0 ||
      (previousNativePath !== undefined && previousNativePath >= extraction.artifactCachePath)
    ) {
      throw new PackwrightError(
        'invalid_content',
        'Runtime native extraction identity is invalid.',
      );
    }
    extraction.excludes.forEach((exclude, index) =>
      safePathPrefix(exclude, `Runtime native exclusion ${String(index)}`),
    );
    previousNativePath = extraction.artifactCachePath;
  }
}

async function verifyRuntimeArtifact(
  cacheRoot: string,
  artifact: ClientRuntimeArtifact,
  checkedDirectories: Set<string>,
  signal?: AbortSignal,
): Promise<VerifiedClientRuntimeArtifact | ClientRuntimePreflightIssue> {
  const relative = safeRelativePath(
    artifact.cachePath,
    `Runtime artifact ${artifact.id} cache path`,
  );
  const segments = relative.split('/');
  let current = cacheRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (checkedDirectories.has(current)) continue;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        return preflightIssue(artifact, 'symlink', 'A runtime cache directory is a symlink.');
      }
      if (!info.isDirectory()) {
        return preflightIssue(
          artifact,
          'not_directory',
          'A runtime cache parent is not a directory.',
        );
      }
      checkedDirectories.add(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return preflightIssue(artifact, 'missing', 'A runtime cache directory is missing.');
      }
      return preflightIssue(
        artifact,
        'unreadable',
        `A runtime cache directory is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const filename = path.join(cacheRoot, ...segments);
  let pathInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    pathInfo = await lstat(filename);
  } catch (error) {
    return preflightIssue(
      artifact,
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Runtime artifact is missing.'
        : `Runtime artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (pathInfo.isSymbolicLink()) {
    return preflightIssue(artifact, 'symlink', 'Runtime artifact is a symlink.');
  }
  if (!pathInfo.isFile()) {
    return preflightIssue(artifact, 'not_file', 'Runtime artifact is not a regular file.');
  }
  if (pathInfo.size !== artifact.size) {
    return preflightIssue(
      artifact,
      'size_mismatch',
      'Runtime artifact size does not match metadata.',
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return preflightIssue(
      artifact,
      'unreadable',
      `Runtime artifact could not be opened safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(pathInfo, before)) {
      return preflightIssue(artifact, 'changed', 'Runtime artifact changed before verification.');
    }
    const sha1Hash = createHash('sha1');
    const sha256Hash = createHash('sha256');
    let position = 0;
    while (position < before.size) {
      if (signal?.aborted) {
        throw new PackwrightError('cancelled', 'Minecraft client runtime preflight was cancelled.');
      }
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, before.size - position));
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      sha1Hash.update(chunk);
      sha256Hash.update(chunk);
      position += result.bytesRead;
    }
    const [after, finalPathInfo] = await Promise.all([handle.stat(), lstat(filename)]);
    if (
      position !== artifact.size ||
      !sameIdentity(before, after) ||
      !sameIdentity(after, finalPathInfo) ||
      finalPathInfo.isSymbolicLink()
    ) {
      return preflightIssue(artifact, 'changed', 'Runtime artifact changed during verification.');
    }
    const actualSha1 = sha1Hash.digest('hex');
    if (actualSha1 !== artifact.sha1) {
      return preflightIssue(
        artifact,
        'hash_mismatch',
        'Runtime artifact SHA-1 does not match metadata.',
      );
    }
    return {
      cachePath: artifact.cachePath,
      sha1: actualSha1,
      sha256: sha256Hash.digest('hex'),
      size: artifact.size,
    };
  } finally {
    await handle.close();
  }
}

/** Verify a complete prepared runtime without downloading or repairing anything. */
export async function preflightClientRuntime(
  cacheRoot: string,
  runtime: HashedClientRuntimeManifest,
  signal?: AbortSignal,
): Promise<ClientRuntimePreflightResult> {
  if (!path.isAbsolute(cacheRoot)) {
    throw new PackwrightError(
      'invalid_argument',
      'Minecraft client runtime cache root must be absolute.',
    );
  }
  validateRuntimeManifest(runtime);
  const canonicalHash = sha256Buffer(canonicalJsonBytes(runtime.manifest));
  if (canonicalHash !== runtime.sha256) {
    throw new PackwrightError(
      'invalid_content',
      'Minecraft client runtime manifest hash is invalid.',
    );
  }
  const resolvedRoot = path.resolve(cacheRoot);
  const rootInfo = await lstat(resolvedRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (rootInfo === undefined) {
    return {
      ready: false,
      status: 'setup_required',
      manifestSha256: runtime.sha256,
      artifactsChecked: 0,
      verified: [],
      issues: [
        {
          cachePath: '.',
          code: 'missing',
          message: 'Minecraft client runtime cache root is missing.',
        },
      ],
    };
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return {
      ready: false,
      status: 'setup_required',
      manifestSha256: runtime.sha256,
      artifactsChecked: 0,
      verified: [],
      issues: [
        {
          cachePath: '.',
          code: rootInfo.isSymbolicLink() ? 'symlink' : 'not_directory',
          message: 'Minecraft client runtime cache root is not a trusted real directory.',
        },
      ],
    };
  }
  const checkedDirectories = new Set([resolvedRoot]);
  const verified: VerifiedClientRuntimeArtifact[] = [];
  const issues: ClientRuntimePreflightIssue[] = [];
  for (const artifact of runtime.manifest.artifacts) {
    if (signal?.aborted) {
      throw new PackwrightError('cancelled', 'Minecraft client runtime preflight was cancelled.');
    }
    const result = await verifyRuntimeArtifact(resolvedRoot, artifact, checkedDirectories, signal);
    if ('code' in result) issues.push(result);
    else verified.push(result);
  }
  return {
    ready: issues.length === 0,
    status: issues.length === 0 ? 'ready' : 'setup_required',
    manifestSha256: runtime.sha256,
    artifactsChecked: runtime.manifest.artifacts.length,
    verified,
    issues,
  };
}

function zipEntryKind(mode: number | undefined): 'directory' | 'regular' | 'symlink' | 'unsafe' {
  if (mode === undefined || (mode & 0o170000) === 0) return 'regular';
  const kind = mode & 0o170000;
  if (kind === 0o040000) return 'directory';
  if (kind === 0o100000) return 'regular';
  if (kind === 0o120000) return 'symlink';
  return 'unsafe';
}

/**
 * Convert already-inspected ZIP central-directory entries into a confined extraction plan.
 * Callers remain responsible for bounded decompression and atomic file installation.
 */
export function planNativeExtraction(
  requirement: NativeExtractionRequirement,
  entries: readonly NativeZipEntry[],
  extractionRoot: string,
): NativeExtractionPlan {
  const root = safeRelativePath(extractionRoot, 'Native extraction root');
  if (entries.length > MAX_NATIVE_ENTRIES) {
    throw new PackwrightError('size_limit', 'Native archive contains too many entries.');
  }
  const excludes = requirement.excludes.map((entry, index) =>
    safePathPrefix(entry, `Native exclusion ${String(index)}`),
  );
  const planned: NativeExtractionPlanEntry[] = [];
  const destinations = new Set<string>();
  let totalBytes = 0;
  for (const [index, entry] of entries.entries()) {
    if (
      !Number.isSafeInteger(entry.compressedSize) ||
      entry.compressedSize < 0 ||
      !Number.isSafeInteger(entry.uncompressedSize) ||
      entry.uncompressedSize < 0
    ) {
      throw new PackwrightError(
        'invalid_content',
        `Native ZIP entry ${String(index)} has invalid sizes.`,
      );
    }
    const entryKind = zipEntryKind(entry.unixMode);
    const directory =
      entry.directory === true || entry.name.endsWith('/') || entryKind === 'directory';
    const nameWithoutSlash = directory ? entry.name.replace(/\/+$/u, '') : entry.name;
    const name = safeRelativePath(nameWithoutSlash, `Native ZIP entry ${String(index)}`);
    if (entryKind === 'symlink') {
      throw new PackwrightError('unsafe_path', `Native ZIP entry is a symlink: ${name}`);
    }
    if (entryKind === 'unsafe') {
      throw new PackwrightError('unsafe_path', `Native ZIP entry is not a regular file: ${name}`);
    }
    if (
      directory ||
      excludes.some((prefix) => `${name}/`.startsWith(prefix) || name.startsWith(prefix))
    ) {
      continue;
    }
    if (entry.uncompressedSize > MAX_NATIVE_ENTRY_BYTES) {
      throw new PackwrightError('size_limit', `Native ZIP entry is too large: ${name}`);
    }
    if (
      entry.uncompressedSize > 0 &&
      (entry.compressedSize === 0 ||
        entry.uncompressedSize / entry.compressedSize > MAX_NATIVE_COMPRESSION_RATIO)
    ) {
      throw new PackwrightError(
        'size_limit',
        `Native ZIP entry has an unsafe compression ratio: ${name}`,
      );
    }
    totalBytes += entry.uncompressedSize;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_NATIVE_TOTAL_BYTES) {
      throw new PackwrightError('size_limit', 'Native archive expands beyond its byte limit.');
    }
    const destinationPath = `${root}/${name}`;
    const collisionKey = destinationPath.toLocaleLowerCase('en-US');
    if (destinations.has(collisionKey)) {
      throw new PackwrightError(
        'invalid_content',
        `Native archive contains duplicate or case-colliding paths: ${name}`,
      );
    }
    destinations.add(collisionKey);
    planned.push({ sourceEntry: name, destinationPath, size: entry.uncompressedSize });
  }
  if (planned.length === 0) {
    throw new PackwrightError('invalid_content', 'Native archive has no extractable files.');
  }
  return {
    sourceCachePath: safeRelativePath(requirement.artifactCachePath, 'Native artifact cache path'),
    sourceSha1: requireSha1(requirement.artifactSha1, 'Native artifact SHA-1'),
    extractionRoot: root,
    entries: planned.sort((left, right) =>
      left.destinationPath < right.destinationPath
        ? -1
        : left.destinationPath > right.destinationPath
          ? 1
          : 0,
    ),
    totalBytes,
  };
}

/**
 * Verify that the current user owns an active macOS Aqua login domain.
 *
 * Older launchers commonly used the private `CGSession` helper for this
 * check, but that binary is no longer installed on current macOS releases.
 * `launchctl print gui/<uid>` is the supported, non-interactive way to query
 * the current user's graphical bootstrap domain.
 */
export function createDarwinGraphicalSessionProbe(
  run: GraphicalSessionCommandRunner,
  uid = process.getuid?.(),
): GraphicalSessionProbe {
  return {
    name: 'darwin-launchctl-aqua',
    async probe(signal?: AbortSignal): Promise<GraphicalSessionProbeResult> {
      if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
        return {
          available: false,
          interactive: false,
          description: 'The current macOS user id is unavailable.',
        };
      }
      const result = await run('/bin/launchctl', ['print', `gui/${String(uid)}`], signal);
      const output = `${result.stdout}\n${result.stderr}`;
      const loginDomain = /^\s*type\s*=\s*login\s*$/mu.test(output);
      const aquaSession = /^\s*session\s*=\s*Aqua\s*$/mu.test(output);
      const loginWindow = /^\s*creator\s*=\s*loginwindow(?:\[|\s*$)/mu.test(output);
      const interactive = result.exitCode === 0 && loginDomain && aquaSession && loginWindow;
      return {
        available: result.exitCode === 0,
        interactive,
        description:
          result.exitCode !== 0
            ? `launchctl could not inspect the Aqua login domain (exit ${String(result.exitCode)}).`
            : interactive
              ? 'An interactive logged-in macOS console session is available.'
              : 'macOS has no interactive logged-in console session.',
      };
    },
  };
}

export async function preflightGraphicalSession(
  platform: ClientRuntimePlatform,
  probe?: GraphicalSessionProbe,
  signal?: AbortSignal,
): Promise<GraphicalSessionReadiness> {
  if (platform.os !== 'osx') {
    return {
      ready: false,
      status: 'setup_required',
      probe: probe?.name ?? 'none',
      message:
        'Authoritative Packwright client capture currently requires an interactive macOS session.',
    };
  }
  if (probe === undefined) {
    return {
      ready: false,
      status: 'setup_required',
      probe: 'none',
      message: 'A macOS graphical-session probe is required before launching Minecraft.',
    };
  }
  if (signal?.aborted) {
    throw new PackwrightError('cancelled', 'Minecraft graphical-session preflight was cancelled.');
  }
  const result = await probe.probe(signal);
  const ready = result.available && result.interactive;
  return {
    ready,
    status: ready ? 'ready' : 'setup_required',
    probe: probe.name,
    message: result.description,
  };
}
