import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { RuntimeConfig } from '../config.js';
import { PackwrightError } from '../core/errors.js';
import { MAX_SCAN_BYTES, MAX_SCAN_FILES, MAX_TEXT_WRITE_BYTES } from '../core/limits.js';
import { assertScanSnapshotUnchanged, scanDatapack, type ScanResult } from '../core/scanner.js';
import { readStableFile } from '../core/stable-file.js';
import type {
  Diagnostic,
  SourcePosition,
  SourceRange,
  ValidationAdapter,
  ValidationAdapterContext,
  VanillaValidationSummary,
} from '../core/types.js';
import { createPackMetadata } from '../core/version.js';
import type { Workspace } from '../core/workspace.js';
import { runProcess } from '../runtime/process.js';
import {
  copyVerifiedServerJar,
  getCacheStatus,
  loadReferenceCache,
  type ReferenceCache,
} from './cache.js';
import { parseGameTestCases, stageDatapackFromSnapshot } from './gametest.js';
import { getJavaVersion } from './java.js';

const MAX_COMMAND_PROBES = 20_000;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_COMMAND_LENGTH = 2_000_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const LOG_EVENT = /^\[[^\]\r\n]+\] \[[^\]\r\n]+\]:/u;
const FAILED_FUNCTION =
  /^\[[^\]\r\n]+\] \[[^\]\r\n]+\]: Failed to load function ([a-z0-9_.-]+:[a-z0-9_./-]+)\s*$/u;

export interface LogicalCommandSegment {
  readonly sourceLine: number;
  readonly sourceCharacter: number;
  readonly commandStart: number;
  readonly text: string;
}

export interface LogicalCommand {
  readonly sourcePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly command: string;
  readonly macro: boolean;
  readonly exceededLengthLimit: boolean;
  readonly segments: readonly LogicalCommandSegment[];
}

interface CommandProbe extends LogicalCommand {
  readonly id: string;
}

export interface VanillaCommandValidationResult extends VanillaValidationSummary {
  readonly ok: boolean;
  readonly diagnostics: Diagnostic[];
}

export interface RunVanillaCommandValidationOptions {
  readonly timeoutMs?: number;
}

export function decodeFunctionText(bytes: Uint8Array): string {
  // InputStreamReader preserves a leading U+FEFF; ignoreBOM:true makes the
  // WHATWG decoder match that behavior instead of silently stripping it.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PackwrightError('cancelled', 'Vanilla command validation was cancelled.');
  }
}

function javaTrim(raw: string): { readonly text: string; readonly start: number } {
  let start = 0;
  let end = raw.length;
  while (start < end && (raw.charCodeAt(start) || 0) <= 0x20) start += 1;
  while (end > start && (raw.charCodeAt(end - 1) || 0) <= 0x20) end -= 1;
  return { text: raw.slice(start, end), start };
}

/**
 * Reproduce Minecraft's physical-line handling for functions: blank and comment
 * lines are skipped, while a trailing backslash joins the next trimmed line
 * without inserting whitespace.
 */
