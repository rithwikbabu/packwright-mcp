import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeConfig } from '../../src/config.js';
import { sha256Buffer } from '../../src/core/hash.js';
import {
  clientCaptureProcessEnvironment,
  executeMinecraftClientCapture,
  readBundledCaptureMod,
  type ClientCaptureProcessLauncher,
  type PreparedMinecraftClientCapture,
} from '../../src/minecraft/client-capture.js';
import {
  CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH,
  CLIENT_CAPTURE_MIN_SETTLE_FRAMES,
  CLIENT_CAPTURE_PACK_ACTIVATION,
  CLIENT_CAPTURE_RESOURCEPACK_ID,
  CLIENT_CAPTURE_RESOURCEPACK_PATH,
  clientCaptureIdentityForPlan,
  computeClientCaptureAppliedFixtureSha256,
  computeClientCaptureObservedFixtureSha256,
  computeClientCaptureRepresentationSha256,
  computeClientCaptureSceneSha256,
  computeClientCaptureStudioScaleReferenceSha256,
  computeClientCaptureStudioSha256,
  createClientCapturePlan,
  expectedClientCaptureObservedFixture,
  parseClientCapturePlanBytes,
  type ClientCaptureCompleteReport,
  type ClientCapturePlan,
  type ClientCaptureRepresentation,
  type ClientCaptureScene,
  type ClientCaptureStudio,
} from '../../src/minecraft/client-capture-protocol.js';
import type { HashedClientRuntimeManifest } from '../../src/minecraft/client-runtime.js';
import { createDeterministicZipArchive } from '../../src/visual/builder.js';
import type { PackSnapshot } from '../../src/visual/pack-snapshot.js';
import { encodePng } from '../../src/visual/png.js';
import { canonicalJsonBytes } from '../../src/visual/run-store.js';

const SHA1 = '1'.repeat(40);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function processResult(
  overrides: {
    readonly exitCode?: number;
    readonly timedOut?: boolean;
    readonly cancelled?: boolean;
    readonly stderr?: string;
  } = {},
) {
  return {
    ...(overrides.exitCode === undefined ? {} : { exitCode: overrides.exitCode }),
    stdout: '',
    stderr: overrides.stderr ?? '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: overrides.timedOut ?? false,
    cancelled: overrides.cancelled ?? false,
    durationMs: 1,
  };
}

function snapshot(root: string, entries: readonly { path: string; data: Buffer }[]): PackSnapshot {
  return {
    root,
    entries: entries.map((entry) => ({
      ...entry,
      sha256: sha256Buffer(entry.data),
      size: entry.data.length,
    })),
    treeSha256: sha256Buffer(root),
    totalBytes: entries.reduce((total, entry) => total + entry.data.length, 0),
  };
}

function runtime(): HashedClientRuntimeManifest {
  return {
    manifest: {
      schemaVersion: 1,
      minecraftVersion: '26.2',
      javaMajor: 25,
      platform: {
        os: 'osx',
        architecture: 'arm64',
        ruleArchitecture: 'aarch64',
        osVersion: 'test',
        bits: 64,
      },
      mainClass: 'net.minecraft.client.main.Main',
      assetIndexId: '32',
      versionMetadataSha1: '2'.repeat(40),
      assetIndexSha1: '3'.repeat(40),
      artifacts: [
        {
          id: 'client',
          kind: 'client',
          cachePath: 'versions/26.2/26.2.jar',
          sha1: SHA1,
          size: 1,
          url: 'https://piston-data.mojang.com/client.jar',
        },
        {
          id: 'library',
          kind: 'library',
          cachePath: 'libraries/example/library.jar',
          sha1: '4'.repeat(40),
          size: 1,
          url: 'https://libraries.minecraft.net/example/library.jar',
        },
        {
          id: 'logging',
          kind: 'logging',
          cachePath: 'assets/log_configs/client.xml',
          sha1: '5'.repeat(40),
          size: 1,
          url: 'https://launcher.mojang.com/client.xml',
        },
      ],
      nativeExtractions: [],
    },
    sha256: HASH_A,
  };
}

function solidPng(width: number, height: number): Buffer {
  return encodePng({
    width,
    height,
    data: new Uint8Array(width * height * 4).fill(0x7f),
  });
}

