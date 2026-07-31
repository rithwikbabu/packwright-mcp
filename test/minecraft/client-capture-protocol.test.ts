import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Buffer } from '../../src/core/hash.js';
import {
  canonicalClientCapturePlanBytes,
  clientCaptureIdentityForPlan,
  computeClientCaptureSceneSha256,
  createClientCapturePlan,
  parseClientCapturePlan,
  parseClientCaptureReport,
  verifyClientCaptureComplete,
  verifyClientCaptureOutput,
  type ClientCaptureCompleteReport,
  type ClientCapturePlan,
} from '../../src/minecraft/client-capture-protocol.js';
import { encodePng } from '../../src/visual/png.js';
import { canonicalJsonBytes } from '../../src/visual/run-store.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const SHA1 = '1'.repeat(40);

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function planInput(
  executionId = 'capture-001',
  gameDirectory = '/private/tmp/packwright-game-001',
  outputDirectory = '/private/tmp/packwright-game-001/packwright-output',
) {
  return {
    schemaVersion: 1 as const,
    kind: 'packwright.client-capture-plan' as const,
    minecraftVersion: '26.2' as const,
    provenance: {
      projectId: 'firestaff',
      runId: HASH_A,
      revisionId: HASH_B,
      specSha256: HASH_C,
      compiledArtifactId: HASH_D,
      proposalArtifactId: HASH_E,
      projectManifestSha256: HASH_F,
      datapackContentSha256: '0'.repeat(64),
      resourcepackContentSha256: '2'.repeat(64),
      runtimeManifestSha256: '5'.repeat(64),
      itemStack: {
        itemId: 'minecraft:stick',
        count: 1,
        command:
          'give @s minecraft:stick[minecraft:item_model="arcana:firestaff",minecraft:custom_name={"text":"Fire Staff"}] 1',
        components: {
          'minecraft:custom_name': '{"text":"Fire Staff"}',
          'minecraft:item_model': '"arcana:firestaff"',
        },
      },
      client: {
        jarSha1: SHA1,
        jarSha256: '3'.repeat(64),
      },
      captureMod: {
        id: 'packwright_capture',
        version: '0.1.0',
        sha256: '4'.repeat(64),
      },
    },
    // Deliberately out of order: the creator canonicalizes scene ordering.
    scenes: [
      {
        id: 'inventory',
        camera: 'neutral' as const,
        context: 'inventory' as const,
        hand: 'right' as const,
        playerModel: 'alex' as const,
        fov: 70,
        resolution: { width: 64, height: 64 },
        guiScale: 2,
        animationState: 'idle' as const,
        frame: 0,
        presentation: {
          stackCount: 64,
          showGlint: true,
          durabilityFraction: 0.5,
        },
      },
      {
        id: 'first_person_right',
        camera: 'first_person' as const,
        context: 'world' as const,
        hand: 'right' as const,
        playerModel: 'steve' as const,
        fov: 70,
        resolution: { width: 64, height: 64 },
        guiScale: 0,
        animationState: 'aim' as const,
        frame: 7,
        presentation: { referenceArm: true, referenceArmPurpose: 'scale_only' as const },
      },
    ],
    execution: { executionId, gameDirectory, outputDirectory },
  };
}

function solidPng(width = 64, height = 64): Buffer {
  return encodePng({
    width,
    height,
    data: new Uint8Array(width * height * 4).fill(0x7f),
  });
}

function completeFixture(plan: ClientCapturePlan) {
  const pngs = new Map<string, Buffer>();
  const views = plan.scenes.map((scene) => {
    const png = solidPng(scene.resolution.width, scene.resolution.height);
    const artifactPath = `views/${scene.id}.png`;
    pngs.set(artifactPath, png);
    return {
      sceneId: scene.id,
      sceneSha256: computeClientCaptureSceneSha256(scene),
      scene,
      path: artifactPath,
      pngSha256: sha256Buffer(png),
      bytes: png.length,
      width: scene.resolution.width,
      height: scene.resolution.height,
    };
  });
  const log = Buffer.from(
    '[Render thread/INFO]: Reloading ResourceManager\n[Render thread/INFO]: Packwright capture complete\n',
  );
  const report: ClientCaptureCompleteReport = {
    schemaVersion: 1,
    kind: 'packwright.client-capture-report',
    status: 'complete',
    executionId: plan.execution.executionId,
    planSha256: plan.planSha256,
    identity: clientCaptureIdentityForPlan(plan),
    runtime: {
      rendererBackend: 'opengl',
      operatingSystem: 'macOS test',
      javaVersion: '25.0.1',
      gpuVendor: 'Test GPU Vendor',
      gpuRenderer: 'Test GPU',
      driverVersion: 'Test Driver 1.0',
    },
    views,
    log: {
      path: 'logs/client.log',
      sha256: sha256Buffer(log),
      bytes: log.length,
      resourceReloadSucceeded: true,
      excerpts: ['Reloading ResourceManager', 'Packwright capture complete'],
    },
  };
  return { report, pngs, log };
}

