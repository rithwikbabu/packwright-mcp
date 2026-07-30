import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';

import { PackwrightError } from '../core/errors.js';
import { joinRelative } from '../core/files.js';
import { isValidResourceId } from '../core/identifiers.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES } from '../core/limits.js';
import { assertScanSnapshotUnchanged, scanDatapack, type ScanResult } from '../core/scanner.js';
import { readStableFile } from '../core/stable-file.js';
import type { Diagnostic, GameTestCaseResult, GameTestResult } from '../core/types.js';
import type { Workspace } from '../core/workspace.js';
import type { RuntimeConfig } from '../config.js';
import { runProcess } from '../runtime/process.js';
import { copyVerifiedServerJar, getCacheStatus } from './cache.js';
import { getJavaVersion } from './java.js';

interface RunGameTestsInput {
  readonly project: string;
  readonly tests?: readonly string[];
  readonly timeoutMs: number;
}

type XmlObject = Readonly<Record<string, unknown>>;

function asObject(value: unknown): XmlObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlObject)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const object = asObject(value);
  const text = object?.['#text'];
  return typeof text === 'string' || typeof text === 'number' ? String(text) : undefined;
}

export function parseGameTestCases(xml: string): GameTestCaseResult[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const document = asObject(parser.parse(xml));
  const pending = [
    ...asArray(asObject(document?.testsuites)?.testsuite),
    ...asArray(document?.testsuite),
  ];
  const cases: GameTestCaseResult[] = [];
  let suitesVisited = 0;
  while (pending.length > 0) {
    const suite = asObject(pending.shift());
    if (suite === undefined) continue;
    suitesVisited += 1;
    if (suitesVisited > 10_000) throw new Error('GameTest XML contains too many test suites.');
    pending.push(...asArray(suite.testsuite));
    for (const rawCase of asArray(suite.testcase)) {
      const item = asObject(rawCase);
      if (item === undefined) continue;
      const rawName = item['@_name'];
      const rawClass = item['@_classname'];
      const name = [rawClass, rawName]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(':');
      const failure = item.failure ?? item.error;
      const skipped = item.skipped;
      const seconds = Number(item['@_time'] ?? Number.NaN);
      const result: GameTestCaseResult = {
        name: name || 'unnamed_gametest',
        status: failure === undefined ? (skipped === undefined ? 'passed' : 'skipped') : 'failed',
      };
      if (Number.isFinite(seconds) && seconds >= 0) {
        result.durationMs = Math.round(seconds * 1_000);
      }
      const message = textValue(failure) ?? textValue(skipped);
      if (message !== undefined) result.message = message;
      cases.push(result);
    }
  }
  return cases;
}

function setupRequired(message: string, durationMs = 0): GameTestResult {
  return {
    ok: false,
    status: 'setup_required',
    durationMs,
    tests: [],
    diagnostics: [
      {
        engine: 'minecraft',
        authority: 'authoritative',
        severity: 'information',
        code: 'minecraft.setup_required',
        message,
      },
    ],
  };
}