async function writeCompleteOutput(plan: ClientCapturePlan): Promise<void> {
  const output = plan.execution.outputDirectory;
  await mkdir(path.join(output, 'views'), { recursive: true });
  await mkdir(path.join(output, 'logs'), { recursive: true });
  const views = [];
  for (const scene of plan.scenes) {
    const png = solidPng(scene.resolution.width, scene.resolution.height);
    const artifactPath = `views/${scene.id}.png`;
    await writeFile(path.join(output, ...artifactPath.split('/')), png);
    const observedFixture = expectedClientCaptureObservedFixture(
      plan.provenance.representation,
      scene,
    );
    views.push({
      sceneId: scene.id,
      sceneSha256: computeClientCaptureSceneSha256(scene),
      scene,
      path: artifactPath,
      pngSha256: sha256Buffer(png),
      bytes: png.length,
      width: scene.resolution.width,
      height: scene.resolution.height,
      representationSha256: plan.provenance.representationSha256,
      studioSha256: computeClientCaptureStudioSha256(plan.studio),
      actualScaleReference: plan.studio.scaleReference,
      actualScaleReferenceSha256: computeClientCaptureStudioScaleReferenceSha256(
        plan.studio.scaleReference,
      ),
      fixtureSha256: sha256Buffer(canonicalJsonBytes(scene.fixture)),
      appliedFixtureSha256: computeClientCaptureAppliedFixtureSha256(
        plan.provenance.representation,
        scene,
      ),
      observedFixture,
      observedFixtureSha256: computeClientCaptureObservedFixtureSha256(observedFixture),
      actualSettledTicks: scene.settlingTicks,
      renderedSettleFrames: CLIENT_CAPTURE_MIN_SETTLE_FRAMES,
      actualAnimationTick: scene.frame,
      actualCameraPose: scene.expectedRenderCameraPose,
      actualCameraMode: 'first_person' as const,
      actualContext: scene.context,
      actualFov: scene.fov,
      actualGuiScale: scene.guiScale,
      actualHand: scene.hand,
      actualPlayerModel: scene.playerModel,
      actualEnvironment: scene.environment,
      resourceReloadReady: true as const,
      modelBakeReady: true as const,
      fixtureEvidence: {
        strategy: scene.fixture.kind,
        stateId: scene.fixture.stateId,
        equippedItemId: 'minecraft:stick',
        equipReady: true as const,
      },
    });
  }
  const log = Buffer.from(
    '[Render thread/INFO]: Resource reload succeeded\n[Render thread/INFO]: Capture complete\n',
  );
  await writeFile(path.join(output, 'logs/client.log'), log);
  const report: ClientCaptureCompleteReport = {
    schemaVersion: 3,
    kind: 'packwright.client-capture-report',
    status: 'complete',
    executionId: plan.execution.executionId,
    planSha256: plan.planSha256,
    identity: clientCaptureIdentityForPlan(plan),
    packActivation: {
      datapack: {
        mode: CLIENT_CAPTURE_PACK_ACTIVATION.datapack,
        archivePath: CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH,
        archiveSha256: plan.provenance.datapackContentSha256,
        selected: false,
        selectedPackIds: ['vanilla'],
      },
      resourcepack: {
        mode: CLIENT_CAPTURE_PACK_ACTIVATION.resourcepack,
        archivePath: CLIENT_CAPTURE_RESOURCEPACK_PATH,
        archiveSha256: plan.provenance.resourcepackContentSha256,
        selected: true,
        selectedPackIds: [CLIENT_CAPTURE_RESOURCEPACK_ID],
      },
    },
    runtime: (() => {
      const settings = {
        preferredGraphicsBackend: 'opengl' as const,
        graphicsMode: plan.studio.graphicsMode,
        clouds: plan.studio.clouds,
        particles: plan.studio.particles,
        entityShadows: plan.studio.entityShadows,
        viewBobbing: plan.studio.viewBobbing,
        renderDistance: plan.studio.renderDistance,
        simulationDistance: plan.studio.simulationDistance,
        debugUi: plan.studio.debugUi,
      };
      return {
        rendererBackend: 'opengl',
        operatingSystem: 'capture test',
        javaVersion: '25.0.1',
        gpuVendor: 'Packwright Test Vendor',
        gpuRenderer: 'Packwright Test Renderer',
        driverVersion: 'Packwright Test Driver 1.0',
        studioSha256: computeClientCaptureStudioSha256(plan.studio),
        settings,
        settingsSha256: sha256Buffer(canonicalJsonBytes(settings)),
        resourceReloadReadyTick: 2,
        modelBakeReadyTick: 2,
      };
    })(),
    views,
    measurements: [],
    log: {
      path: 'logs/client.log',
      sha256: sha256Buffer(log),
      bytes: log.length,
      resourceReloadSucceeded: true,
      modelBakeSucceeded: true,
      excerpts: ['Resource reload succeeded', 'Capture complete'],
    },
  };
  const reportBytes = canonicalJsonBytes(report);
  await writeFile(path.join(output, 'capture-report.json'), reportBytes);
  await writeFile(
    path.join(output, 'capture-complete.json'),
    canonicalJsonBytes({
      schemaVersion: 3,
      kind: 'packwright.client-capture-complete',
      executionId: plan.execution.executionId,
      planSha256: plan.planSha256,
      report: {
        path: 'capture-report.json',
        sha256: sha256Buffer(reportBytes),
        bytes: reportBytes.length,
      },
    }),
  );
}