describe('client capture plan protocol', () => {
  it('canonicalizes scenes and keeps the stable plan hash independent of launch paths', () => {
    const first = createClientCapturePlan(planInput());
    const second = createClientCapturePlan(
      planInput(
        'capture-999',
        '/private/tmp/a-different-game',
        '/private/tmp/a-different-game/output',
      ),
    );

    expect(first.scenes.map(({ id }) => id)).toEqual(['first_person_right', 'inventory']);
    expect(clientCaptureIdentityForPlan(first).runtimeManifestSha256).toBe('5'.repeat(64));
    expect(first.planSha256).toBe(second.planSha256);
    expect(canonicalClientCapturePlanBytes(first)).toEqual(canonicalJsonBytes(first));

    const changed = createClientCapturePlan({
      ...planInput(),
      provenance: { ...planInput().provenance, resourcepackContentSha256: '5'.repeat(64) },
    });
    expect(changed.planSha256).not.toBe(first.planSha256);
  });

  it('rejects hash tampering, duplicate or unsafe scenes, unsafe host paths, and unknown fields', () => {
    const input = planInput();
    const firstScene = input.scenes[0];
    if (firstScene === undefined) throw new Error('Expected a fixture scene.');
    const plan = createClientCapturePlan(input);
    expect(() => parseClientCapturePlan({ ...plan, planSha256: '9'.repeat(64) })).toThrow(
      /hash does not match/u,
    );
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [firstScene, firstScene],
      }),
    ).toThrow(/Duplicate capture scene/u);
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [{ ...firstScene, id: '../escape' }],
      }),
    ).toThrow(/canonical capture id/u);
    expect(() =>
      createClientCapturePlan({
        ...input,
        execution: {
          executionId: 'bad-output',
          gameDirectory: '/private/tmp/game',
          outputDirectory: '/private/tmp/outside',
        },
      }),
    ).toThrow(/strict descendant/u);
    expect(() => parseClientCapturePlan({ ...plan, surprise: true })).toThrow(/unrecognized/u);
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [{ ...firstScene, fov: 121 }],
      }),
    ).toThrow();
    const firstPerson = input.scenes[1];
    if (firstPerson === undefined) throw new Error('Expected a first-person fixture scene.');
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [{ ...firstPerson, presentation: undefined }],
      }),
    ).toThrow(/reference-arm augmentation/u);
    expect(() =>
      createClientCapturePlan({
        ...input,
        scenes: [
          {
            ...firstScene,
            presentation: {
              ...firstScene.presentation,
              referenceArm: true,
              referenceArmPurpose: 'scale_only',
            },
          },
        ],
      }),
    ).toThrow(/only valid for first-person world/u);
  });
});

