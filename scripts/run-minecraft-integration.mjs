import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  Workspace,
  buildDatapack,
  createDatapack,
  upsertResource,
  validateDatapack,
} from '../dist/core/index.js';
import { setupVersion } from '../dist/minecraft/cache.js';
import { runGameTests } from '../dist/minecraft/gametest.js';
import { runProcess } from '../dist/runtime/process.js';

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
const config = {
  workspaceRoot,
  cacheDir,
  javaCommand: process.env.PACKWRIGHT_JAVA ?? 'java',
  readOnly: false,
  offline: false,
};

/**
 * @param {{ readonly ok: boolean }} result
 * @param {string} stage
 */
function requireSuccess(result, stage) {
  if (!result.ok) {
    throw new Error(`${stage} failed:\n${JSON.stringify(result, null, 2)}`);
  }
}

try {
  await setupVersion(config, true);
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
      type: 'function',
      id: 'packwright_acceptance:gametest',
      content: 'return 1\n',
    }),
    'GameTest function upsert',
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
          function: 'packwright_acceptance:gametest',
        },
        null,
        2,
      )}\n`,
    }),
    'GameTest instance upsert',
  );

  requireSuccess(await validateDatapack(workspace, 'acceptance'), 'validate');
  requireSuccess(
    await runGameTests(config, workspace, {
      project: 'acceptance',
      tests: ['packwright_acceptance:smoke'],
      timeoutMs: 300_000,
    }),
    'source GameTest',
  );

  const archive = await buildDatapack(workspace, 'acceptance', {
    outputPath: 'build/acceptance.zip',
  });
  requireSuccess(archive, 'build');

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
  process.stderr.write('Packwright Minecraft 26.2 acceptance flow passed.\n');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