export function extractLogicalCommands(content: string, sourcePath: string): LogicalCommand[] {
  const physicalLines = content.split(/\r\n|\n|\r/u);
  // Java's line reader does not manufacture an extra physical line after the
  // final line terminator. Remove only that split sentinel; earlier blank lines
  // remain significant continuation targets.
  if (physicalLines.at(-1) === '' && /(?:\r\n|\n|\r)$/u.test(content)) physicalLines.pop();
  const commands: LogicalCommand[] = [];
  for (let line = 0; line < physicalLines.length; line += 1) {
    const startLine = line;
    let combined = '';
    let exceededLengthLimit = false;
    let unterminatedContinuation = false;
    const segments: LogicalCommandSegment[] = [];

    for (;;) {
      const trimmed = javaTrim(physicalLines[line] ?? '');
      const continues = trimmed.text.endsWith('\\');
      const hasNextLine = line + 1 < physicalLines.length;
      const text = continues && hasNextLine ? trimmed.text.slice(0, -1) : trimmed.text;
      segments.push({
        sourceLine: line,
        sourceCharacter: trimmed.start,
        commandStart: combined.length,
        text,
      });
      combined += text;

      if (!continues) {
        exceededLengthLimit ||= combined.length > MAX_COMMAND_LENGTH;
        break;
      }
      if (!hasNextLine) {
        unterminatedContinuation = true;
        break;
      }

      line += 1;
      const next = javaTrim(physicalLines[line] ?? '');
      // Minecraft checks the builder after appending each continued physical
      // line, before deciding whether another continuation follows.
      exceededLengthLimit ||= combined.length + next.text.length > MAX_COMMAND_LENGTH;
    }

    // Minecraft resolves continuations and enforces the length limit before it
    // decides whether the resulting line is blank or a comment.
    if (
      !unterminatedContinuation &&
      !exceededLengthLimit &&
      (combined.length === 0 || combined.startsWith('#'))
    ) {
      continue;
    }
    commands.push({
      sourcePath,
      startLine,
      endLine: line,
      command: combined,
      macro: combined.startsWith('$'),
      exceededLengthLimit,
      segments,
    });
  }
  return commands;
}

function positionAt(command: LogicalCommand, offset: number): SourcePosition {
  const bounded = Math.max(0, Math.min(offset, command.command.length));
  const segment =
    command.segments.find(
      (candidate, index) =>
        bounded < candidate.commandStart + candidate.text.length ||
        index === command.segments.length - 1,
    ) ?? command.segments.at(-1);
  if (segment === undefined) return { line: command.startLine, character: 0 };
  return {
    line: segment.sourceLine,
    character:
      segment.sourceCharacter +
      Math.max(0, Math.min(bounded - segment.commandStart, segment.text.length)),
  };
}

function tokenStartNearestCursor(command: string, token: string, cursor: number): number {
  let best = -1;
  let bestContains = false;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let start = command.indexOf(token); start >= 0; start = command.indexOf(token, start + 1)) {
    const end = start + token.length;
    const contains = cursor >= start && cursor <= end;
    const distance = contains ? 0 : Math.min(Math.abs(cursor - start), Math.abs(cursor - end));
    if (
      best < 0 ||
      (contains && !bestContains) ||
      (contains === bestContains && distance < bestDistance) ||
      (contains === bestContains && distance === bestDistance && start > best)
    ) {
      best = start;
      bestContains = contains;
      bestDistance = distance;
    }
  }
  return best;
}

