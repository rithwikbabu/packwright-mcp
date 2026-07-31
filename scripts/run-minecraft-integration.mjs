import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Workspace, createDatapack, upsertResource } from '../dist/core/index.js';
import {
  ProjectBuildInputSchema,
  VisualClientCaptureInputSchema,
  VisualCommitInputSchema,
  VisualCompileInputSchema,
  VisualConnectInputSchema,
  VisualProjectAttachInputSchema,
  VisualRenderInputSchema,
  VisualRevisionCreateInputSchema,
  VisualSpecUpsertInputSchema,
  VisualValidateInputSchema,
} from '../dist/mcp/visual-schemas.js';
import { setupVersion } from '../dist/minecraft/cache.js';
import { CLIENT_CAPTURE_MIN_SETTLE_FRAMES } from '../dist/minecraft/client-capture-protocol.js';
import { runGameTests } from '../dist/minecraft/gametest.js';
import { runProcess } from '../dist/runtime/process.js';
import { PackwrightApplication } from '../dist/service.js';

if (process.env.PACKWRIGHT_ACCEPT_MINECRAFT_EULA !== 'true') {
  throw new Error(
    'Set PACKWRIGHT_ACCEPT_MINECRAFT_EULA=true only after a human has accepted the Minecraft EULA.',
  );
}

