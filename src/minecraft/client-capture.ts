import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl';

import type { RuntimeConfig } from '../config.js';
import { PackwrightError } from '../core/errors.js';
import { sha256Buffer } from '../core/hash.js';
import { MINECRAFT_26_2 } from '../core/version.js';
import { runProcess, type ProcessResult } from '../runtime/process.js';
import { createDeterministicZipArchive } from '../visual/builder.js';
import type { PackSnapshot } from '../visual/pack-snapshot.js';
import {
  canonicalClientCapturePlanBytes,
  verifyClientCaptureOutput,
  type ClientCaptureEvidence,
  type ClientCapturePlan,
} from './client-capture-protocol.js';
import {
  clientCaptureClasspath,
  createClientCaptureRuntimeManifest,
} from './client-capture-runtime.js';
import {
  createDarwinGraphicalSessionProbe,
  currentClientRuntimePlatform,
  planNativeExtraction,
  preflightClientRuntime,
  preflightGraphicalSession,
  type HashedClientRuntimeManifest,
  type NativeExtractionRequirement,
  type NativeZipEntry,
  type VerifiedClientRuntimeArtifact,
} from './client-runtime.js';
import { cachePaths, getCacheStatus } from './cache.js';
import { getJavaVersion } from './java.js';

const CAPTURE_TIMEOUT_MINIMUM = 30_000;
const CAPTURE_TIMEOUT_MAXIMUM = 10 * 60_000;
const MAX_CAPTURE_MOD_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_RESULT_BYTES = 300 * 1024 * 1024;

export interface PreparedMinecraftClientCapture {
  readonly runtime: HashedClientRuntimeManifest;
  readonly verifiedArtifacts: readonly VerifiedClientRuntimeArtifact[];
  readonly client: Readonly<{ jarSha1: string; jarSha256: string }>;
  readonly captureMod: Readonly<{
    id: 'packwright_capture';
    version: string;
    sha256: string;
    data: Buffer;
  }>;
}

export interface MinecraftClientCapturePreflight {
  readonly ready: boolean;
  readonly status: 'ready' | 'setup_required';
  readonly messages: readonly string[];
  readonly prepared?: PreparedMinecraftClientCapture | undefined;
}

export interface ExecuteMinecraftClientCaptureInput {
  readonly config: RuntimeConfig;
  readonly prepared: PreparedMinecraftClientCapture;
  readonly datapack: PackSnapshot;
  readonly resourcepack: PackSnapshot;
  readonly createPlan: (execution: {
    readonly executionId: string;
    readonly gameDirectory: string;
    readonly outputDirectory: string;
  }) => ClientCapturePlan;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  /** Test seam; production always uses the fixed official-client launcher below. */
  readonly launch?: ClientCaptureProcessLauncher | undefined;
}

export interface ClientCaptureProcessLauncherInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

export type ClientCaptureProcessLauncher = (
  input: ClientCaptureProcessLauncherInput,
) => Promise<ProcessResult>;

const CLIENT_CAPTURE_ALLOWED_ENVIRONMENT = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'USER',
  'LOGNAME',
  '__CF_USER_TEXT_ENCODING',
]);

export interface ClientCaptureEnvironmentScope {
  readonly homeDirectory: string;
  readonly temporaryDirectory: string;
}

/**
 * Pass a narrow locale/user allowlist while refusing environment-based JVM,
 * native-loader, renderer, proxy, and mod injection into the authoritative
 * capture client. HOME and TMPDIR point into the disposable execution scope.
 */
export function clientCaptureProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  scope?: ClientCaptureEnvironmentScope,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([name]) => CLIENT_CAPTURE_ALLOWED_ENVIRONMENT.has(name)),
  );
  return {
    ...environment,
    ...(scope === undefined ? {} : { HOME: scope.homeDirectory, TMPDIR: scope.temporaryDirectory }),
  };
}

export interface ExecutedMinecraftClientCapture {
  readonly plan: ClientCapturePlan;
  readonly evidence: ClientCaptureEvidence;
  readonly artifacts: Readonly<Record<string, Buffer>>;
  readonly process: ProcessResult;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new PackwrightError('cancelled', 'Minecraft client capture cancelled.');
}