function rangeFor(command: LogicalCommand, token: string | undefined, cursor: number): SourceRange {
  const tokenStart =
    token === undefined ? -1 : tokenStartNearestCursor(command.command, token, cursor);
  let start = tokenStart;
  if (start < 0) start = Math.max(0, Math.min(cursor, command.command.length));
  const end = token === undefined || tokenStart < 0 ? start + 1 : start + token.length;
  return {
    start: positionAt(command, start),
    end: positionAt(command, Math.min(end, command.command.length)),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function registryCandidates(cache: ReferenceCache | undefined, registry: string): string[] {
  const registries = asObject(cache?.registries);
  const normalized = registry.includes(':') ? registry : `minecraft:${registry}`;
  const report = asObject(registries?.[normalized] ?? registries?.[registry]);
  return Object.keys(asObject(report?.entries) ?? {}).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

function commandCandidates(cache: ReferenceCache | undefined): string[] {
  return Object.keys(asObject(asObject(cache?.commands)?.children) ?? {}).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function comparisonName(identifier: string): string {
  return identifier.startsWith('minecraft:') ? identifier.slice('minecraft:'.length) : identifier;
}

export function suggestIdentifier(
  invalid: string,
  candidates: readonly string[],
): string | undefined {
  if (candidates.length === 0) return undefined;
  const needle = comparisonName(invalid);
  const prefix = candidates
    .filter((candidate) => candidate !== invalid && comparisonName(candidate).startsWith(needle))
    .sort((left, right) => {
      const length = comparisonName(left).length - comparisonName(right).length;
      return length || left.localeCompare(right, 'en');
    })[0];
  if (prefix !== undefined && comparisonName(prefix).length - needle.length <= 12) {
    return prefix;
  }
  let best: { candidate: string; distance: number; name: string } | undefined;
  for (const candidate of candidates) {
    if (candidate === invalid) continue;
    const name = comparisonName(candidate);
    const distance = levenshtein(needle, name);
    if (
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && candidate.localeCompare(best.candidate, 'en') < 0)
    ) {
      best = { candidate, distance, name };
    }
  }
  if (best === undefined) return undefined;
  const longest = Math.max(needle.length, best.name.length, 1);
  const prefixMatch = best.name.startsWith(needle) || needle.startsWith(best.name);
  if (!prefixMatch && best.distance / longest > 0.4 && best.distance > 2) return undefined;
  if (prefixMatch && Math.abs(best.name.length - needle.length) > 12) return undefined;
  return best.candidate;
}

interface NormalizedFailure {
  readonly code: string;
  readonly message: string;
  readonly token?: string;
  readonly candidates: readonly string[];
}

function normalizeFailure(
  raw: string,
  command: LogicalCommand,
  cache: ReferenceCache | undefined,
): NormalizedFailure {
  const particle = /^Unknown particle:\s*([^\s]+)$/u.exec(raw);
  if (particle?.[1] !== undefined) {
    return {
      code: 'minecraft.command.unknown_particle',
      message: `Unknown particle \`${particle[1]}\``,
      token: particle[1],
      candidates: registryCandidates(cache, 'particle_type'),
    };
  }

  const element = /^Can't find element '([^']+)' of type '([^']+)'$/u.exec(raw);
  if (element?.[1] !== undefined && element[2] !== undefined) {
    const registry = element[2];
    const label = registry.replace(/^minecraft:/u, '').replaceAll('_', ' ');
    return {
      code: `minecraft.command.unknown_${registry.replace(/^minecraft:/u, '').replaceAll(':', '_')}`,
      message: `Unknown ${label} \`${element[1]}\``,
      token: element[1],
      candidates: registryCandidates(cache, registry),
    };
  }

  const entity = /^(?:Invalid or unknown|Unknown) entity type ['"]?([^'"\s]+)['"]?$/u.exec(raw);
  if (entity?.[1] !== undefined) {
    return {
      code: 'minecraft.command.unknown_entity_type',
      message: `Unknown entity type \`${entity[1]}\``,
      token: entity[1],
      candidates: registryCandidates(cache, 'entity_type'),
    };
  }

  if (raw.startsWith('Unknown or incomplete command')) {
    const literal = /^([^\s]+)/u.exec(command.command)?.[1];
    const commands = commandCandidates(cache);
    if (literal !== undefined && !commands.includes(literal)) {
      return {
        code: 'minecraft.command.unknown_command',
        message: `Unknown command \`${literal}\``,
        token: literal,
        candidates: commands,
      };
    }
  }

  return {
    code: 'minecraft.command.syntax',
    message: raw,
    candidates: [],
  };
}

function parseFailureMessage(block: string): { message: string; cursor: number } | undefined {
  const match = /Whilst parsing command on line \d+:\s*([^\r\n]+)/u.exec(block);
  if (match?.[1] === undefined) return undefined;
  const context = / at position (\d+):[\s\S]*$/u.exec(match[1]);
  const cursor = context?.[1] === undefined ? 0 : Number.parseInt(context[1], 10);
  const message = match[1].replace(/ at position \d+:[\s\S]*$/u, '').trim();
  return { message, cursor: Number.isSafeInteger(cursor) ? cursor : 0 };
}

export function parseVanillaCommandDiagnostics(
  log: string,
  probes: ReadonlyMap<string, LogicalCommand>,
  cache?: ReferenceCache,
): Diagnostic[] {
  const lines = log.replace(ANSI_SEQUENCE, '').split(/\r\n|\n|\r/u);
  const diagnostics: Diagnostic[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = FAILED_FUNCTION.exec(lines[index] ?? '');
    const probe = match?.[1] === undefined ? undefined : probes.get(match[1]);
    if (probe === undefined) continue;
    const block: string[] = [];
    let next = index + 1;
    while (next < lines.length && !LOG_EVENT.test(lines[next] ?? '')) {
      block.push(lines[next] ?? '');
      next += 1;
    }
    index = next - 1;
    const failure = parseFailureMessage(block.join('\n'));
    if (failure === undefined) {
      diagnostics.push({
        engine: 'minecraft',
        authority: 'authoritative',
        severity: 'error',
        code: 'minecraft.command.unrecognized_failure',
        message: 'Minecraft rejected this command, but its diagnostic could not be normalized.',
        path: probe.sourcePath,
        range: rangeFor(probe, undefined, 0),
      });
      continue;
    }
    const normalized = normalizeFailure(failure.message, probe, cache);
    const suggestion =
      normalized.token === undefined
        ? undefined
        : suggestIdentifier(normalized.token, normalized.candidates);
    diagnostics.push({
      engine: 'minecraft',
      authority: 'authoritative',
      severity: 'error',
      code: normalized.code,
      message: normalized.message,
      path: probe.sourcePath,
      range: rangeFor(probe, normalized.token, failure.cursor),
      ...(suggestion === undefined ? {} : { suggestedFix: `Did you mean \`${suggestion}\`?` }),
    });
  }
  return diagnostics.sort(
    (left, right) =>
      (left.path ?? '').localeCompare(right.path ?? '', 'en') ||
      (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0) ||
      (left.range?.start.character ?? 0) - (right.range?.start.character ?? 0) ||
      left.code.localeCompare(right.code, 'en'),
  );
}

function minecraftDiagnostic(
  code: string,
  message: string,
  severity: Diagnostic['severity'] = 'error',
): Diagnostic {
  return {
    engine: 'minecraft',
    authority: 'authoritative',
    severity,
    code,
    message,
  };
}

function summary(
  status: VanillaValidationSummary['status'],
  startedAt: number,
  filesChecked: number,
  commandLinesChecked: number,
  macroLinesDeferred: number,
  diagnostics: Diagnostic[],
): VanillaCommandValidationResult {
  return {
    ok: status === 'passed' && !diagnostics.some((item) => item.severity === 'error'),
    status,
    filesChecked,
    commandLinesChecked,
    macroLinesDeferred,
    durationMs: Date.now() - startedAt,
    diagnostics,
  };
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

async function stageValidationPacks(
  workspace: Workspace,
  project: string,
  scan: ScanResult,
  packsDir: string,
  namespace: string,
  signal?: AbortSignal,
): Promise<{ probes: CommandProbe[]; filesChecked: number }> {
  const stagedPack = path.join(packsDir, 'packwright-under-test');
  await stageDatapackFromSnapshot(workspace, project, stagedPack, scan, signal);

  const logicalCommands: LogicalCommand[] = [];
  let filesChecked = 0;
  for (const entry of scan.entries) {
    abortIfNeeded(signal);
    if (!entry.path.endsWith('.mcfunction')) continue;
    filesChecked += 1;
    if (entry.size > MAX_TEXT_WRITE_BYTES) {
      throw new PackwrightError(
        'scan_limit',
        `Function ${entry.path} exceeds the ${String(MAX_TEXT_WRITE_BYTES)} byte text validation limit.`,
      );
    }
    const stagedFile = path.join(stagedPack, ...entry.path.split('/'));
    const bytes = await readFile(stagedFile);
    const content = decodeFunctionText(bytes);
    logicalCommands.push(...extractLogicalCommands(content, entry.path));
    await writeFile(stagedFile, '# Packwright vanilla command validation placeholder.\n', {
      mode: 0o600,
    });
  }

  if (logicalCommands.length > MAX_COMMAND_PROBES) {
    throw new PackwrightError(
      'scan_limit',
      `Datapack exceeds the ${String(MAX_COMMAND_PROBES)} logical-command validation limit.`,
    );
  }

  const harness = path.join(packsDir, 'packwright-validation-harness');
  await writeJson(path.join(harness, 'pack.mcmeta'), createPackMetadata('Packwright validation'));
  await writeJson(path.join(harness, 'data', namespace, 'test_environment', 'validation.json'), {
    type: 'minecraft:all_of',
    definitions: [],
  });
  await writeJson(
    path.join(harness, 'data', namespace, 'test_instance', 'command_validation.json'),
    {
      type: 'function',
      environment: `${namespace}:validation`,
      structure: 'minecraft:empty',
      max_ticks: 100,
      setup_ticks: 0,
      required: true,
      function: 'minecraft:always_pass',
    },
  );

  const probes: CommandProbe[] = [];
  for (let index = 0; index < logicalCommands.length; index += 1) {
    const command = logicalCommands[index];
    if (command === undefined) continue;
    const localId = `probe_${String(index).padStart(5, '0')}`;
    const probe = { ...command, id: `${namespace}:${localId}` };
    probes.push(probe);
    if (probe.exceededLengthLimit) continue;
    const target = path.join(harness, 'data', namespace, 'function', `${localId}.mcfunction`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, `${command.command}\n`, { flag: 'wx', mode: 0o600 });
  }
  return {
    probes,
    filesChecked,
  };
}

async function readBoundedLog(filename: string): Promise<string> {
  const info = await stat(filename);
  if (!info.isFile() || info.size > MAX_LOG_BYTES) {
    throw new PackwrightError(
      'size_limit',
      `Minecraft validation log exceeded ${String(MAX_LOG_BYTES)} bytes.`,
    );
  }
  const stable = await readStableFile(filename, {
    maxBytes: MAX_LOG_BYTES,
    collect: true,
    pathLabel: 'Minecraft validation log',
  });
  if (stable.data === undefined) {
    throw new PackwrightError('precondition_failed', 'Minecraft validation log was unavailable.');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(stable.data);
}

function macroDiagnostics(probes: readonly CommandProbe[]): Diagnostic[] {
  return probes
    .filter((probe) => probe.macro)
    .map((probe) => ({
      engine: 'minecraft',
      authority: 'authoritative',
      severity: 'information',
      code: 'minecraft.command.macro_deferred',
      message:
        'Minecraft checked this function macro template, but its substituted command cannot be fully dispatcher-validated until runtime values are supplied.',
      path: probe.sourcePath,
      range: rangeFor(probe, undefined, 0),
    }));
}

export async function runVanillaCommandValidation(
  config: RuntimeConfig,
  workspace: Workspace,
  project: string,
  scan: ScanResult,
  options: RunVanillaCommandValidationOptions = {},
  signal?: AbortSignal,
): Promise<VanillaCommandValidationResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineAt = startedAt + timeoutMs;
  const functionFiles = scan.entries.filter((entry) => entry.path.endsWith('.mcfunction')).length;
  abortIfNeeded(signal);

  const cacheStatus = await getCacheStatus(config.cacheDir, true);
  if (Date.now() >= deadlineAt) {
    return summary('timeout', startedAt, functionFiles, 0, 0, [
      minecraftDiagnostic(
        'minecraft.command_validation.timeout',
        `Minecraft command validation exceeded the ${String(timeoutMs)} ms timeout.`,
      ),
    ]);
  }
  if (!cacheStatus.ready) {
    return summary('setup_required', startedAt, functionFiles, 0, 0, [
      minecraftDiagnostic(
        'minecraft.setup_required',
        'Minecraft 26.2 command validation is not prepared. A human operator must run setup-version 26.2 --accept-minecraft-eula.',
      ),
    ]);
  }
  const java = await getJavaVersion(
    config.javaCommand,
    signal,
    Math.max(1, Math.min(10_000, deadlineAt - Date.now())),
  );
  abortIfNeeded(signal);
  if (Date.now() >= deadlineAt) {
    return summary('timeout', startedAt, functionFiles, 0, 0, [
      minecraftDiagnostic(
        'minecraft.command_validation.timeout',
        `Minecraft command validation exceeded the ${String(timeoutMs)} ms timeout.`,
      ),
    ]);
  }
  if (!java.available || java.major !== 25) {
    return summary('setup_required', startedAt, functionFiles, 0, 0, [
      minecraftDiagnostic(
        'minecraft.setup_required',
        `Java 25 is required for Minecraft 26.2 command validation; ${java.description}.`,
      ),
    ]);
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'packwright-command-validation-'));
  const packsDir = path.join(temporaryRoot, 'packs');
  const serverJar = path.join(temporaryRoot, 'server.jar');
  const report = path.join(temporaryRoot, 'report.xml');
  const universe = path.join(temporaryRoot, 'universe');
  const namespace = `packwright_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const deadlineController = new AbortController();
  const forwardAbort = (): void => deadlineController.abort();
  const deadlineReached = (): boolean => Date.now() >= deadlineAt && signal?.aborted !== true;
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    Math.max(1, deadlineAt - Date.now()),
  );
  deadlineTimer.unref();
  const validationSignal = deadlineController.signal;

  try {
    await mkdir(packsDir, { recursive: true, mode: 0o700 });
    await copyVerifiedServerJar(config.cacheDir, serverJar, validationSignal);
    const staged = await stageValidationPacks(
      workspace,
      project,
      scan,
      packsDir,
      namespace,
      validationSignal,
    );
    await writeFile(path.join(temporaryRoot, 'eula.txt'), 'eula=true\n', { mode: 0o600 });
    assertScanSnapshotUnchanged(
      scan,
      await scanDatapack(workspace, project, { signal: validationSignal }),
    );

    const oversized = staged.probes.filter((probe) => probe.exceededLengthLimit);
    const runnable = staged.probes.filter((probe) => !probe.exceededLengthLimit);
    const deferredMacros = runnable.filter((probe) => probe.macro).length;
    const lengthDiagnostics = oversized.map((probe): Diagnostic => ({
      engine: 'minecraft',
      authority: 'authoritative',
      severity: 'error',
      code: 'minecraft.command.too_long',
      message: `Logical command exceeds Minecraft's ${String(MAX_COMMAND_LENGTH)}-character limit.`,
      path: probe.sourcePath,
      range: rangeFor(probe, undefined, 0),
    }));

    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return summary('timeout', startedAt, staged.filesChecked, runnable.length, deferredMacros, [
        ...lengthDiagnostics,
        minecraftDiagnostic(
          'minecraft.command_validation.timeout',
          `Minecraft command validation exceeded the ${String(timeoutMs)} ms timeout.`,
        ),
      ]);
    }

    const processResult = await runProcess({
      command: config.javaCommand,
      args: [
        '-DbundlerMainClass=net.minecraft.gametest.Main',
        '-jar',
        serverJar,
        '--packs',
        packsDir,
        '--report',
        report,
        '--tests',
        `${namespace}:command_validation`,
        '--universe',
        universe,
        '--verify',
        'false',
      ],
      cwd: temporaryRoot,
      timeoutMs: remainingMs,
      signal: validationSignal,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    if (deadlineReached()) {
      return summary('timeout', startedAt, staged.filesChecked, runnable.length, deferredMacros, [
        ...lengthDiagnostics,
        minecraftDiagnostic(
          'minecraft.command_validation.timeout',
          `Minecraft command validation exceeded the ${String(timeoutMs)} ms timeout.`,
        ),
      ]);
    }
    if (processResult.cancelled || signal?.aborted) {
      throw new PackwrightError('cancelled', 'Vanilla command validation was cancelled.');
    }
    if (processResult.timedOut) {
      return summary('timeout', startedAt, staged.filesChecked, runnable.length, deferredMacros, [
        ...lengthDiagnostics,
        minecraftDiagnostic(
          'minecraft.command_validation.timeout',
          `Minecraft command validation exceeded the ${String(timeoutMs)} ms timeout.`,
        ),
      ]);
    }

    let reportCases;
    try {
      reportCases = parseGameTestCases(await readFile(report, 'utf8'));
    } catch (error) {
      return summary('failed', startedAt, staged.filesChecked, runnable.length, deferredMacros, [
        ...lengthDiagnostics,
        minecraftDiagnostic(
          'minecraft.command_validation.report_unavailable',
          `Minecraft command validation did not produce a readable harness report: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ]);
    }
    const harnessPassed = reportCases.some(
      (test) => test.status === 'passed' && test.name.includes(`${namespace}:command_validation`),
    );
    if (processResult.exitCode !== 0 || !harnessPassed) {
      const output = `${processResult.stderr}\n${processResult.stdout}`.trim();
      const snippet = output.length > 2_000 ? `${output.slice(0, 2_000)}…` : output;
      return summary('failed', startedAt, staged.filesChecked, runnable.length, deferredMacros, [
        ...lengthDiagnostics,
        minecraftDiagnostic(
          'minecraft.command_validation.runner_failed',
          `Minecraft could not complete the isolated command-validation harness${snippet ? `: ${snippet}` : '.'}`,
        ),
      ]);
    }

    const [log, referenceCache] = await Promise.all([
      readBoundedLog(path.join(temporaryRoot, 'logs', 'latest.log')),
      loadReferenceCache(config.cacheDir),
    ]);
    const probes = new Map(runnable.map((probe) => [probe.id, probe] as const));
    const diagnostics = [
      ...lengthDiagnostics,
      ...parseVanillaCommandDiagnostics(log, probes, referenceCache),
      ...macroDiagnostics(runnable),
    ].sort(
      (left, right) =>
        (left.path ?? '').localeCompare(right.path ?? '', 'en') ||
        (left.range?.start.line ?? 0) - (right.range?.start.line ?? 0) ||
        left.code.localeCompare(right.code, 'en'),
    );
    assertScanSnapshotUnchanged(
      scan,
      await scanDatapack(workspace, project, { signal: validationSignal }),
    );
    return summary(
      diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'failed' : 'passed',
      startedAt,
      staged.filesChecked,
      runnable.length,
      deferredMacros,
      diagnostics,
    );
  } catch (error) {
    if (deadlineReached()) {
      return summary('timeout', startedAt, functionFiles, 0, 0, [
        minecraftDiagnostic(
          'minecraft.command_validation.timeout',
          `Minecraft command validation exceeded the ${String(timeoutMs)} ms timeout.`,
        ),
      ]);
    }
    if (signal?.aborted || (error instanceof PackwrightError && error.code === 'cancelled')) {
      throw new PackwrightError('cancelled', 'Vanilla command validation was cancelled.');
    }
    if (error instanceof PackwrightError && error.code === 'scan_limit') {
      return summary('failed', startedAt, functionFiles, 0, 0, [
        minecraftDiagnostic('minecraft.command_validation.limit', error.message),
      ]);
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', forwardAbort);
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class VanillaCommandValidationAdapter implements ValidationAdapter {
  readonly name = 'minecraft';
  readonly authority = 'authoritative' as const;
  readonly config: RuntimeConfig;
  readonly timeoutMs: number;
  readonly deadlineAt: number | undefined;
  lastResult: VanillaCommandValidationResult | undefined;

  constructor(config: RuntimeConfig, timeoutMs = DEFAULT_TIMEOUT_MS, deadlineAt?: number) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.deadlineAt = deadlineAt;
  }

  async validate(
    _packRoot: string,
    signal?: AbortSignal,
    context?: ValidationAdapterContext,
  ): Promise<readonly Diagnostic[]> {
    if (context === undefined) {
      throw new PackwrightError(
        'precondition_failed',
        'Vanilla command validation requires the validated scan snapshot.',
      );
    }
    this.lastResult = await runVanillaCommandValidation(
      this.config,
      context.workspace,
      context.packPath,
      context.scan,
      {
        timeoutMs:
          this.deadlineAt === undefined
            ? this.timeoutMs
            : Math.max(1, this.deadlineAt - Date.now()),
      },
      signal,
    );
    return this.lastResult.diagnostics;
  }
}

export const VANILLA_COMMAND_VALIDATION_LIMITS = Object.freeze({
  maxProbes: MAX_COMMAND_PROBES,
  maxCommandLength: MAX_COMMAND_LENGTH,
  maxLogBytes: MAX_LOG_BYTES,
  maxScanFiles: MAX_SCAN_FILES,
  maxScanBytes: MAX_SCAN_BYTES,
});