async function captureFixture(includeScaleReference = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'packwright-client-capture-test-'));
  cleanups.push(root);
  const config: RuntimeConfig = {
    workspaceRoot: path.join(root, 'workspace'),
    cacheDir: path.join(root, 'cache'),
    javaCommand: '/fixture/java-25',
    readOnly: false,
    offline: true,
  };
  const datapack = snapshot('firestaff-data', [
    {
      path: 'pack.mcmeta',
      data: Buffer.from('{"pack":{"description":"Data","pack_format":107}}\n'),
    },
    { path: 'data/arcana/function/load.mcfunction', data: Buffer.from('say ready\n') },
  ]);
  const resourcepack = snapshot('firestaff-assets', [
    {
      path: 'pack.mcmeta',
      data: Buffer.from('{"pack":{"description":"Assets","pack_format":88}}\n'),
    },
    {
      path: 'assets/arcana/models/item/firestaff.json',
      data: Buffer.from('{"parent":"minecraft:item/handheld"}\n'),
    },
  ]);
  const [datapackArchive, resourcepackArchive] = await Promise.all([
    createDeterministicZipArchive(datapack.entries),
    createDeterministicZipArchive(resourcepack.entries),
  ]);
  const captureModData = Buffer.from('fixture capture mod');
  const prepared: PreparedMinecraftClientCapture = {
    runtime: runtime(),
    verifiedArtifacts: [],
    client: { jarSha1: SHA1, jarSha256: HASH_B },
    captureMod: {
      id: 'packwright_capture',
      version: '0.5.0',
      sha256: sha256Buffer(captureModData),
      data: captureModData,
    },
  };
  const representation: ClientCaptureRepresentation = {
    targetKind: 'held_item',
    strategy: 'item_stack',
    capability: 'native',
    states: {
      default: {
        itemStack: {
          itemId: 'minecraft:stick',
          count: 1,
          components: { 'minecraft:item_model': '"arcana:firestaff"' },
        },
      },
    },
  };
  const representationSha256 = computeClientCaptureRepresentationSha256(representation);
  const studio: ClientCaptureStudio = {
    preset: 'void_matte',
    rendererBackend: 'opengl',
    renderDistance: 8,
    simulationDistance: 5,
    graphicsMode: 'custom',
    clouds: 'off',
    particles: 'minimal',
    entityShadows: true,
    viewBobbing: false,
    debugUi: false,
    floorBlock: { id: 'minecraft:smooth_stone', properties: {} },
    backdropBlock: { id: 'minecraft:light_gray_concrete', properties: {} },
    scaleReference: {
      kind: 'ordinary_block_floor_ruler',
      origin: { x: -2, y: 79, z: 7 },
      lengthBlocks: 2,
      firstBlock: { id: 'minecraft:black_concrete', properties: {} },
      secondBlock: { id: 'minecraft:white_concrete', properties: {} },
    },
  };
  const scene = (
    viewKind: 'first_person_vanilla' | 'first_person_scale_reference',
  ): ClientCaptureScene => ({
    id: `${viewKind}--fp_right_steve`,
    baseSceneId: 'fp_right_steve',
    targetKind: 'held_item',
    representationSha256,
    viewKind,
    requiredForAuthority: viewKind === 'first_person_vanilla',
    camera: 'first_person',
    context: 'world',
    hand: 'right',
    playerModel: 'steve',
    fov: 70,
    resolution: { width: 64, height: 64 },
    guiScale: 2,
    animationState: 'idle',
    frame: 0,
    cameraPoseSemantics: 'player_feet_anchor',
    cameraPose: { x: 0.5, y: 82.25, z: 0.5, yaw: 0, pitch: 14 },
    expectedRenderCameraPose: { x: 0.5, y: 83.87, z: 0.5, yaw: 0, pitch: 14 },
    environment: {
      biome: 'minecraft:plains',
      time: 6000,
      weather: 'clear',
      lightProfile: 'day',
      skyLight: 15,
      blockLight: 0,
      lightSource: { level: 0, offset: { x: 0, y: 5, z: -2 } },
    },
    settlingTicks: 0,
    fixture: { kind: 'item_stack', stateId: 'default' },
    measurementIntents: [],
    comparisonSceneIds: [],
    ...(viewKind === 'first_person_scale_reference'
      ? { presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' as const } }
      : {}),
  });
  const createPlan = ({
    executionId,
    gameDirectory,
    outputDirectory,
  }: {
    readonly executionId: string;
    readonly gameDirectory: string;
    readonly outputDirectory: string;
  }) =>
    createClientCapturePlan({
      schemaVersion: 3,
      kind: 'packwright.client-capture-plan',
      minecraftVersion: '26.2',
      provenance: {
        projectId: 'firestaff',
        runId: HASH_A,
        revisionId: HASH_B,
        specSha256: HASH_C,
        compiledArtifactId: HASH_D,
        proposalArtifactId: HASH_E,
        projectManifestSha256: 'f'.repeat(64),
        datapackContentSha256: datapackArchive.sha256,
        resourcepackContentSha256: resourcepackArchive.sha256,
        packActivation: CLIENT_CAPTURE_PACK_ACTIVATION,
        runtimeManifestSha256: prepared.runtime.sha256,
        representation,
        representationSha256,
        client: prepared.client,
        captureMod: {
          id: prepared.captureMod.id,
          version: prepared.captureMod.version,
          sha256: prepared.captureMod.sha256,
        },
      },
      studio,
      scenes: [
        ...(includeScaleReference ? [scene('first_person_scale_reference')] : []),
        scene('first_person_vanilla'),
      ],
      execution: { executionId, gameDirectory, outputDirectory },
    });
  return { config, datapack, resourcepack, prepared, createPlan };
}

function argumentAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe('official Minecraft client capture orchestration', () => {
  it('loads only the exact package-relative capture mod and enforces its pinned digest', async () => {
    const bundled = await readBundledCaptureMod();
    expect(bundled).toMatchObject({
      id: 'packwright_capture',
      version: '0.5.0',
      sha256: '03b61c9a6d532fe93065bbefec8ee8134d96b103e22d8a1035651f2a85ad5a16',
    });
    expect(bundled.data).toHaveLength(263_533);

    const packageRoot = await mkdtemp(path.join(tmpdir(), 'packwright-capture-package-test-'));
    cleanups.push(packageRoot);
    const buildDirectory = path.join(packageRoot, 'capture-mod/build/libs');
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(path.join(buildDirectory, 'packwright-capture-mod-0.5.0.jar'), bundled.data);
    await expect(readBundledCaptureMod(packageRoot)).rejects.toMatchObject({ code: 'not_found' });

    const runtimeDirectory = path.join(packageRoot, 'capture-mod/runtime');
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(
      path.join(runtimeDirectory, 'packwright-capture-mod-0.5.0.jar'),
      Buffer.from('substituted capture mod'),
    );
    await expect(readBundledCaptureMod(packageRoot)).rejects.toMatchObject({
      code: 'precondition_failed',
      details: {
        expectedSha256: '03b61c9a6d532fe93065bbefec8ee8134d96b103e22d8a1035651f2a85ad5a16',
      },
    });
  });

  it('removes JVM and dynamic-library injection variables from the client environment', () => {
    expect(
      clientCaptureProcessEnvironment({
        PATH: '/fixture/bin',
        JAVA_TOOL_OPTIONS: '-javaagent:/tmp/agent.jar',
        jdk_java_options: '-Xbootclasspath/a:/tmp/classes',
        _JAVA_OPTIONS: '-Dfabric.modsFolder=/tmp/other-mods',
        DYLD_INSERT_LIBRARIES: '/tmp/injected.dylib',
        LD_PRELOAD: '/tmp/injected.so',
        HTTPS_PROXY: 'https://proxy.example',
        FABRIC_GAME_DIR: '/tmp/other-game',
      }),
    ).toEqual({ PATH: '/fixture/bin' });
  });

  it('stages only confined proposal inputs, launches with fixed safe flags, and collects evidence', async () => {
    const fixture = await captureFixture();
    let disposableGameDirectory: string | undefined;
    const launch: ClientCaptureProcessLauncher = async (input) => {
      disposableGameDirectory = input.cwd;
      expect(input.command).toBe('/fixture/java-25');
      expect(input.timeoutMs).toBe(45_000);
      expect(input.env.JAVA_TOOL_OPTIONS).toBeUndefined();
      expect(input.env.JDK_JAVA_OPTIONS).toBeUndefined();
      expect(input.env._JAVA_OPTIONS).toBeUndefined();
      expect(input.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
      expect(input.env.HTTPS_PROXY).toBeUndefined();
      expect(input.env.FABRIC_GAME_DIR).toBeUndefined();
      expect(input.env.HOME).toBe(input.cwd);
      expect(input.env.TMPDIR).toMatch(/\/natives\/runtime\/tmp$/u);
      expect(input.args).toContain(`-Duser.home=${input.cwd}`);
      expect(input.args).toContain('-Duser.timezone=UTC');
      expect(argumentAfter(input.args, '--gameDir')).toBe(input.cwd);
      expect(argumentAfter(input.args, '--assetsDir')).toBe(
        path.join(fixture.config.cacheDir, 'assets'),
      );
      expect(argumentAfter(input.args, '--assetIndex')).toBe('32');
      expect(input.args).toContain('--offlineDeveloperMode');
      expect(input.args).toContain('--disableMultiplayer');
      expect(input.args).toContain('--disableChat');
      expect(input.args).toContain('-Dfabric.side=client');
      if (process.platform === 'darwin') expect(input.args[0]).toBe('-XstartOnFirstThread');

      const plan = parseClientCapturePlanBytes(
        await readFile(path.join(input.cwd, 'packwright/input/capture-plan.json')),
      );
      const options = await readFile(path.join(input.cwd, 'options.txt'), 'utf8');
      expect(options).toContain('preferredGraphicsBackend:opengl\n');
      expect(options).toContain('graphicsPreset:custom\n');
      expect(options).toContain('renderClouds:false\n');
      expect(options).toContain('renderDistance:8\n');
      expect(options).toContain('simulationDistance:5\n');
      expect(options).toContain('fov:0\n');
      expect(options).toContain('particles:2\n');
      expect(options).toContain('entityShadows:true\n');
      expect(options).toContain('bobView:false\n');
      expect(options).not.toContain('graphicsApi:');
      expect(plan.scenes).toEqual([
        expect.objectContaining({
          id: 'first_person_vanilla--fp_right_steve',
          baseSceneId: 'fp_right_steve',
          viewKind: 'first_person_vanilla',
          requiredForAuthority: true,
        }),
      ]);
      expect(plan.scenes[0]?.presentation).toBeUndefined();
      expect(
        input.args.find((argument) => argument.startsWith('-Dpackwright.capture.output=')),
      ).toBe(`-Dpackwright.capture.output=${plan.execution.outputDirectory}`);
      expect(await readdir(path.join(input.cwd, 'mods'))).toEqual(['packwright-capture.jar']);
      expect(await readdir(path.join(input.cwd, 'saves'))).toEqual(['packwright-capture']);
      expect(await readdir(path.join(input.cwd, 'saves/packwright-capture'))).toEqual([]);
      expect(await readFile(path.join(input.cwd, 'mods/packwright-capture.jar'))).toEqual(
        fixture.prepared.captureMod.data,
      );
      expect(
        (await readFile(path.join(input.cwd, ...CLIENT_CAPTURE_RESOURCEPACK_PATH.split('/'))))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (
          await readFile(
            path.join(input.cwd, ...CLIENT_CAPTURE_DATAPACK_PROVENANCE_PATH.split('/')),
          )
        ).length,
      ).toBeGreaterThan(0);
      await expect(
        readFile(
          path.join(input.cwd, 'saves/packwright-capture/datapacks/packwright-proposal.zip'),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(plan.provenance.packActivation).toEqual(CLIENT_CAPTURE_PACK_ACTIVATION);
      await writeCompleteOutput(plan);
      return processResult({ exitCode: 0 });
    };

    const result = await executeMinecraftClientCapture({
      ...fixture,
      timeoutMs: 45_000,
      launch,
    });

    expect(result.evidence.views).toEqual([
      expect.objectContaining({
        sceneId: 'first_person_vanilla--fp_right_steve',
        width: 64,
        height: 64,
      }),
    ]);
    expect(Object.keys(result.artifacts).sort()).toEqual([
      'capture-complete.json',
      'capture-report.json',
      'logs/client.log',
      'views/first_person_vanilla--fp_right_steve.png',
    ]);
    expect(
      result.artifacts['views/first_person_vanilla--fp_right_steve.png']?.length,
    ).toBeGreaterThan(0);
    expect(disposableGameDirectory).toBeDefined();
    await expect(lstat(disposableGameDirectory ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('captures an opt-in scale reference only as an exact supplemental vanilla pair', async () => {
    const fixture = await captureFixture(true);
    const launch: ClientCaptureProcessLauncher = async (input) => {
      const plan = parseClientCapturePlanBytes(
        await readFile(path.join(input.cwd, 'packwright/input/capture-plan.json')),
      );
      const vanilla = plan.scenes.find((scene) => scene.viewKind === 'first_person_vanilla');
      const scaleReference = plan.scenes.find(
        (scene) => scene.viewKind === 'first_person_scale_reference',
      );

      expect(vanilla).toMatchObject({
        id: 'first_person_vanilla--fp_right_steve',
        baseSceneId: 'fp_right_steve',
        requiredForAuthority: true,
      });
      expect(vanilla?.presentation).toBeUndefined();
      expect(scaleReference).toMatchObject({
        id: 'first_person_scale_reference--fp_right_steve',
        baseSceneId: 'fp_right_steve',
        requiredForAuthority: false,
        camera: vanilla?.camera,
        context: vanilla?.context,
        hand: vanilla?.hand,
        playerModel: vanilla?.playerModel,
        fov: vanilla?.fov,
        resolution: vanilla?.resolution,
        guiScale: vanilla?.guiScale,
        animationState: vanilla?.animationState,
        frame: vanilla?.frame,
        presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' },
      });

      await writeCompleteOutput(plan);
      return processResult({ exitCode: 0 });
    };

    const result = await executeMinecraftClientCapture({
      ...fixture,
      timeoutMs: 45_000,
      launch,
    });

    expect(result.evidence.views.map((view) => view.sceneId).sort()).toEqual([
      'first_person_scale_reference--fp_right_steve',
      'first_person_vanilla--fp_right_steve',
    ]);
    expect(Object.keys(result.artifacts).sort()).toEqual([
      'capture-complete.json',
      'capture-report.json',
      'logs/client.log',
      'views/first_person_scale_reference--fp_right_steve.png',
      'views/first_person_vanilla--fp_right_steve.png',
    ]);
  });

  it('reports a timed-out client as validation failure and removes the disposable game', async () => {
    const fixture = await captureFixture();
    let disposableGameDirectory: string | undefined;
    const launch: ClientCaptureProcessLauncher = (input) => {
      disposableGameDirectory = input.cwd;
      return Promise.resolve(
        processResult({
          timedOut: true,
          stderr: 'Packwright capture stalled during resource reload',
        }),
      );
    };

    const failure: unknown = await executeMinecraftClientCapture({
      ...fixture,
      timeoutMs: 30_000,
      launch,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'validation_failed',
      details: { status: 'timeout' },
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      'Packwright capture stalled during resource reload',
    );
    expect(disposableGameDirectory).toBeDefined();
    await expect(lstat(disposableGameDirectory ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the temporary root when plan creation changes the execution scope', async () => {
    const fixture = await captureFixture();
    let disposableRoot: string | undefined;
    const launch = vi.fn<ClientCaptureProcessLauncher>();

    await expect(
      executeMinecraftClientCapture({
        ...fixture,
        timeoutMs: 30_000,
        launch,
        createPlan: (execution) => {
          disposableRoot = path.dirname(execution.gameDirectory);
          return fixture.createPlan({
            ...execution,
            outputDirectory: path.join(execution.gameDirectory, 'unexpected-output'),
          });
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_content' });

    expect(launch).not.toHaveBeenCalled();
    expect(disposableRoot).toBeDefined();
    await expect(lstat(disposableRoot ?? '')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