async function readNoFollow(filename: string, maximum: number): Promise<Buffer> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maximum) {
      throw new PackwrightError('invalid_content', `Capture input is invalid: ${filename}`);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const pathInfo = await lstat(filename);
    if (
      offset !== bytes.length ||
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathInfo.dev ||
      after.ino !== pathInfo.ino ||
      after.size !== pathInfo.size ||
      after.mtimeMs !== pathInfo.mtimeMs ||
      after.ctimeMs !== pathInfo.ctimeMs
    ) {
      throw new PackwrightError('precondition_failed', `Capture input changed: ${filename}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readBundledCaptureMod(
  packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
): Promise<PreparedMinecraftClientCapture['captureMod']> {
  const profile = MINECRAFT_26_2.clientCapture.captureMod;
  const root = path.resolve(packageRoot);
  const filename = path.resolve(root, ...profile.runtimePath.split('/'));
  if (!filename.startsWith(`${root}${path.sep}`)) {
    throw new PackwrightError(
      'unsafe_path',
      'The pinned Packwright capture-mod path escaped the installed package.',
    );
  }
  let data: Buffer;
  try {
    data = await readNoFollow(filename, MAX_CAPTURE_MOD_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PackwrightError(
        'not_found',
        `The pinned Packwright capture-mod JAR is not installed at ${profile.runtimePath}. Reinstall the package before client capture.`,
      );
    }
    throw error;
  }
  const actualSha256 = sha256Buffer(data);
  if (data.length !== profile.size || actualSha256 !== profile.sha256) {
    throw new PackwrightError(
      'precondition_failed',
      'The installed Packwright capture-mod JAR does not match the pinned 26.2 runtime identity.',
      {
        path: profile.runtimePath,
        expectedSha256: profile.sha256,
        actualSha256,
        expectedSize: profile.size,
        actualSize: data.length,
      },
    );
  }
  return {
    id: profile.id,
    version: profile.version,
    sha256: profile.sha256,
    data,
  };
}

function runGraphicalProbe(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return runProcess({
    command,
    args,
    timeoutMs: 5_000,
    ...(signal === undefined ? {} : { signal }),
  }).then((result) => ({
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  }));
}

export async function preflightMinecraftClientCapture(
  config: RuntimeConfig,
  signal?: AbortSignal,
): Promise<MinecraftClientCapturePreflight> {
  const messages: string[] = [];
  const cache = await getCacheStatus(config.cacheDir, true);
  if (!cache.acceptedEula)
    messages.push('Run setup-version with explicit Minecraft EULA acceptance.');
  if (cache.clientAssets?.ready !== true) {
    messages.push('The verified 26.2 client JAR and asset index are not prepared.');
  }
  const java = await getJavaVersion(config.javaCommand, signal);
  if (!java.available || java.major !== MINECRAFT_26_2.clientCapture.javaMajor) {
    messages.push(`Java 25 is required for client capture; ${java.description}.`);
  }
  const platform = currentClientRuntimePlatform();
  const graphical = await preflightGraphicalSession(
    platform,
    createDarwinGraphicalSessionProbe(runGraphicalProbe),
    signal,
  ).catch((error: unknown) => ({
    ready: false as const,
    status: 'setup_required' as const,
    probe: 'darwin-launchctl-aqua',
    message: `Graphical-session probe failed: ${error instanceof Error ? error.message : String(error)}`,
  }));
  if (!graphical.ready) messages.push(graphical.message);
  if (messages.length > 0) return { ready: false, status: 'setup_required', messages };

  let runtime: HashedClientRuntimeManifest;
  try {
    const paths = cachePaths(config.cacheDir);
    const [metadata, assetIndex] = await Promise.all([
      readNoFollow(paths.versionMetadata, 16 * 1024 * 1024),
      readNoFollow(paths.assetIndex, 32 * 1024 * 1024),
    ]);
    runtime = createClientCaptureRuntimeManifest(metadata, assetIndex, platform);
  } catch (error) {
    return {
      ready: false,
      status: 'setup_required',
      messages: [
        `Client runtime metadata is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const runtimePreflight = await preflightClientRuntime(config.cacheDir, runtime, signal);
  if (!runtimePreflight.ready) {
    return {
      ready: false,
      status: 'setup_required',
      messages: [
        `The client capture runtime is incomplete (${String(runtimePreflight.issues.length)} missing or invalid artifacts). Run setup-version 26.2 --client-capture.`,
        ...runtimePreflight.issues
          .slice(0, 8)
          .map((issue) => `${issue.cachePath}: ${issue.message}`),
      ],
    };
  }
  const expectedFabricHashes = new Map(
    MINECRAFT_26_2.clientCapture.loader.libraries.map((library) => [library.sha1, library.sha256]),
  );
  for (const verified of runtimePreflight.verified) {
    const expected = expectedFabricHashes.get(verified.sha1);
    if (expected !== undefined && expected !== verified.sha256) {
      return {
        ready: false,
        status: 'setup_required',
        messages: [`Pinned Fabric library failed SHA-256 verification: ${verified.cachePath}`],
      };
    }
  }
  let captureMod: PreparedMinecraftClientCapture['captureMod'];
  try {
    captureMod = await readBundledCaptureMod();
  } catch (error) {
    return {
      ready: false,
      status: 'setup_required',
      messages: [error instanceof Error ? error.message : String(error)],
    };
  }
  const clientArtifact = runtime.manifest.artifacts.find((artifact) => artifact.kind === 'client');
  const verifiedClient = runtimePreflight.verified.find(
    (artifact) => artifact.cachePath === clientArtifact?.cachePath,
  );
  if (clientArtifact === undefined || verifiedClient === undefined) {
    return {
      ready: false,
      status: 'setup_required',
      messages: ['The verified client JAR identity is unavailable.'],
    };
  }
  return {
    ready: true,
    status: 'ready',
    messages: ['Minecraft 26.2 client capture runtime is ready.'],
    prepared: {
      runtime,
      verifiedArtifacts: runtimePreflight.verified,
      client: { jarSha1: clientArtifact.sha1, jarSha256: verifiedClient.sha256 },
      captureMod,
    },
  };
}

function unixMode(entry: yauzl.Entry): number | undefined {
  const mode = entry.externalFileAttributes >>> 16;
  return mode === 0 ? undefined : mode;
}

async function listNativeEntries(filename: string): Promise<readonly NativeZipEntry[]> {
  const zip = await yauzl.openPromise(filename, { lazyEntries: true, autoClose: false });
  const entries: NativeZipEntry[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      const mode = unixMode(entry);
      entries.push({
        name: entry.fileName,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        directory: entry.fileName.endsWith('/'),
        ...(mode === undefined ? {} : { unixMode: mode }),
      });
    }
    return entries;
  } finally {
    zip.close();
  }
}

async function extractNativeRequirement(
  cacheDir: string,
  gameDirectory: string,
  requirement: NativeExtractionRequirement,
  index: number,
  signal?: AbortSignal,
): Promise<string> {
  const source = path.join(cacheDir, ...requirement.artifactCachePath.split('/'));
  const extractionRoot = `natives/${String(index)}`;
  const plan = planNativeExtraction(requirement, await listNativeEntries(source), extractionRoot);
  const selected = new Map(plan.entries.map((entry) => [entry.sourceEntry, entry]));
  const zip = await yauzl.openPromise(source, { lazyEntries: true, autoClose: false });
  try {
    for await (const entry of zip.eachEntry()) {
      abortIfNeeded(signal);
      const destination = selected.get(entry.fileName);
      if (destination === undefined) continue;
      const filename = path.join(gameDirectory, ...destination.destinationPath.split('/'));
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await pipeline(
        await zip.openReadStreamPromise(entry),
        createWriteStream(filename, { flags: 'wx', mode: 0o600 }),
      );
      const info = await stat(filename);
      if (!info.isFile() || info.size !== destination.size) {
        throw new Error(`Native extraction size mismatch: ${destination.sourceEntry}`);
      }
      selected.delete(entry.fileName);
    }
  } finally {
    zip.close();
  }
  if (selected.size > 0) throw new Error('Native extraction omitted planned entries.');
  return path.join(gameDirectory, ...extractionRoot.split('/'));
}

async function stageCaptureFiles(
  gameDirectory: string,
  outputDirectory: string,
  prepared: PreparedMinecraftClientCapture,
  datapack: PackSnapshot,
  resourcepack: PackSnapshot,
  plan: ClientCapturePlan,
): Promise<void> {
  const [dataArchive, resourceArchive] = await Promise.all([
    createDeterministicZipArchive(datapack.entries),
    createDeterministicZipArchive(resourcepack.entries),
  ]);
  if (dataArchive.sha256 !== plan.provenance.datapackContentSha256) {
    throw new PackwrightError(
      'precondition_failed',
      'Datapack capture hash changed after planning.',
    );
  }
  if (resourceArchive.sha256 !== plan.provenance.resourcepackContentSha256) {
    throw new PackwrightError(
      'precondition_failed',
      'Resource-pack capture hash changed after planning.',
    );
  }
  const files = [
    {
      path: path.join(gameDirectory, 'resourcepacks', 'packwright-proposal.zip'),
      data: resourceArchive.data,
    },
    {
      path: path.join(
        gameDirectory,
        'saves',
        'packwright-capture',
        'datapacks',
        'packwright-proposal.zip',
      ),
      data: dataArchive.data,
    },
    {
      path: path.join(gameDirectory, 'mods', 'packwright-capture.jar'),
      data: prepared.captureMod.data,
    },
    {
      path: path.join(gameDirectory, 'packwright', 'input', 'capture-plan.json'),
      data: canonicalClientCapturePlanBytes(plan),
    },
    {
      path: path.join(gameDirectory, 'options.txt'),
      data: Buffer.from(
        [
          'fullscreen:false',
          'graphicsMode:0',
          'graphicsApi:opengl',
          'renderDistance:2',
          'simulationDistance:5',
          `guiScale:${String(plan.scenes[0]?.guiScale ?? 2)}`,
          'enableVsync:false',
          'pauseOnLostFocus:false',
          '',
        ].join('\n'),
        'utf8',
      ),
    },
  ];
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    await mkdir(path.dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.data, { flag: 'wx', mode: 0o600 });
  }
}