export async function stageDatapackFromSnapshot(
  workspace: Workspace,
  project: string,
  destination: string,
  scan: ScanResult,
  signal?: AbortSignal,
): Promise<void> {
  if (scan.entries.length > MAX_SCAN_FILES || scan.totalBytes > MAX_SCAN_BYTES) {
    throw new PackwrightError('scan_limit', 'Datapack exceeds the GameTest staging limits.');
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let bytesCopied = 0;
  for (const entry of scan.entries) {
    if (signal?.aborted) {
      throw new PackwrightError('cancelled', 'GameTest staging was cancelled.');
    }
    const source = await workspace.resolve(joinRelative(project, entry.path), {
      mustExist: true,
      rejectSymlinks: true,
    });
    const stable = await readStableFile(source, {
      maxBytes: entry.size,
      expected: entry,
      collect: true,
      ...(signal === undefined ? {} : { signal }),
      pathLabel: entry.path,
    });
    if (stable.data === undefined) {
      throw new PackwrightError('precondition_failed', 'Stable GameTest read returned no data.', {
        path: entry.path,
      });
    }
    bytesCopied += stable.data.length;
    if (bytesCopied > MAX_SCAN_BYTES) {
      throw new PackwrightError('scan_limit', 'Datapack exceeds the GameTest byte limit.');
    }
    const target = path.join(destination, ...entry.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, stable.data, { flag: 'wx', mode: 0o600 });
  }
  if (bytesCopied !== scan.totalBytes) {
    throw new PackwrightError('precondition_failed', 'Datapack size changed during staging.');
  }
}

async function copyPack(
  workspace: Workspace,
  project: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const scan = await scanDatapack(workspace, project, { signal });
  await stageDatapackFromSnapshot(workspace, project, destination, scan, signal);
  assertScanSnapshotUnchanged(scan, await scanDatapack(workspace, project, { signal }));
}

function appendBounded(current: string, next: string, limit = 512 * 1024): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, 'utf8') <= limit) return combined;
  return Buffer.from(combined, 'utf8').subarray(0, limit).toString('utf8');
}

