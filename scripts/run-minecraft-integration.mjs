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
  VisualConnectInputSchema,
  VisualProjectAttachInputSchema,
  VisualRenderInputSchema,
  VisualRevisionCreateInputSchema,
  VisualSpecUpsertInputSchema,
  VisualValidateInputSchema,
} from '../dist/mcp/visual-schemas.js';
import { setupVersion } from '../dist/minecraft/cache.js';
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
        typeof vanillaClientCapture.reportSha256 === 'string' &&
        vanillaClientCapture.requiredViewIds.length === 15 &&
        vanillaClientCapture.supplementalViewIds.length === 0 &&
        vanillaClientCapture.scaleReferenceContactSheet === undefined &&
        vanillaClientCapture.scaleReferenceContactSheetUri === undefined,
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
        clientCapture.scaleReferenceContactSheet !== undefined &&
        clientCapture.scaleReferenceContactSheetUri !== undefined &&
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
  }
  process.stderr.write(
    runClientCapture
      ? 'Packwright Minecraft 26.2 datapack and official-client paired visual acceptance flows passed.\n'
      : 'Packwright Minecraft 26.2 datapack and server-side paired proposal acceptance flows passed; official client capture was explicitly skipped.\n',
  );
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