function launchArguments(
  input: ExecuteMinecraftClientCaptureInput,
  gameDirectory: string,
  outputDirectory: string,
  nativeDirectories: readonly string[],
  plan: ClientCapturePlan,
): readonly string[] {
  const runtime = input.prepared.runtime;
  const logging = runtime.manifest.artifacts.find((artifact) => artifact.kind === 'logging');
  if (logging === undefined) throw new Error('Client runtime has no logging configuration.');
  const nativeRoot = nativeDirectories[0];
  if (nativeRoot === undefined) throw new Error('Client runtime has no confined native root.');
  const natives = [path.join(nativeRoot, 'java'), ...nativeDirectories.slice(1)].join(
    path.delimiter,
  );
  const first = plan.scenes[0];
  if (first === undefined) throw new Error('Client capture plan has no scenes.');
  return [
    ...(process.platform === 'darwin' ? ['-XstartOnFirstThread'] : []),
    '--sun-misc-unsafe-memory-access=allow',
    '--enable-native-access=ALL-UNNAMED',
    '-Xms512M',
    '-Xmx2G',
    `-Duser.home=${gameDirectory}`,
    '-Duser.language=en',
    '-Duser.country=US',
    '-Duser.timezone=UTC',
    '-Dfile.encoding=UTF-8',
    `-Djava.io.tmpdir=${path.join(nativeRoot, 'tmp')}`,
    `-Djava.library.path=${natives}`,
    `-Djna.tmpdir=${path.join(nativeRoot, 'jna')}`,
    `-Dorg.lwjgl.system.SharedLibraryExtractPath=${path.join(nativeRoot, 'lwjgl')}`,
    `-Dio.netty.native.workdir=${path.join(nativeRoot, 'netty')}`,
    `-Dlog4j.configurationFile=${path.join(input.config.cacheDir, ...logging.cachePath.split('/'))}`,
    '-Dminecraft.launcher.brand=packwright',
    '-Dminecraft.launcher.version=0.4.0',
    '-Dfabric.side=client',
    `-Dfabric.gameVersion=${runtime.manifest.minecraftVersion}`,
    `-Dfabric.modsFolder=${path.join(gameDirectory, 'mods')}`,
    `-Dpackwright.capture.plan=${path.join(gameDirectory, 'packwright', 'input', 'capture-plan.json')}`,
    `-Dpackwright.capture.output=${outputDirectory}`,
    `-Dpackwright.capture.execution=${plan.execution.executionId}`,
    '-DFabricMcEmu= net.minecraft.client.main.Main ',
    '-cp',
    clientCaptureClasspath(input.config.cacheDir, runtime).join(path.delimiter),
    MINECRAFT_26_2.clientCapture.loader.mainClass,
    '--username',
    'Packwright',
    '--version',
    '26.2',
    '--gameDir',
    gameDirectory,
    '--assetsDir',
    path.join(input.config.cacheDir, 'assets'),
    '--assetIndex',
    runtime.manifest.assetIndexId,
    '--uuid',
    'f84c6a790a3f3f0db55f7822976eef26',
    '--accessToken',
    'packwright-offline',
    '--clientId',
    'packwright',
    '--xuid',
    '0',
    '--versionType',
    'release',
    '--offlineDeveloperMode',
    '--disableMultiplayer',
    '--disableChat',
    '--width',
    String(first.resolution.width),
    '--height',
    String(first.resolution.height),
  ];
}