export async function runGameTests(
  config: RuntimeConfig,
  workspace: Workspace,
  input: RunGameTestsInput,
  signal?: AbortSignal,
): Promise<GameTestResult> {
  const startedAt = Date.now();
  if (input.tests?.length === 0) {
    throw new PackwrightError(
      'invalid_argument',
      'GameTest selections must be omitted or contain at least one exact resource ID.',
    );
  }
  for (const selection of input.tests ?? []) {
    if (!isValidResourceId(selection)) {
      throw new PackwrightError(
        'invalid_resource_id',
        `Invalid exact GameTest resource ID: ${selection}`,
      );
    }
  }
  const status = await getCacheStatus(config.cacheDir, true);
  if (Date.now() - startedAt >= input.timeoutMs) {
    return {
      ok: false,
      status: 'timeout',
      durationMs: Date.now() - startedAt,
      tests: [],
      diagnostics: [
        {
          engine: 'minecraft',
          authority: 'authoritative',
          severity: 'error',
          code: 'minecraft.timeout',
          message: `GameTests exceeded the ${String(input.timeoutMs)} ms timeout.`,
        },
      ],
    };
  }
  if (!status.ready) {
    return setupRequired(
      'Minecraft 26.2 is not prepared. A human operator must run setup-version 26.2 --accept-minecraft-eula.',
      Date.now() - startedAt,
    );
  }
  const java = await getJavaVersion(
    config.javaCommand,
    signal,
    Math.max(1, Math.min(10_000, input.timeoutMs - (Date.now() - startedAt))),
  );
  if (Date.now() - startedAt >= input.timeoutMs) {
    return {
      ok: false,
      status: 'timeout',
      durationMs: Date.now() - startedAt,
      tests: [],
      diagnostics: [
        {
          engine: 'minecraft',
          authority: 'authoritative',
          severity: 'error',
          code: 'minecraft.timeout',
          message: `GameTests exceeded the ${String(input.timeoutMs)} ms timeout.`,
        },
      ],
    };
  }
  if (!java.available || java.major !== 25) {
    return setupRequired(
      `Java 25 is required for GameTests; ${java.description}.`,
      Date.now() - startedAt,
    );
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'packwright-gametest-'));
  const packsDir = path.join(temporaryRoot, 'packs');
  const stagedPack = path.join(packsDir, 'packwright-under-test');
  const stagedServerJar = path.join(temporaryRoot, 'server.jar');
  const reportsDir = path.join(temporaryRoot, 'reports');
  let stdout = '';
  let stderr = '';
  const tests: GameTestCaseResult[] = [];
  const diagnostics: Diagnostic[] = [];
  let lastExitCode: number | undefined;

  try {
    await mkdir(reportsDir, { recursive: true, mode: 0o700 });
    await copyVerifiedServerJar(config.cacheDir, stagedServerJar, signal);
    await copyPack(workspace, input.project, stagedPack, signal);
    await writeFile(path.join(temporaryRoot, 'eula.txt'), 'eula=true\n', {
      mode: 0o600,
    });

    // The official runner accepts one wildcard selection. Run exact selections
    // independently so an array cannot accidentally broaden what is executed.
    const selections: (string | undefined)[] =
      input.tests === undefined || input.tests.length === 0 ? [undefined] : [...input.tests];
    for (let index = 0; index < selections.length; index += 1) {
      const elapsed = Date.now() - startedAt;
      const remaining = input.timeoutMs - elapsed;
      if (remaining <= 0) {
        return {
          ok: false,
          status: 'timeout',
          durationMs: elapsed,
          tests,
          diagnostics: [
            ...diagnostics,
            {
              engine: 'minecraft',
              authority: 'authoritative',
              severity: 'error',
              code: 'minecraft.timeout',
              message: `GameTests exceeded the ${String(input.timeoutMs)} ms timeout.`,
            },
          ],
          stdout,
          stderr,
        };
      }
      const report = path.join(reportsDir, `report-${String(index)}.xml`);
      const universe = path.join(temporaryRoot, `universe-${String(index)}`);
      const args = [
        '-DbundlerMainClass=net.minecraft.gametest.Main',
        '-jar',
        stagedServerJar,
        '--packs',
        packsDir,
        '--report',
        report,
        '--universe',
        universe,
        '--verify',
        'false',
      ];
      const selection = selections[index];
      if (selection !== undefined) args.push('--tests', selection);

      const result = await runProcess({
        command: config.javaCommand,
        args,
        cwd: temporaryRoot,
        timeoutMs: remaining,
        ...(signal === undefined ? {} : { signal }),
      });
      stdout = appendBounded(stdout, result.stdout);
      stderr = appendBounded(stderr, result.stderr);
      lastExitCode = result.exitCode;

      if (result.cancelled) {
        return {
          ok: false,
          status: 'cancelled',
          durationMs: Date.now() - startedAt,
          ...(lastExitCode === undefined ? {} : { exitCode: lastExitCode }),
          tests,
          diagnostics,
          stdout,
          stderr,
        };
      }
      if (result.timedOut) {
        return {
          ok: false,
          status: 'timeout',
          durationMs: Date.now() - startedAt,
          ...(lastExitCode === undefined ? {} : { exitCode: lastExitCode }),
          tests,
          diagnostics: [
            ...diagnostics,
            {
              engine: 'minecraft',
              authority: 'authoritative',
              severity: 'error',
              code: 'minecraft.timeout',
              message: `GameTests exceeded the ${String(input.timeoutMs)} ms timeout.`,
            },
          ],
          stdout,
          stderr,
        };
      }

      try {
        tests.push(...parseGameTestCases(await readFile(report, 'utf8')));
      } catch (error) {
        diagnostics.push({
          engine: 'minecraft',
          authority: 'authoritative',
          severity: result.exitCode === 0 ? 'warning' : 'error',
          code: 'minecraft.report_unavailable',
          message: `Could not parse the GameTest XML report: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (result.exitCode !== 0) {
        diagnostics.push({
          engine: 'minecraft',
          authority: 'authoritative',
          severity: 'error',
          code: 'minecraft.nonzero_exit',
          message: `Minecraft GameTest exited with code ${String(result.exitCode)}.`,
        });
        break;
      }
    }

    const failed = tests.some((test) => test.status === 'failed');
    const ok =
      lastExitCode === 0 && !failed && !diagnostics.some((item) => item.severity === 'error');
    return {
      ok,
      status: ok ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      ...(lastExitCode === undefined ? {} : { exitCode: lastExitCode }),
      tests,
      diagnostics,
      stdout,
      stderr,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export { parseGameTestCases as parseGameTestReport };