const cacheDir = process.env.PACKWRIGHT_CACHE_DIR;
if (cacheDir === undefined || !path.isAbsolute(cacheDir)) {
  throw new Error('PACKWRIGHT_CACHE_DIR must be an absolute path for Minecraft integration.');
}

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'packwright-acceptance-'));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntrypoint = path.join(repositoryRoot, 'dist', 'cli.js');
const config = {
  workspaceRoot,
  cacheDir,
  javaCommand: process.env.PACKWRIGHT_JAVA ?? 'java',
  readOnly: false,
  offline: false,
};
const serviceContext = {
  signal: new globalThis.AbortController().signal,
  reportProgress: () => Promise.resolve(),
};
const runClientCapture = process.env.PACKWRIGHT_RUN_CLIENT_CAPTURE === 'true';
const keepIntegrationWorkspace = process.env.PACKWRIGHT_KEEP_INTEGRATION_WORKSPACE === 'true';
const captureTargetFilter = new Set(
  (process.env.PACKWRIGHT_INTEGRATION_CAPTURE_TARGETS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);
const captureStrategyFilter = new Set(
  (process.env.PACKWRIGHT_INTEGRATION_CAPTURE_STRATEGIES ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);
const skipScaleReferenceCapture =
  process.env.PACKWRIGHT_INTEGRATION_SKIP_SCALE_REFERENCE === 'true';

if (keepIntegrationWorkspace) {
  process.stderr.write(`Packwright integration workspace will be retained at ${workspaceRoot}\n`);
}

/**
 * @param {{ readonly ok: boolean }} result
 * @param {string} stage
 */
function requireSuccess(result, stage) {
  if (!result.ok) {
    throw new Error(`${stage} failed:\n${JSON.stringify(result, null, 2)}`);
  }
}

/**
 * @param {readonly string[]} args
 */
async function runCliJson(args) {
  const execution = await runProcess({
    command: process.execPath,
    args: [
      cliEntrypoint,
      '--workspace',
      workspaceRoot,
      '--cache-dir',
      cacheDir,
      '--java',
      config.javaCommand,
      '--no-read-only',
      '--no-offline',
      '--json',
      ...args,
    ],
    cwd: repositoryRoot,
    timeoutMs: 300_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (execution.timedOut || execution.cancelled || execution.stdoutTruncated) {
    throw new Error(
      `CLI ${args.join(' ')} did not complete cleanly:\n${JSON.stringify(execution, null, 2)}`,
    );
  }
  try {
    return { execution, payload: JSON.parse(execution.stdout) };
  } catch (error) {
    throw new Error(
      `CLI ${args.join(' ')} did not emit valid JSON: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${execution.stdout}\nstderr:\n${execution.stderr}`,
    );
  }
}

/**
 * @param {unknown} value
 * @param {string} message
 */
function requireCondition(value, message) {
  if (!value) throw new Error(message);
}

/**
 * @param {string} filename
 * @param {string} stage
 */
async function requireMissing(filename, stage) {
  try {
    await access(filename);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${stage} unexpectedly created ${filename}.`);
}

/**
 * @param {PackwrightApplication} application
 * @param {Awaited<ReturnType<PackwrightApplication['captureVisual']>>} result
 * @param {string} expectedTarget
 * @param {readonly string[]} expectedConditionalScenes
 * @param {boolean} expectSupplemental
 */
async function assertProtocolV3Capture(
  application,
  result,
  expectedTarget,
  expectedConditionalScenes,
  expectSupplemental,
) {
  requireSuccess(result, `${expectedTarget} protocol-v3 client capture`);
  const required = new Set(result.requiredViewIds);
  const supplemental = new Set(result.supplementalViewIds);
  requireCondition(
    result.protocolVersion === 3 &&
      result.targetKind === expectedTarget &&
      result.proposalBindingStatus === 'capture_only' &&
      typeof result.proposalBindingReason === 'string' &&
      typeof result.representationSha256 === 'string' &&
      typeof result.studioSha256 === 'string' &&
      result.environment?.rendererBackend === 'opengl' &&
      result.environment.studioSha256 === result.studioSha256,
    `${expectedTarget} result did not expose its protocol-v3 representation/studio/OpenGL identity.`,
  );
  requireCondition(
    required.size === result.requiredViewIds.length &&
      supplemental.size === result.supplementalViewIds.length &&
      [...required].every((id) => !supplemental.has(id)) &&
      required.size + supplemental.size === result.views.length &&
      result.views.every(
        (view) =>
          view.targetKind === expectedTarget &&
          view.representationSha256 === result.representationSha256 &&
          (required.has(view.name)
            ? view.requiredForAuthority &&
              view.authority === 'authoritative_environment_capture' &&
              view.viewKind !== 'debug_hitbox_reference' &&
              view.viewKind !== 'first_person_scale_reference' &&
              view.viewKind !== 'comparison_reference' &&
              view.viewKind !== 'world_scale_reference' &&
              view.viewKind !== 'measurement_control'
            : supplemental.has(view.name) &&
              !view.requiredForAuthority &&
              view.authority === 'augmented_qa_reference'),
      ),
    `${expectedTarget} result did not preserve the exact required/supplemental authority partition.`,
  );
  requireCondition(
    expectedConditionalScenes.every((sceneId) =>
      result.views.some((view) => view.baseSceneId === sceneId),
    ) &&
      (expectSupplemental
        ? result.supplementalContactSheet !== undefined && supplemental.size > 0
        : result.supplementalContactSheet === undefined && supplemental.size === 0),
    `${expectedTarget} capture did not include its conditional profile or correct supplemental sheet.`,
  );

  const resource = await application.readVisualResource(
    {
      kind: 'client_capture_report',
      runId: result.runId,
      revisionId: result.revisionId,
    },
    serviceContext,
  );
  requireCondition(
    resource.mimeType === 'application/json' && resource.encoding === 'utf8',
    `${expectedTarget} client-capture report resource is not canonical JSON.`,
  );
  const evidence = JSON.parse(resource.data);
  const plan = evidence.plan;
  const report = evidence.report;
  const sourceHashes = new Set(report.views.map((view) => view.pngSha256));
  const reportViews = new Map(report.views.map((view) => [view.sceneId, view]));
  const comparisonScenes = new Set(
    plan.scenes
      .filter((scene) => scene.requiredForAuthority && scene.comparisonSceneIds.length > 0)
      .map((scene) => scene.id),
  );
  const measurementIntents = new Map(
    plan.scenes.flatMap((scene) => scene.measurementIntents.map((intent) => [intent.id, intent])),
  );
  requireCondition(
    evidence.schemaVersion === 3 &&
      evidence.proposalBindingStatus === 'capture_only' &&
      plan.schemaVersion === 3 &&
      report.schemaVersion === 3 &&
      plan.provenance.packActivation.datapack === 'hash_bound_not_loaded' &&
      plan.provenance.packActivation.resourcepack === 'active' &&
      report.packActivation.datapack.mode === 'hash_bound_not_loaded' &&
      report.packActivation.datapack.selected === false &&
      !report.packActivation.datapack.selectedPackIds.includes('file/packwright-proposal.zip') &&
      report.packActivation.datapack.archiveSha256 === plan.provenance.datapackContentSha256 &&
      report.packActivation.resourcepack.mode === 'active' &&
      report.packActivation.resourcepack.selected === true &&
      report.packActivation.resourcepack.selectedPackIds.includes('file/packwright-proposal.zip') &&
      report.packActivation.resourcepack.archiveSha256 ===
        plan.provenance.resourcepackContentSha256 &&
      plan.provenance.representation.targetKind === expectedTarget &&
      plan.provenance.representationSha256 === result.representationSha256 &&
      report.identity.representationSha256 === result.representationSha256 &&
      report.identity.studioSha256 === result.studioSha256 &&
      report.runtime.studioSha256 === result.studioSha256 &&
      report.runtime.settings.preferredGraphicsBackend === 'opengl' &&
      report.runtime.settings.graphicsMode === 'custom' &&
      report.runtime.settings.clouds === 'off' &&
      report.runtime.settings.particles === 'minimal' &&
      report.runtime.settings.entityShadows === true &&
      report.runtime.settings.viewBobbing === false &&
      report.runtime.settings.debugUi === false &&
      report.runtime.modelBakeReadyTick >= report.runtime.resourceReloadReadyTick &&
      result.views.every((view) => reportViews.get(view.name)?.pngSha256 === view.sourceSha256),
    `${expectedTarget} report is not bound to the exact representation and deterministic studio.`,
  );
  requireCondition(
    report.views.every(
      (view) =>
        view.representationSha256 === result.representationSha256 &&
        view.studioSha256 === result.studioSha256 &&
        typeof view.fixtureSha256 === 'string' &&
        view.fixtureSha256.length === 64 &&
        typeof view.appliedFixtureSha256 === 'string' &&
        view.appliedFixtureSha256.length === 64 &&
        typeof view.observedFixtureSha256 === 'string' &&
        view.observedFixtureSha256.length === 64 &&
        view.observedFixture !== null &&
        typeof view.observedFixture === 'object' &&
        view.resourceReloadReady === true &&
        view.modelBakeReady === true &&
        view.actualSettledTicks === view.scene.settlingTicks &&
        view.renderedSettleFrames >= CLIENT_CAPTURE_MIN_SETTLE_FRAMES &&
        view.actualAnimationTick ===
          ('animationTick' in view.scene.fixture
            ? view.scene.fixture.animationTick
            : view.scene.frame) &&
        view.actualCameraPose !== null &&
        typeof view.actualCameraPose === 'object' &&
        view.actualCameraMode ===
          (view.scene.camera === 'neutral' ? 'first_person' : view.scene.camera) &&
        view.actualFov === view.scene.fov &&
        view.actualGuiScale === view.scene.guiScale &&
        view.actualHand === view.scene.hand &&
        view.actualPlayerModel === view.scene.playerModel &&
        JSON.stringify(view.actualEnvironment) === JSON.stringify(view.scene.environment) &&
        JSON.stringify(view.actualScaleReference) === JSON.stringify(plan.studio.scaleReference) &&
        typeof view.actualScaleReferenceSha256 === 'string' &&
        view.actualScaleReferenceSha256.length === 64,
    ),
    `${expectedTarget} report omitted fixture hashes, readiness, or settling evidence.`,
  );
  requireCondition(
    plan.scenes
      .filter((scene) => scene.viewKind === 'measurement_control')
      .every((control) => {
        const base = plan.scenes.find(
          (scene) => scene.baseSceneId === control.baseSceneId && scene.requiredForAuthority,
        );
        return (
          base !== undefined &&
          control.requiredForAuthority === false &&
          control.comparisonSceneIds.length === 1 &&
          control.comparisonSceneIds[0] === base.id &&
          base.comparisonSceneIds.includes(control.id)
        );
      }),
    `${expectedTarget} measurement controls are not exact supplemental bidirectional pairs.`,
  );
  requireCondition(
    report.measurements.length > 0 &&
      report.measurements.some(
        (measurement) =>
          measurement.metric === 'pairwise_pixel_delta' &&
          measurement.status !== 'skipped' &&
          measurement.sceneIds.some((sceneId) => comparisonScenes.has(sceneId)),
      ) &&
      report.measurements.every(
        (measurement) =>
          measurement.authority === 'client_pixels' &&
          measurement.requiredForReadiness ===
            measurementIntents.get(measurement.id)?.requiredForReadiness &&
          (!measurement.requiredForReadiness ||
            (measurement.status !== 'failed' && measurement.status !== 'skipped')) &&
          (measurement.status === 'skipped' ||
            measurementIntents.get(measurement.id)?.threshold !== undefined ||
            measurement.status === 'warning') &&
          (measurement.status === 'skipped'
            ? measurement.value === undefined &&
              measurement.sourcePngSha256s.length === 0 &&
              measurement.message.length > 0
            : typeof measurement.value === 'number' &&
              measurement.sourcePngSha256s.length > 0 &&
              measurement.sourcePngSha256s.every((hash) => sourceHashes.has(hash))),
      ),
    `${expectedTarget} measurements were not derived from bound client pixels or explicitly skipped.`,
  );
}

/**
 * @param {string} id
 * @param {'block'|'head_wearable'|'entity_model'|'placeable'} reviewProfile
 * @param {Record<string, unknown>} review
 */
function clientCaptureFixtureSpec(id, reviewProfile, review) {
  return {
    id,
    targetKind: 'item',
    template: 'handheld_3d',
    textureSize: [16, 16],
    materials: { fixture: { color: '#7a4b2a' } },
    parts: [
      {
        id: 'fixture',
        shape: 'cuboid',
        from: [4, 2, 4],
        to: [12, 14, 12],
        material: 'fixture',
      },
    ],
    displayPreset: 'handheld_3d',
    reviewProfile,
    ...review,
    connection: { carrierItem: 'minecraft:stick' },
  };
}

/**
 * @param {PackwrightApplication} application
 * @param {{runId:string, specSha256:string}} latest
 * @param {Record<string, unknown>} spec
 * @param {Record<string, unknown>} representation
 * @param {string} expectedTarget
 * @param {readonly string[]} expectedConditionalScenes
 * @param {{
 *   debug?:boolean,
 *   supplemental?:boolean,
 *   settlingTicks?:number,
 *   alternates?:readonly {
 *     representation:Record<string, unknown>,
 *     expectedConditionalScenes:readonly string[],
 *     debug?:boolean,
 *     supplemental?:boolean,
 *     settlingTicks?:number
 *   }[]
 * }} [options]
 */
async function captureProtocolV3Profile(
  application,
  latest,
  spec,
  representation,
  expectedTarget,
  expectedConditionalScenes,
  options = {},
) {
  if (captureTargetFilter.size > 0 && !captureTargetFilter.has(expectedTarget)) return latest;
  const draft = await application.upsertVisualSpec(
    VisualSpecUpsertInputSchema.parse({
      projectId: 'firestaff',
      request: `Official-client protocol-v3 ${expectedTarget} default and conditional fixtures`,
      spec,
      parentRunId: latest.runId,
      expectedSpecSha256: latest.specSha256,
    }),
    serviceContext,
  );
  requireSuccess(draft, `${expectedTarget} capture specification`);
  requireSuccess(
    await application.compileVisual(
      VisualCompileInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: draft.revisionId,
      }),
      serviceContext,
    ),
    `${expectedTarget} capture compilation`,
  );
  const proposal = await application.connectVisual(
    VisualConnectInputSchema.parse({
      projectId: 'firestaff',
      runId: draft.runId,
      revisionId: draft.revisionId,
      carrierItem: 'minecraft:stick',
      generateGiveFunction: false,
      generateRecipe: false,
    }),
    serviceContext,
  );
  requireSuccess(proposal, `${expectedTarget} capture binding proposal`);
  requireCondition(
    typeof proposal.proposalSha256 === 'string',
    `${expectedTarget} capture proposal has no immutable proposal hash.`,
  );
  const captureCase = async (captureRepresentation, conditionalScenes, captureOptions) => {
    if (
      captureStrategyFilter.size > 0 &&
      !captureStrategyFilter.has(captureRepresentation.strategy)
    )
      return;
    const result = await application.captureVisual(
      VisualClientCaptureInputSchema.parse({
        projectId: 'firestaff',
        runId: draft.runId,
        revisionId: draft.revisionId,
        proposalSha256: proposal.proposalSha256,
        representation: captureRepresentation,
        confirm: true,
        timeoutMs: 300_000,
        resolution: { width: 1280, height: 720 },
        guiScale: 2,
        includeDebugHitboxViews: captureOptions.debug === true,
        ...(captureOptions.settlingTicks === undefined
          ? {}
          : { displaySettlingTicks: captureOptions.settlingTicks }),
      }),
      serviceContext,
    );
    await assertProtocolV3Capture(
      application,
      result,
      expectedTarget,
      conditionalScenes,
      captureOptions.supplemental === true ||
        captureOptions.debug === true ||
        ['block', 'headwear', 'entity', 'placeable'].includes(expectedTarget),
    );
    requireCondition(
      result.representationStrategy === captureRepresentation.strategy &&
        result.representationCapability === captureRepresentation.capability,
      `${expectedTarget} result mislabeled its representation strategy or capability.`,
    );
  };
  await captureCase(representation, expectedConditionalScenes, options);
  for (const alternate of options.alternates ?? []) {
    await captureCase(alternate.representation, alternate.expectedConditionalScenes, alternate);
  }
  return { runId: draft.runId, specSha256: draft.specSha256 };
}

try {
  await setupVersion(config, true, undefined, runClientCapture ? { clientCapture: true } : {});
  const workspace = await Workspace.open(workspaceRoot);
  requireSuccess(
    await createDatapack(workspace, {
      packPath: 'acceptance',
      namespace: 'packwright_acceptance',
      description: 'Packwright create-to-vanilla acceptance pack',
      loadFunction: 'scoreboard objectives add packwright_acceptance dummy',
    }),
    'create',
  );

  requireSuccess(
    await upsertResource(workspace, 'acceptance', {
      type: 'test_environment',
      id: 'packwright_acceptance:fixture',
      content: `${JSON.stringify({ type: 'minecraft:all_of', definitions: [] }, null, 2)}\n`,
    }),
    'GameTest environment upsert',
  );
  requireSuccess(
    await upsertResource(workspace, 'acceptance', {
      type: 'test_instance',
      id: 'packwright_acceptance:smoke',
      content: `${JSON.stringify(
        {
          type: 'function',
          environment: 'packwright_acceptance:fixture',
          structure: 'minecraft:empty',
          max_ticks: 100,
          setup_ticks: 0,
          required: true,
          function: 'minecraft:always_pass',
        },
        null,
        2,
      )}\n`,
    }),
    'GameTest instance upsert',
  );

  const functionPreamble = Array.from(
    { length: 11 },
    (_, index) => `# Vanilla command validation fixture line ${String(index + 1)}`,
  );
  const invalidCommands = [
    'particle minecraft:electric ~ ~ ~',
    'attribute @s minecraft:bouncyness base get',
    'give @s minecraft:diamond_swor',
    'give @s minecraft:diamond_sword[minecraft:damage="broken"] 1',
    'tellraw @a {"text":"Arc","color":"darkpurple"}',
    'execute as @e[type=minecraft:sulfur_cub,limit=1] run say found',
    'summon minecraft:sulfur_cube ~ ~ ~ {Tags:["spell"]',
    'electrify @s',
  ];
  const invalidFunction = await upsertResource(workspace, 'acceptance', {
    type: 'function',
    id: 'packwright_acceptance:spell/chain/cast',
    content: `${[...functionPreamble, ...invalidCommands].join('\n')}\n`,
  });
  requireSuccess(invalidFunction, 'invalid command fixture upsert');

  const invalidValidation = await runCliJson(['validate', 'acceptance', '--no-spyglass']);
  requireCondition(
    invalidValidation.execution.exitCode === 1 && invalidValidation.payload.ok === false,
    `Invalid commands were not rejected by CLI validation:\n${JSON.stringify(invalidValidation, null, 2)}`,
  );
  requireCondition(
    invalidValidation.payload.vanilla?.status === 'failed' &&
      invalidValidation.payload.vanilla.commandLinesChecked >= invalidCommands.length,
    `CLI validation did not report a failed vanilla dispatcher run covering every fixture command:\n${JSON.stringify(invalidValidation.payload, null, 2)}`,
  );
  const invalidDiagnostics = Array.isArray(invalidValidation.payload.diagnostics)
    ? invalidValidation.payload.diagnostics
    : [];
  const functionPath = 'data/packwright_acceptance/function/spell/chain/cast.mcfunction';
  const particleDiagnostic = invalidDiagnostics.find(
    (diagnostic) =>
      diagnostic.engine === 'minecraft' &&
      diagnostic.authority === 'authoritative' &&
      diagnostic.severity === 'error' &&
      diagnostic.path === functionPath &&
      diagnostic.range?.start?.line === 11 &&
      diagnostic.message === 'Unknown particle `minecraft:electric`' &&
      diagnostic.suggestedFix === 'Did you mean `minecraft:electric_spark`?',
  );
  requireCondition(
    particleDiagnostic !== undefined,
    `Missing the expected authoritative line-12 particle diagnostic:\n${JSON.stringify(invalidDiagnostics, null, 2)}`,
  );
  const attributeDiagnostic = invalidDiagnostics.find(
    (diagnostic) =>
      diagnostic.engine === 'minecraft' &&
      diagnostic.authority === 'authoritative' &&
      diagnostic.severity === 'error' &&
      diagnostic.path === functionPath &&
      diagnostic.range?.start?.line === 12 &&
      diagnostic.message.includes('minecraft:bouncyness'),
  );
  requireCondition(
    attributeDiagnostic !== undefined,
    `Minecraft did not report the independently probed line-13 command:\n${JSON.stringify(invalidDiagnostics, null, 2)}`,
  );
  const additionalFailures = [
    {
      category: 'invalid item identifier',
      line: 13,
      expectedText: 'minecraft:diamond_swor',
    },
    {
      category: 'invalid item component data',
      line: 14,
      expectedText: 'minecraft:damage',
    },
    {
      category: 'malformed text component codec',
      line: 15,
      expectedText: 'darkpurple',
    },
    {
      category: 'invalid selector entity type',
      line: 16,
      expectedText: 'minecraft:sulfur_cub',
    },
    {
      category: 'malformed entity SNBT',
      line: 17,
    },
    {
      category: 'unknown command',
      line: 18,
      expectedText: 'electrify',
    },
  ];
  for (const expected of additionalFailures) {
    const diagnostic = invalidDiagnostics.find(
      (candidate) =>
        candidate.engine === 'minecraft' &&
        candidate.authority === 'authoritative' &&
        candidate.severity === 'error' &&
        candidate.path === functionPath &&
        candidate.range?.start?.line === expected.line &&
        (expected.expectedText === undefined || candidate.message.includes(expected.expectedText)),
    );
    requireCondition(
      diagnostic !== undefined,
      `Minecraft did not map the ${expected.category} failure to source line ${String(expected.line + 1)}:\n${JSON.stringify(invalidDiagnostics, null, 2)}`,
    );
  }

  const refusedArchive = path.join(workspaceRoot, 'build', 'invalid-commands.zip');
  await requireMissing(refusedArchive, 'pre-build check');
  const refusedBuild = await runCliJson([
    'build',
    'acceptance',
    '--output',
    'build/invalid-commands.zip',
  ]);
  requireCondition(
    refusedBuild.execution.exitCode === 1 && refusedBuild.payload.ok === false,
    `Build did not refuse the invalid commands:\n${JSON.stringify(refusedBuild, null, 2)}`,
  );
  requireCondition(
    Array.isArray(refusedBuild.payload.diagnostics) &&
      refusedBuild.payload.diagnostics.some(
        (diagnostic) =>
          diagnostic.engine === 'minecraft' &&
          diagnostic.authority === 'authoritative' &&
          diagnostic.severity === 'error',
      ),
    `Refused build did not return an authoritative Minecraft diagnostic:\n${JSON.stringify(refusedBuild.payload, null, 2)}`,
  );
  await requireMissing(refusedArchive, 'refused build');

  const validFunction = await upsertResource(workspace, 'acceptance', {
    type: 'function',
    id: 'packwright_acceptance:spell/chain/cast',
    content: `${[
      ...functionPreamble,
      'particle minecraft:electric_spark ~ ~ ~',
      'attribute @s minecraft:bounciness base get',
      'give @s minecraft:diamond_sword',
      'give @s minecraft:diamond_sword[minecraft:damage=1] 1',
      'tellraw @a {"text":"Arc","color":"dark_purple"}',
      'execute as @e[type=minecraft:sulfur_cube,limit=1] run say found',
      'summon minecraft:sulfur_cube ~ ~ ~ {Tags:["spell"]}',
      'say command validation passed',
    ].join('\n')}\n`,
    overwrite: true,
    expectedSha256: invalidFunction.sha256,
  });
  requireSuccess(validFunction, 'valid command fixture upsert');

  const validValidation = await runCliJson(['validate', 'acceptance', '--no-spyglass']);
  requireCondition(
    validValidation.execution.exitCode === 0 &&
      validValidation.payload.ok === true &&
      validValidation.payload.vanilla?.status === 'passed',
    `Repaired commands did not pass CLI validation:\n${JSON.stringify(validValidation, null, 2)}`,
  );
  requireSuccess(
    await runGameTests(config, workspace, {
      project: 'acceptance',
      tests: ['packwright_acceptance:smoke'],
      timeoutMs: 300_000,
    }),
    'source GameTest',
  );

  const archive = await runCliJson(['build', 'acceptance', '--output', 'build/acceptance.zip']);
  requireCondition(
    archive.execution.exitCode === 0 && archive.payload.ok === true,
    `CLI build failed:\n${JSON.stringify(archive, null, 2)}`,
  );

  const extracted = path.join(workspaceRoot, 'built-pack');
  await mkdir(extracted, { mode: 0o700 });
  const unzip = await runProcess({
    command: 'unzip',
    args: ['-q', path.join(workspaceRoot, 'build', 'acceptance.zip'), '-d', extracted],
    timeoutMs: 30_000,
  });
  if (unzip.exitCode !== 0 || unzip.timedOut || unzip.cancelled) {
    throw new Error(`Could not extract the deterministic build: ${unzip.stderr}`);
  }

  requireSuccess(
    await runGameTests(config, workspace, {
      project: 'built-pack',
      tests: ['packwright_acceptance:smoke'],
      timeoutMs: 300_000,
    }),
    'built ZIP vanilla load',
  );

  requireSuccess(
    await createDatapack(workspace, {
      packPath: 'firestaff-data',
      namespace: 'arcana',
      description: 'Packwright paired visual acceptance datapack',
    }),
    'paired visual datapack create',
  );
  requireSuccess(
    await upsertResource(workspace, 'firestaff-data', {
      type: 'test_environment',
      id: 'arcana:fixture',
      content: `${JSON.stringify({ type: 'minecraft:all_of', definitions: [] }, null, 2)}\n`,
    }),
    'paired visual GameTest environment',
  );
  requireSuccess(
    await upsertResource(workspace, 'firestaff-data', {
      type: 'test_instance',
      id: 'arcana:visual_smoke',
      content: `${JSON.stringify(
        {
          type: 'function',
          environment: 'arcana:fixture',
          structure: 'minecraft:empty',
          max_ticks: 100,
          setup_ticks: 0,
          required: true,
          function: 'minecraft:always_pass',
        },
        null,
        2,
      )}\n`,
    }),
    'paired visual GameTest instance',
  );

  const application = await PackwrightApplication.open(config);
  requireSuccess(
    await application.attachVisualProject(
      VisualProjectAttachInputSchema.parse({
        id: 'firestaff',
        datapack: 'firestaff-data',
        resourcepack: 'firestaff-assets',
        description: 'Packwright paired visual acceptance resource pack',
      }),
      serviceContext,
    ),
    'paired visual project attach',
  );
  const initialDraft = await application.upsertVisualSpec(
    VisualSpecUpsertInputSchema.parse({
      projectId: 'firestaff',
      request: 'A crystal fire staff with an intentionally clipped first-person transform',
      spec: {
        id: 'arcana:firestaff',
        targetKind: 'item',
        template: 'handheld_3d',
        textureSize: [32, 32],
        materials: {
          dark_oak: { color: '#4d2f1a' },
          fire_crystal: { color: '#ff6a00', emissive: true, tintIndex: 0 },
        },
        parts: [
          {
            id: 'handle',
            shape: 'cuboid',
            from: [7, 0, 7],
            to: [9, 13, 9],
            material: 'dark_oak',
          },
          {
            id: 'crystal',
            shape: 'cuboid',
            from: [6, 12, 6],
            to: [10, 16, 10],
            material: 'fire_crystal',
            parent: 'handle',
            rotation: { axis: 'y', angle: 22.5, pivot: [8, 14, 8] },
          },
        ],
        displayPreset: 'handheld_3d',
        reviewProfile: 'held_item',
        heldItem: {
          primaryGrip: [8, 5.5, 11],
          muzzle: [8, 15, 8],
          forwardAxis: [0, 0, -1],
          handedness: 'either',
          twoHanded: false,
          itemKind: 'weapon',
          usePose: 'aim',
        },
        display: {
          firstperson_righthand: {
            rotation: [0, -90, 25],
            translation: [70, 3, 1],
            scale: [0.68, 0.68, 0.68],
          },
        },
        connection: { carrierItem: 'minecraft:shield' },
      },
    }),
    serviceContext,
  );
  requireSuccess(initialDraft, 'paired visual semantic draft');
  const clippedRender = await application.renderVisual(
    VisualRenderInputSchema.parse({
      projectId: 'firestaff',
      runId: initialDraft.runId,
      revisionId: initialDraft.revisionId,
      viewSize: 64,
    }),
    serviceContext,
  );
  requireCondition(
    clippedRender.ok === false && clippedRender.reviewReady === false,
    `The intentionally clipped held-item render unexpectedly passed review:\n${JSON.stringify(clippedRender, null, 2)}`,
  );
  requireCondition(
    clippedRender.measurements.some((measurement) => measurement.status === 'failed'),
    'The intentionally clipped held-item render did not produce a failed profile measurement.',
  );
  const repairedDraft = await application.createVisualRevision(
    VisualRevisionCreateInputSchema.parse({
      projectId: 'firestaff',
      runId: initialDraft.runId,
      parentRevisionId: initialDraft.revisionId,
      expectedSpecSha256: initialDraft.specSha256,
      instructions: 'The first-person right-hand preview is clipped; reset its translation.',
      repairs: [
        {
          kind: 'display',
          context: 'firstperson_righthand',
          transform: {
            rotation: [0, -90, 25],
            translation: [1.13, 3.2, 1.13],
            scale: [0.68, 0.68, 0.68],
          },
        },
      ],
    }),
    serviceContext,
  );
  requireSuccess(repairedDraft, 'paired visual targeted repair');
  const repairedRender = await application.renderVisual(
    VisualRenderInputSchema.parse({
      projectId: 'firestaff',
      runId: initialDraft.runId,
      revisionId: repairedDraft.revisionId,
      viewSize: 64,
    }),
    serviceContext,
  );
  requireSuccess(repairedRender, 'paired visual repaired render');
  requireCondition(
    repairedRender.pixelSha256 !== clippedRender.pixelSha256,
    'The targeted visual repair did not change the deterministic contact sheet.',
  );
  const connection = await application.connectVisual(
    VisualConnectInputSchema.parse({
      projectId: 'firestaff',
      runId: initialDraft.runId,
      revisionId: repairedDraft.revisionId,
      carrierItem: 'minecraft:shield',
      generateGiveFunction: true,
      generateRecipe: true,
      recipe: {
        pattern: [' B ', 'BCB', ' S '],
        key: {
          B: 'minecraft:blaze_powder',
          C: 'minecraft:amethyst_shard',
          S: 'minecraft:stick',
        },
      },
    }),
    serviceContext,
  );
  requireSuccess(connection, 'paired visual behavior connection');
  requireCondition(
    typeof connection.proposalSha256 === 'string',
    'Paired visual connection did not produce an accepted proposal hash.',
  );
  const vanillaClientCapture = runClientCapture
    ? await application.captureVisual(
        VisualClientCaptureInputSchema.parse({
          projectId: 'firestaff',
          runId: initialDraft.runId,
          revisionId: repairedDraft.revisionId,
          proposalSha256: connection.proposalSha256,
          confirm: true,
          timeoutMs: 300_000,
          resolution: { width: 1280, height: 720 },
          guiScale: 2,
        }),
        serviceContext,
      )
    : undefined;
  let clientCapture = vanillaClientCapture;
  if (vanillaClientCapture !== undefined) {
    requireSuccess(vanillaClientCapture, 'official vanilla Minecraft client framebuffer capture');
    requireCondition(
      vanillaClientCapture.status === 'passed' &&
        vanillaClientCapture.protocolVersion === 3 &&
        vanillaClientCapture.targetKind === 'held_item' &&
        typeof vanillaClientCapture.reportSha256 === 'string' &&
        typeof vanillaClientCapture.representationSha256 === 'string' &&
        typeof vanillaClientCapture.studioSha256 === 'string' &&
        vanillaClientCapture.requiredViewIds.length === 15 &&
        vanillaClientCapture.supplementalViewIds.length === 0 &&
        vanillaClientCapture.supplementalContactSheet === undefined &&
        vanillaClientCapture.supplementalContactSheetUri === undefined,
      `Default client capture did not return exactly 15 authoritative vanilla views and no augmented QA sheet:\n${JSON.stringify(vanillaClientCapture, null, 2)}`,
    );
    requireCondition(
      vanillaClientCapture.views.every(
        (view) =>
          view.requiredForAuthority &&
          view.authority === 'authoritative_environment_capture' &&
          view.viewKind !== 'first_person_scale_reference',
      ) &&
        vanillaClientCapture.views.filter((view) => view.viewKind === 'first_person_vanilla')
          .length === 8,
      `Default client capture mislabeled an augmented view as authoritative gameplay:\n${JSON.stringify(vanillaClientCapture.views, null, 2)}`,
    );

    if (!skipScaleReferenceCapture) {
      clientCapture = await application.captureVisual(
        VisualClientCaptureInputSchema.parse({
          projectId: 'firestaff',
          runId: initialDraft.runId,
          revisionId: repairedDraft.revisionId,
          proposalSha256: connection.proposalSha256,
          confirm: true,
          timeoutMs: 300_000,
          resolution: { width: 1280, height: 720 },
          guiScale: 2,
          includeScaleReferenceViews: true,
        }),
        serviceContext,
      );
      requireSuccess(clientCapture, 'official Minecraft scale-reference QA capture');
      const vanillaViews = clientCapture.views.filter(
        (view) => view.viewKind === 'first_person_vanilla',
      );
      const scaleReferenceViews = clientCapture.views.filter(
        (view) => view.viewKind === 'first_person_scale_reference',
      );
      requireCondition(
        clientCapture.status === 'passed' &&
          typeof clientCapture.reportSha256 === 'string' &&
          clientCapture.requiredViewIds.length === 15 &&
          clientCapture.supplementalViewIds.length === 8 &&
          clientCapture.supplementalContactSheet !== undefined &&
          clientCapture.supplementalContactSheetUri !== undefined &&
          vanillaViews.length === 8 &&
          scaleReferenceViews.length === 8 &&
          scaleReferenceViews.every(
            (view) =>
              !view.requiredForAuthority &&
              view.authority === 'augmented_qa_reference' &&
              vanillaViews.some((vanilla) => vanilla.baseSceneId === view.baseSceneId),
          ),
        `Opt-in client capture did not keep 15 authoritative views separate from eight paired QA references:\n${JSON.stringify(clientCapture, null, 2)}`,
      );
    }
  }
  const visualValidation = await application.validateVisual(
    VisualValidateInputSchema.parse({
      projectId: 'firestaff',
      runId: initialDraft.runId,
      revisionId: repairedDraft.revisionId,
      includeVanilla: true,
      includeGameTests: true,
      requireClientCapture: runClientCapture,
    }),
    serviceContext,
  );
  requireSuccess(visualValidation, 'paired visual overlay validation and GameTest');
  requireCondition(
    visualValidation.layers.every(
      (layer) => layer.status === 'passed' || layer.status === 'skipped',
    ),
    `Paired visual validation did not pass every selected layer:\n${JSON.stringify(visualValidation, null, 2)}`,
  );
  if (clientCapture === undefined) {
    requireCondition(
      visualValidation.layers.some(
        (layer) => layer.name === 'client_capture' && layer.status === 'skipped',
      ),
      'Server-only integration must explicitly report client capture as skipped.',
    );
  } else {
    requireSuccess(
      await application.commitVisual(
        VisualCommitInputSchema.parse({
          projectId: 'firestaff',
          runId: initialDraft.runId,
          revisionId: repairedDraft.revisionId,
          proposalSha256: connection.proposalSha256,
          expectedClientCaptureReportSha256: clientCapture.reportSha256,
          confirm: true,
        }),
        serviceContext,
      ),
      'paired visual transaction commit',
    );
    const pairedBuild = await application.buildProject(
      ProjectBuildInputSchema.parse({
        projectId: 'firestaff',
        outputDirectory: 'visual-build',
      }),
      serviceContext,
    );
    requireSuccess(pairedBuild, 'paired deterministic build');
    const repeatBuild = await application.buildProject(
      ProjectBuildInputSchema.parse({
        projectId: 'firestaff',
        outputDirectory: 'visual-build-repeat',
      }),
      serviceContext,
    );
    requireSuccess(repeatBuild, 'repeated paired deterministic build');
    requireCondition(
      pairedBuild.datapack.sha256 === repeatBuild.datapack.sha256 &&
        pairedBuild.resourcepack.sha256 === repeatBuild.resourcepack.sha256,
      'Repeated paired builds were not byte-identical.',
    );

    const builtVisualData = path.join(workspaceRoot, 'built-visual-data');
    await mkdir(builtVisualData, { mode: 0o700 });
    const unpackVisualData = await runProcess({
      command: 'unzip',
      args: ['-q', path.join(workspaceRoot, pairedBuild.datapack.path), '-d', builtVisualData],
      timeoutMs: 30_000,
    });
    requireCondition(
      unpackVisualData.exitCode === 0 && !unpackVisualData.timedOut && !unpackVisualData.cancelled,
      `Could not extract the paired datapack ZIP: ${unpackVisualData.stderr}`,
    );
    requireSuccess(
      await runGameTests(config, workspace, {
        project: 'built-visual-data',
        tests: ['arcana:visual_smoke'],
        timeoutMs: 300_000,
      }),
      'built paired datapack vanilla load',
    );
    const resourcepackArchiveCheck = await runProcess({
      command: 'unzip',
      args: ['-tq', path.join(workspaceRoot, pairedBuild.resourcepack.path)],
      timeoutMs: 30_000,
    });
    requireCondition(
      resourcepackArchiveCheck.exitCode === 0 &&
        !resourcepackArchiveCheck.timedOut &&
        !resourcepackArchiveCheck.cancelled,
      `Could not verify the paired resource-pack ZIP: ${resourcepackArchiveCheck.stderr}`,
    );

    const displayNode = (blockId, scale) => ({
      id: 'body',
      kind: 'block_display',
      position: [0, 0, 0],
      yaw: 0,
      pitch: 0,
      transform: {
        translation: [0, 0, 0],
        leftRotation: [0, 0, 0],
        scale,
        rightRotation: [0, 0, 0],
      },
      billboard: 'fixed',
      brightness: { block: 15, sky: 15 },
      shadow: { radius: 0.5, strength: 1 },
      interpolation: { duration: 0, startDelta: 0 },
      blockState: { id: blockId, properties: {} },
    });
    const itemDisplayNode = () => ({
      id: 'accent',
      kind: 'item_display',
      position: [0.25, 1.125, -0.375],
      yaw: 22.5,
      pitch: -11.25,
      transform: {
        translation: [0.125, 0.25, -0.125],
        leftRotation: [0, 22.5, 0],
        scale: [0.5, 0.75, 0.5],
        rightRotation: [11.25, 0, 0],
      },
      billboard: 'vertical',
      brightness: { block: 11, sky: 13 },
      shadow: { radius: 0.375, strength: 0.625 },
      interpolation: { duration: 0, startDelta: 0 },
      itemStack: {
        itemId: 'minecraft:diamond',
        count: 1,
        components: { 'minecraft:enchantment_glint_override': 'true' },
      },
      itemDisplayContext: 'fixed',
    });
    const placementStates = (
      alternateState = 'variant',
      attachments = ['floor', 'wall', 'ceiling'],
    ) =>
      ['north', 'east', 'south', 'west'].flatMap((orientation) =>
        attachments.map((attachment) => ({
          orientation,
          attachment,
          stateId: attachment === 'floor' && orientation !== 'west' ? 'default' : alternateState,
        })),
      );

    let latestCaptureRun = {
      runId: initialDraft.runId,
      specSha256: repairedDraft.specSha256,
    };
    // Each target first exercises its smallest core/default client profile.
    // The existing calls below remain intentionally broad conditional
    // supersets, so the live matrix proves both planner paths independently.
    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_block_default', 'block', {}),
      {
        targetKind: 'block',
        strategy: 'native_block_state',
        capability: 'replacement',
        states: {
          default: { blockState: { id: 'minecraft:stone', properties: {} } },
        },
        review: {
          transparency: false,
          biomeTintBiomes: [],
          animatedTextureTicks: [],
        },
      },
      'block',
      [],
    );
    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_block', 'block', {
        blockReview: { adjacentBlocks: true, lightingChecks: true, cullingChecks: true },
      }),
      {
        targetKind: 'block',
        strategy: 'native_block_state',
        capability: 'replacement',
        states: {
          default: { blockState: { id: 'minecraft:oak_leaves', properties: {} } },
          variant: { blockState: { id: 'minecraft:birch_leaves', properties: {} } },
        },
        review: {
          inventoryItemStack: {
            itemId: 'minecraft:oak_leaves',
            count: 1,
            components: {},
          },
          transparency: true,
          biomeTintBiomes: ['minecraft:plains', 'minecraft:swamp'],
          animatedTextureTicks: [],
        },
      },
      'block',
      [
        'block_inventory',
        'block_transparency_light',
        'block_transparency_dark',
        'block_transparency_overlap',
        'block_biome_0',
        'block_state_variant',
      ],
      {
        alternates: [
          {
            representation: {
              targetKind: 'block',
              strategy: 'block_display',
              capability: 'simulated',
              states: {
                default: {
                  blockDisplay: displayNode('minecraft:oak_planks', [1, 1, 1]),
                },
                variant: {
                  blockDisplay: displayNode('minecraft:glass', [0.75, 1.25, 0.75]),
                },
              },
              review: {
                inventoryItemStack: {
                  itemId: 'minecraft:oak_planks',
                  count: 1,
                  components: {},
                },
                transparency: true,
                biomeTintBiomes: ['minecraft:plains'],
                animatedTextureTicks: [],
              },
            },
            expectedConditionalScenes: [
              'block_inventory',
              'block_transparency_light',
              'block_transparency_dark',
              'block_transparency_overlap',
              'block_state_variant',
            ],
            settlingTicks: 3,
          },
        ],
      },
    );

    const defaultHeadItemModel = '"arcana:capture_head_default"';
    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_head_default', 'head_wearable', {}),
      {
        targetKind: 'headwear',
        strategy: 'equippable_head',
        capability: 'native',
        states: {
          default: {
            itemStack: {
              itemId: 'minecraft:diamond_helmet',
              count: 1,
              components: {
                'minecraft:equippable': '{slot:"head",asset_id:"minecraft:diamond"}',
                'minecraft:item_model': defaultHeadItemModel,
              },
            },
          },
        },
        headwear: { renderMode: 'equipment_model' },
        review: {
          wideFov: false,
          armorStand: true,
          statePoses: { default: 'idle' },
        },
      },
      'headwear',
      [],
    );

    const headItemModel = '"arcana:capture_head"';
    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_head', 'head_wearable', {
        headWearableReview: {
          bodyVariants: ['steve', 'alex'],
          firstPersonObstruction: true,
          armorStand: true,
        },
      }),
      {
        targetKind: 'headwear',
        strategy: 'equippable_head',
        capability: 'replacement',
        states: {
          default: {
            itemStack: {
              itemId: 'minecraft:carved_pumpkin',
              count: 1,
              components: {
                'minecraft:equippable': '{slot:"head",camera_overlay:"minecraft:misc/pumpkinblur"}',
                'minecraft:item_model': headItemModel,
              },
            },
          },
          glint: {
            itemStack: {
              itemId: 'minecraft:carved_pumpkin',
              count: 1,
              components: {
                'minecraft:enchantment_glint_override': 'true',
                'minecraft:equippable': '{slot:"head",camera_overlay:"minecraft:misc/pumpkinblur"}',
                'minecraft:item_model': headItemModel,
              },
            },
          },
        },
        headwear: {
          renderMode: 'fallback_item',
          cameraOverlay: 'minecraft:misc/pumpkinblur',
        },
        review: {
          wideFov: true,
          armorStand: true,
          statePoses: { default: 'idle', glint: 'walk' },
          chestArmorItemStack: {
            itemId: 'minecraft:diamond_chestplate',
            count: 1,
            components: { 'minecraft:enchantment_glint_override': 'true' },
          },
        },
      },
      'headwear',
      [
        'head_first_person_wide',
        'head_stand_front',
        'head_camera_overlay',
        'head_state_glint',
        'head_chest_steve',
        'head_chest_alex',
      ],
      {
        alternates: [
          {
            representation: {
              targetKind: 'headwear',
              strategy: 'equippable_head',
              capability: 'native',
              states: {
                default: {
                  itemStack: {
                    itemId: 'minecraft:diamond_helmet',
                    count: 1,
                    components: {
                      'minecraft:equippable': '{slot:"head",asset_id:"minecraft:diamond"}',
                      'minecraft:item_model': headItemModel,
                    },
                  },
                },
                glint: {
                  itemStack: {
                    itemId: 'minecraft:diamond_helmet',
                    count: 1,
                    components: {
                      'minecraft:enchantment_glint_override': 'true',
                      'minecraft:equippable': '{slot:"head",asset_id:"minecraft:diamond"}',
                      'minecraft:item_model': headItemModel,
                    },
                  },
                },
              },
              headwear: { renderMode: 'equipment_model' },
              review: {
                wideFov: true,
                armorStand: true,
                statePoses: { default: 'idle', glint: 'walk' },
              },
            },
            expectedConditionalScenes: [
              'head_first_person_wide',
              'head_stand_front',
              'head_state_glint',
            ],
          },
        ],
      },
    );

    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_entity_default', 'entity_model', {}),
      {
        targetKind: 'entity',
        strategy: 'native_entity',
        capability: 'replacement',
        states: {
          default: {
            entity: {
              entityType: 'minecraft:zombie',
              baby: false,
              equipment: {},
            },
          },
        },
        review: { lowLight: false, animationTicks: [5] },
      },
      'entity',
      [],
    );

    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_entity', 'entity_model', {
        entityModelReview: {
          hitbox: [8, 16, 8],
          animationPoses: ['idle', 'walking', 'attacking'],
          playerScaleReference: true,
        },
      }),
      {
        targetKind: 'entity',
        strategy: 'native_entity',
        capability: 'replacement',
        states: {
          default: {
            entity: {
              entityType: 'minecraft:zombie',
              baby: false,
              equipment: {
                head: {
                  itemId: 'minecraft:diamond_helmet',
                  count: 1,
                  components: { 'minecraft:enchantment_glint_override': 'true' },
                },
                mainhand: { itemId: 'minecraft:iron_sword', count: 1, components: {} },
              },
            },
          },
          variant_adult: {
            entity: {
              entityType: 'minecraft:wolf',
              variant: 'minecraft:pale',
              baby: false,
              equipment: {},
            },
          },
          variant_baby: {
            entity: {
              entityType: 'minecraft:wolf',
              variant: 'minecraft:woods',
              baby: true,
              equipment: {},
            },
          },
        },
        review: { lowLight: true, animationTicks: [5, 10] },
      },
      'entity',
      [
        'entity_walk_sample_1',
        'entity_state_variant_adult',
        'entity_state_variant_baby',
        'entity_low_light',
      ],
      {
        debug: true,
        alternates: [
          {
            representation: {
              targetKind: 'entity',
              strategy: 'display_rig',
              capability: 'simulated',
              states: {
                attack: {
                  displayRig: {
                    nodes: [displayNode('minecraft:redstone_block', [1.2, 0.8, 1])],
                    interaction: {
                      position: [0, 0, 0],
                      width: 1,
                      height: 1,
                      response: false,
                    },
                  },
                },
                idle: {
                  displayRig: {
                    nodes: [displayNode('minecraft:oak_planks', [1, 1, 1])],
                    interaction: {
                      position: [0, 0, 0],
                      width: 1,
                      height: 1,
                      response: false,
                    },
                  },
                },
                variant: {
                  displayRig: {
                    nodes: [displayNode('minecraft:glass', [0.75, 1.25, 0.75])],
                    interaction: {
                      position: [0, 0, 0],
                      width: 1,
                      height: 1,
                      response: false,
                    },
                  },
                },
                walk: {
                  displayRig: {
                    nodes: [displayNode('minecraft:stone', [1, 0.75, 1])],
                    interaction: {
                      position: [0, 0, 0],
                      width: 1,
                      height: 1,
                      response: false,
                    },
                  },
                },
              },
              review: {
                lowLight: true,
                animationTicks: [],
                poseStates: { idle: 'idle', walk: 'walk', attack: 'attack' },
              },
            },
            expectedConditionalScenes: [
              'entity_pose_idle',
              'entity_pose_walk',
              'entity_pose_attack',
              'entity_state_variant',
              'entity_low_light',
            ],
            debug: true,
            settlingTicks: 3,
          },
        ],
      },
    );

    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_placeable_default', 'placeable', {
        placeableReview: {
          orientations: ['north', 'east', 'south', 'west'],
          attachments: ['floor'],
          footprint: [16, 16],
        },
      }),
      {
        targetKind: 'placeable',
        strategy: 'display_rig',
        capability: 'simulated',
        states: {
          default: {
            displayRig: {
              nodes: [displayNode('minecraft:oak_planks', [1, 1, 1])],
              interaction: {
                position: [0, 0, 0],
                width: 1,
                height: 1,
                response: false,
              },
            },
          },
        },
        review: {
          orientations: ['north', 'east', 'south', 'west'],
          attachments: ['floor'],
          placementStates: placementStates('default', ['floor']),
        },
      },
      'placeable',
      [],
      { settlingTicks: 3 },
    );

    latestCaptureRun = await captureProtocolV3Profile(
      application,
      latestCaptureRun,
      clientCaptureFixtureSpec('arcana:capture_placeable', 'placeable', {
        placeableReview: {
          orientations: ['north', 'east', 'south', 'west'],
          attachments: ['floor', 'wall', 'ceiling'],
          footprint: [16, 16],
        },
      }),
      {
        targetKind: 'placeable',
        strategy: 'display_rig',
        capability: 'simulated',
        states: {
          default: {
            displayRig: {
              nodes: [displayNode('minecraft:oak_planks', [1, 1, 1]), itemDisplayNode()],
              interaction: {
                position: [0.125, 0.25, -0.125],
                width: 1.25,
                height: 1.75,
                response: false,
              },
            },
          },
          variant: {
            displayRig: {
              nodes: [displayNode('minecraft:glass', [0.75, 1.25, 0.75])],
              interaction: { position: [0, 0, 0], width: 1, height: 1, response: false },
            },
          },
        },
        review: {
          orientations: ['north', 'east', 'south', 'west'],
          attachments: ['floor', 'wall', 'ceiling'],
          placementStates: placementStates(),
        },
      },
      'placeable',
      ['place_wall_contact', 'place_ceiling_contact', 'place_state_variant'],
      {
        debug: true,
        settlingTicks: 4,
        alternates: [
          {
            representation: {
              targetKind: 'placeable',
              strategy: 'native_placeable_block',
              capability: 'replacement',
              states: {
                east: {
                  blockState: {
                    id: 'minecraft:oak_stairs',
                    properties: {
                      facing: 'east',
                      half: 'bottom',
                      shape: 'straight',
                      waterlogged: 'false',
                    },
                  },
                },
                north: {
                  blockState: {
                    id: 'minecraft:oak_stairs',
                    properties: {
                      facing: 'north',
                      half: 'bottom',
                      shape: 'straight',
                      waterlogged: 'false',
                    },
                  },
                },
                south: {
                  blockState: {
                    id: 'minecraft:oak_stairs',
                    properties: {
                      facing: 'south',
                      half: 'bottom',
                      shape: 'straight',
                      waterlogged: 'false',
                    },
                  },
                },
                west: {
                  blockState: {
                    id: 'minecraft:oak_stairs',
                    properties: {
                      facing: 'west',
                      half: 'bottom',
                      shape: 'straight',
                      waterlogged: 'false',
                    },
                  },
                },
              },
              review: {
                orientations: ['north', 'east', 'south', 'west'],
                attachments: ['floor'],
                placementStates: [
                  { orientation: 'north', attachment: 'floor', stateId: 'north' },
                  { orientation: 'east', attachment: 'floor', stateId: 'east' },
                  { orientation: 'south', attachment: 'floor', stateId: 'south' },
                  { orientation: 'west', attachment: 'floor', stateId: 'west' },
                ],
              },
            },
            expectedConditionalScenes: [
              'place_state_north',
              'place_state_south',
              'place_state_west',
            ],
          },
          {
            representation: {
              targetKind: 'placeable',
              strategy: 'native_placeable_entity',
              capability: 'native',
              states: {
                default: {
                  entity: {
                    entityType: 'minecraft:armor_stand',
                    baby: false,
                    equipment: {},
                  },
                },
                variant: {
                  entity: {
                    entityType: 'minecraft:armor_stand',
                    baby: false,
                    equipment: {
                      head: {
                        itemId: 'minecraft:carved_pumpkin',
                        count: 1,
                        components: {},
                      },
                    },
                  },
                },
              },
              review: {
                orientations: ['north', 'east', 'south', 'west'],
                attachments: ['floor'],
                placementStates: placementStates('variant', ['floor']),
              },
            },
            expectedConditionalScenes: ['place_state_variant'],
          },
        ],
      },
    );
    requireCondition(
      latestCaptureRun.runId.length === 64 && latestCaptureRun.specSha256.length === 64,
      'The protocol-v3 target capture matrix did not finish on an immutable revision.',
    );
  }
  process.stderr.write(
    runClientCapture
      ? 'Packwright Minecraft 26.2 datapack and official-client paired visual acceptance flows passed.\n'
      : 'Packwright Minecraft 26.2 datapack and server-side paired proposal acceptance flows passed; official client capture was explicitly skipped.\n',
  );
} finally {
  if (keepIntegrationWorkspace) {
    process.stderr.write(`Retained Packwright integration workspace: ${workspaceRoot}\n`);
  } else {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