async function collectEvidenceArtifacts(
  outputDirectory: string,
  evidence: ClientCaptureEvidence,
): Promise<Readonly<Record<string, Buffer>>> {
  const paths = [
    ...evidence.views.map((view) => view.path),
    evidence.log.path,
    evidence.completion.path,
    evidence.reportArtifact.path,
  ];
  const artifacts: Record<string, Buffer> = {};
  let totalBytes = 0;
  const root = await realpath(outputDirectory);
  for (const relative of paths) {
    const filename = path.join(outputDirectory, ...relative.split('/'));
    const canonical = await realpath(filename);
    if (!canonical.startsWith(`${root}${path.sep}`)) {
      throw new PackwrightError('unsafe_path', 'Capture result escaped its output directory.');
    }
    const data = await readNoFollow(filename, MAX_CAPTURE_RESULT_BYTES);
    totalBytes += data.length;
    if (totalBytes > MAX_CAPTURE_RESULT_BYTES) {
      throw new PackwrightError('size_limit', 'Client capture result exceeds its byte budget.');
    }
    artifacts[relative] = data;
  }
  return artifacts;
}

async function verifyRuntimeStayedPinned(input: ExecuteMinecraftClientCaptureInput): Promise<void> {
  const after = await preflightClientRuntime(
    input.config.cacheDir,
    input.prepared.runtime,
    input.signal,
  );
  if (!after.ready) {
    throw new PackwrightError(
      'precondition_failed',
      'Minecraft client runtime changed while the authoritative capture was running.',
      { issues: after.issues.slice(0, 32) },
    );
  }
  const expected = new Map(
    input.prepared.verifiedArtifacts.map((artifact) => [artifact.cachePath, artifact] as const),
  );
  if (after.verified.length !== expected.size) {
    throw new PackwrightError(
      'precondition_failed',
      'Minecraft client runtime identity changed during authoritative capture.',
    );
  }
  for (const artifact of after.verified) {
    const before = expected.get(artifact.cachePath);
    const changed =
      before === undefined
        ? true
        : before.sha1 !== artifact.sha1 ||
          before.sha256 !== artifact.sha256 ||
          before.size !== artifact.size;
    if (changed) {
      throw new PackwrightError(
        'precondition_failed',
        `Minecraft client runtime artifact changed during capture: ${artifact.cachePath}`,
      );
    }
  }
}