describe('client capture completion evidence', () => {
  it('verifies every planned framebuffer and the complete client log', async () => {
    const plan = createClientCapturePlan(planInput());
    const fixture = completeFixture(plan);
    const artifacts = new Map<string, Buffer>(fixture.pngs);
    artifacts.set(fixture.report.log.path, fixture.log);

    const evidence = await verifyClientCaptureComplete(plan, fixture.report, {
      readArtifact: (artifactPath) => {
        const value = artifacts.get(artifactPath);
        if (value === undefined) return Promise.reject(new Error('missing fixture'));
        return Promise.resolve(value);
      },
    });

    expect(evidence.views.map(({ sceneId }) => sceneId)).toEqual([
      'first_person_right',
      'inventory',
    ]);
    expect(evidence.log.sha256).toBe(sha256Buffer(fixture.log));
  });

  it('rejects missing, duplicate, extra, altered-scene, and provenance identities', () => {
    const plan = createClientCapturePlan(planInput());
    const { report } = completeFixture(plan);

    expect(() =>
      parseClientCaptureReport({ ...report, views: report.views.slice(1) }, plan),
    ).toThrow(/contains 1 views; expected 2/u);
    expect(() =>
      parseClientCaptureReport({ ...report, views: [report.views[0], report.views[0]] }, plan),
    ).toThrow(/Duplicate captured scene/u);
    expect(() =>
      parseClientCaptureReport(
        {
          ...report,
          views: [
            report.views[0],
            {
              ...report.views[1],
              sceneId: 'unplanned',
              scene: { ...report.views[1]?.scene, id: 'unplanned' },
            },
          ],
        },
        plan,
      ),
    ).toThrow(/unplanned scene/u);
    expect(() =>
      parseClientCaptureReport(
        {
          ...report,
          views: [
            { ...report.views[0], scene: { ...report.views[0]?.scene, fov: 90 } },
            report.views[1],
          ],
        },
        plan,
      ),
    ).toThrow(/altered parameters/u);
    expect(() =>
      parseClientCaptureReport(
        { ...report, identity: { ...report.identity, clientJarSha256: '8'.repeat(64) } },
        plan,
      ),
    ).toThrow(/provenance identity/u);
    expect(() =>
      parseClientCaptureReport(
        {
          ...report,
          views: [{ ...report.views[0], path: '../escaped.png' }, report.views[1]],
        },
        plan,
      ),
    ).toThrow(/canonical relative POSIX artifact path/u);
    expect(() =>
      parseClientCaptureReport(
        { ...report, log: { ...report.log, path: '%2e%2e/client.log' } },
        plan,
      ),
    ).toThrow(/canonical relative POSIX artifact path/u);
  });

  it('rejects modified PNG bytes, false dimensions, and log excerpts not backed by the full log', async () => {
    const plan = createClientCapturePlan(planInput());
    const fixture = completeFixture(plan);
    const artifacts = new Map<string, Buffer>(fixture.pngs);
    artifacts.set(fixture.report.log.path, fixture.log);
    const firstPath = fixture.report.views[0]?.path;
    if (firstPath === undefined) throw new Error('Expected a captured view.');
    artifacts.set(firstPath, solidPng(64, 64).subarray(0, 50));

    await expect(
      verifyClientCaptureComplete(plan, fixture.report, {
        readArtifact: (artifactPath) =>
          Promise.resolve(artifacts.get(artifactPath) ?? Buffer.alloc(0)),
      }),
    ).rejects.toThrow();

    const badDimensions = {
      ...fixture.report,
      views: fixture.report.views.map((view, index) =>
        index === 0 ? { ...view, width: view.width + 1 } : view,
      ),
    };
    expect(() => parseClientCaptureReport(badDimensions, plan)).toThrow(/unexpected dimensions/u);

    const badExcerpt = {
      ...fixture.report,
      log: { ...fixture.report.log, excerpts: ['not in the hashed log'] },
    };
    await expect(
      verifyClientCaptureComplete(plan, badExcerpt, {
        readArtifact: (artifactPath) => {
          if (artifactPath === fixture.report.log.path) return Promise.resolve(fixture.log);
          return Promise.resolve(fixture.pngs.get(artifactPath) ?? Buffer.alloc(0));
        },
      }),
    ).rejects.toThrow(/excerpt is not present/u);
  });

  it('verifies a confined canonical output directory from its completion sentinel', async () => {
    const gameDirectory = await mkdtemp(path.join(tmpdir(), 'packwright-client-capture-'));
    cleanups.push(gameDirectory);
    const outputDirectory = path.join(gameDirectory, 'output');
    await mkdir(path.join(outputDirectory, 'views'), { recursive: true });
    await mkdir(path.join(outputDirectory, 'logs'), { recursive: true });
    const plan = createClientCapturePlan(
      planInput('filesystem-capture', gameDirectory, outputDirectory),
    );
    const fixture = completeFixture(plan);
    for (const [artifactPath, png] of fixture.pngs) {
      await writeFile(path.join(outputDirectory, ...artifactPath.split('/')), png);
    }
    await writeFile(path.join(outputDirectory, 'logs/client.log'), fixture.log);
    const reportBytes = canonicalJsonBytes(fixture.report);
    await writeFile(path.join(outputDirectory, 'capture-report.json'), reportBytes);
    const sentinelBytes = canonicalJsonBytes({
      schemaVersion: 1,
      kind: 'packwright.client-capture-complete',
      executionId: plan.execution.executionId,
      planSha256: plan.planSha256,
      report: {
        path: 'capture-report.json',
        sha256: sha256Buffer(reportBytes),
        bytes: reportBytes.length,
      },
    });
    await writeFile(path.join(outputDirectory, 'capture-complete.json'), sentinelBytes);

    const evidence = await verifyClientCaptureOutput({ plan, outputDirectory });
    expect(evidence).toMatchObject({
      outputDirectory,
      completion: { path: 'capture-complete.json' },
      reportArtifact: { path: 'capture-report.json' },
    });

    await writeFile(
      path.join(outputDirectory, 'capture-complete.json'),
      Buffer.from(JSON.stringify(JSON.parse(sentinelBytes.toString('utf8')))),
    );
    await expect(verifyClientCaptureOutput({ plan, outputDirectory })).rejects.toThrow(
      /not canonical JSON/u,
    );
  });

  it('refuses symlinked evidence even when the link target remains under the output root', async () => {
    const gameDirectory = await mkdtemp(path.join(tmpdir(), 'packwright-client-capture-link-'));
    cleanups.push(gameDirectory);
    const outputDirectory = path.join(gameDirectory, 'output');
    await mkdir(outputDirectory);
    const plan = createClientCapturePlan(planInput('link-capture', gameDirectory, outputDirectory));
    const realSentinel = path.join(outputDirectory, 'real-sentinel.json');
    await writeFile(realSentinel, canonicalJsonBytes({ placeholder: true }));
    await symlink(realSentinel, path.join(outputDirectory, 'capture-complete.json'));

    await expect(verifyClientCaptureOutput({ plan, outputDirectory })).rejects.toThrow(
      /symbolic link/u,
    );
  });
});
