import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatapack, upsertResource } from '../../src/core/authoring.js';
import { scanDatapack } from '../../src/core/scanner.js';
import type { ProcessResult, RunProcessOptions } from '../../src/runtime/process.js';
import {
  copyVerifiedServerJar,
  getCacheStatus,
  loadReferenceCache,
} from '../../src/minecraft/cache.js';
import { runVanillaCommandValidation } from '../../src/minecraft/command-validation.js';
import { getJavaVersion } from '../../src/minecraft/java.js';
import { runProcess } from '../../src/runtime/process.js';
import { temporaryWorkspace } from '../core/helpers.js';

vi.mock('../../src/minecraft/cache.js', () => ({
  copyVerifiedServerJar: vi.fn(),
  getCacheStatus: vi.fn(),
  loadReferenceCache: vi.fn(),
}));

vi.mock('../../src/minecraft/java.js', () => ({ getJavaVersion: vi.fn() }));

vi.mock('../../src/runtime/process.js', () => ({ runProcess: vi.fn() }));

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

function completedProcess(): ProcessResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
  };
}

describe('vanilla command validation staging', () => {
  it('skips an oversized probe while still staging and diagnosing the following command', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Oversized command isolation fixture',
    });
    await upsertResource(fixture.workspace, 'pack', {
      type: 'function',
      id: 'demo:load',
      content: `${'a'.repeat(2_000_001)}\nelectrify @s`,
    });
    const scan = await scanDatapack(fixture.workspace, 'pack');

    vi.mocked(getCacheStatus).mockResolvedValue({
      ready: true,
      jar: true,
      jarVerified: true,
      versionMetadata: true,
      versionMetadataVerified: true,
      acceptedEula: true,
      commands: true,
      registries: true,
    });
    vi.mocked(getJavaVersion).mockResolvedValue({
      available: true,
      major: 25,
      description: 'Java 25',
    });
    vi.mocked(copyVerifiedServerJar).mockImplementation(async (_cacheDir, destination) => {
      await writeFile(destination, 'test server jar');
    });
    vi.mocked(loadReferenceCache).mockResolvedValue({
      commands: { type: 'root', children: { execute: {} } },
      registries: {},
    });
    vi.mocked(runProcess).mockImplementation(async (options: RunProcessOptions) => {
      const args = options.args ?? [];
      const packsIndex = args.indexOf('--packs');
      const reportIndex = args.indexOf('--report');
      expect(packsIndex).toBeGreaterThanOrEqual(0);
      expect(reportIndex).toBeGreaterThanOrEqual(0);
      const packsDir = args[packsIndex + 1];
      const report = args[reportIndex + 1];
      expect(packsDir).toBeDefined();
      expect(report).toBeDefined();
      if (packsDir === undefined || report === undefined || options.cwd === undefined) {
        throw new Error('Expected command-validation process paths.');
      }

      const harness = path.join(packsDir, 'packwright-validation-harness');
      const namespaces = await readdir(path.join(harness, 'data'));
      expect(namespaces).toHaveLength(1);
      const namespace = namespaces[0];
      if (namespace === undefined) throw new Error('Expected generated harness namespace.');
      const functionDir = path.join(harness, 'data', namespace, 'function');

      await expect(access(path.join(functionDir, 'probe_00000.mcfunction'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(path.join(functionDir, 'probe_00001.mcfunction'), 'utf8'),
      ).resolves.toBe('electrify @s\n');

      await writeFile(
        report,
        `<testsuite><testcase classname="minecraft:empty" name="${namespace}:command_validation" time="0.001"/></testsuite>`,
      );
      await mkdir(path.join(options.cwd, 'logs'), { recursive: true });
      await writeFile(
        path.join(options.cwd, 'logs', 'latest.log'),
        [
          `[12:00:00] [ServerMain/ERROR]: Failed to load function ${namespace}:probe_00001`,
          '\tjava.util.concurrent.CompletionException: java.lang.IllegalArgumentException',
          '\tCaused by: java.lang.IllegalArgumentException: Whilst parsing command on line 1: Unknown or incomplete command, see below for error at position 0: ...<--[HERE]',
        ].join('\n'),
      );
      return completedProcess();
    });

    const result = await runVanillaCommandValidation(
      {
        workspaceRoot: fixture.root,
        cacheDir: path.join(fixture.root, '.cache'),
        javaCommand: 'java',
        readOnly: false,
        offline: true,
      },
      fixture.workspace,
      'pack',
      scan,
      { timeoutMs: 5_000 },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      filesChecked: 1,
      commandLinesChecked: 1,
      macroLinesDeferred: 0,
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'minecraft.command.too_long',
          path: 'data/demo/function/load.mcfunction',
        }),
        expect.objectContaining({
          code: 'minecraft.command.unknown_command',
          message: 'Unknown command `electrify`',
          path: 'data/demo/function/load.mcfunction',
        }),
      ]),
    );
    expect(
      result.diagnostics.find((diagnostic) => diagnostic.code === 'minecraft.command.too_long')
        ?.range?.start,
    ).toEqual({ line: 0, character: 0 });
    expect(
      result.diagnostics.find(
        (diagnostic) => diagnostic.code === 'minecraft.command.unknown_command',
      )?.range?.start,
    ).toEqual({ line: 1, character: 0 });
    expect(runProcess).toHaveBeenCalledTimes(1);
  });
});