export async function executeMinecraftClientCapture(
  input: ExecuteMinecraftClientCaptureInput,
): Promise<ExecutedMinecraftClientCapture> {
  if (
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < CAPTURE_TIMEOUT_MINIMUM ||
    input.timeoutMs > CAPTURE_TIMEOUT_MAXIMUM
  ) {
    throw new PackwrightError(
      'invalid_argument',
      `Client capture timeout must be ${String(CAPTURE_TIMEOUT_MINIMUM)}-${String(CAPTURE_TIMEOUT_MAXIMUM)} ms.`,
    );
  }
  abortIfNeeded(input.signal);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'packwright-client-capture-'));
  try {
    await chmod(temporaryRoot, 0o700);
    const gameDirectory = path.join(temporaryRoot, 'game');
    const outputDirectory = path.join(gameDirectory, 'packwright', 'output');
    const executionId = randomUUID();
    const plan = input.createPlan({ executionId, gameDirectory, outputDirectory });
    if (
      plan.execution.executionId !== executionId ||
      plan.execution.gameDirectory !== gameDirectory ||
      plan.execution.outputDirectory !== outputDirectory
    ) {
      throw new PackwrightError(
        'invalid_content',
        'Client capture plan changed its execution scope.',
      );
    }
    await mkdir(gameDirectory, { mode: 0o700 });
    const runtimeNativeDirectory = path.join(gameDirectory, 'natives', 'runtime');
    await Promise.all(
      ['java', 'jna', 'lwjgl', 'netty', 'tmp'].map((directory) =>
        mkdir(path.join(runtimeNativeDirectory, directory), { recursive: true, mode: 0o700 }),
      ),
    );
    const nativeDirectories: string[] = [runtimeNativeDirectory];
    for (const [
      index,
      requirement,
    ] of input.prepared.runtime.manifest.nativeExtractions.entries()) {
      nativeDirectories.push(
        await extractNativeRequirement(
          input.config.cacheDir,
          gameDirectory,
          requirement,
          index,
          input.signal,
        ),
      );
    }
    await stageCaptureFiles(
      gameDirectory,
      outputDirectory,
      input.prepared,
      input.datapack,
      input.resourcepack,
      plan,
    );
    const processInput: ClientCaptureProcessLauncherInput = {
      command: input.config.javaCommand,
      args: launchArguments(input, gameDirectory, outputDirectory, nativeDirectories, plan),
      cwd: gameDirectory,
      env: clientCaptureProcessEnvironment(process.env, {
        homeDirectory: gameDirectory,
        temporaryDirectory: path.join(runtimeNativeDirectory, 'tmp'),
      }),
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    const processResult = await (
      input.launch ??
      ((launch) =>
        runProcess({
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: launch.env,
          timeoutMs: launch.timeoutMs,
          ...(launch.signal === undefined ? {} : { signal: launch.signal }),
        }))
    )(processInput);
    if (processResult.cancelled)
      throw new PackwrightError('cancelled', 'Minecraft client capture cancelled.');
    if (processResult.timedOut) {
      const stderr = processResult.stderr.trim().slice(-8_192);
      throw new PackwrightError(
        'validation_failed',
        `Minecraft client capture timed out.${stderr.length === 0 ? '' : `\nMinecraft stderr tail:\n${stderr}`}`,
        { status: 'timeout' },
      );
    }
    if (processResult.exitCode !== 0) {
      throw new PackwrightError(
        'validation_failed',
        `Minecraft client capture exited with code ${String(processResult.exitCode)}.`,
        { stderr: processResult.stderr.slice(-16_384) },
      );
    }
    // The production launcher consumes shared, verified cache paths. Re-hash
    // them after the client exits so concurrent cache repair or replacement
    // cannot be accepted under the pre-launch provenance identity. Injected
    // launchers are an explicit test seam and never carry capture authority.
    if (input.launch === undefined) await verifyRuntimeStayedPinned(input);
    const evidence = await verifyClientCaptureOutput({
      plan,
      outputDirectory,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (evidence.report.runtime.rendererBackend !== MINECRAFT_26_2.clientCapture.graphicsBackend) {
      throw new PackwrightError(
        'validation_failed',
        `Minecraft used ${evidence.report.runtime.rendererBackend}; Packwright 26.2 capture requires ${MINECRAFT_26_2.clientCapture.graphicsBackend}.`,
      );
    }
    const artifacts = await collectEvidenceArtifacts(outputDirectory, evidence);
    return { plan, evidence, artifacts, process: processResult };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
