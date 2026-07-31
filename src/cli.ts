#!/usr/bin/env node

import { Command, InvalidArgumentError, Option } from 'commander';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import { resolveRuntimeConfig, type RuntimeConfigOverrides } from './config.js';
import { isPackwrightError } from './core/errors.js';
import { isValidResourceId } from './core/identifiers.js';
import type { Diagnostic } from './core/types.js';
import { runDoctor } from './doctor.js';
import { setupVersion } from './minecraft/cache.js';
import { createPackwrightMcpServer } from './mcp/register.js';
import type { PackwrightServiceContext } from './mcp/service.js';
import { PackwrightApplication } from './service.js';

interface GlobalOptions {
  workspace?: string;
  java?: string;
  cacheDir?: string;
  readOnly?: boolean;
  offline?: boolean;
  json?: boolean;
}

function integer(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function nonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function sha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new InvalidArgumentError('Expected a lowercase SHA-256 digest.');
  }
  return value;
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function configOverrides(options: GlobalOptions): RuntimeConfigOverrides {
  return {
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    ...(options.java === undefined ? {} : { java: options.java }),
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.offline === undefined ? {} : { offline: options.offline }),
  };
}

function operationContext(signal: AbortSignal): PackwrightServiceContext {
  return {
    signal,
    reportProgress: () => Promise.resolve(),
  };
}

function displayDiagnosticPath(value: string): string {
  const functionPath = /^data\/([^/]+)\/function\/(.+\.mcfunction)$/u.exec(value);
  return functionPath?.[1] === undefined || functionPath[2] === undefined
    ? value
    : `${functionPath[1]}/${functionPath[2]}`;
}

export function diagnosticsText(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.flatMap((entry) => {
    if (entry.path !== undefined && entry.range !== undefined) {
      return [
        `${displayDiagnosticPath(entry.path)}:${String(entry.range.start.line + 1)}`,
        entry.message,
        ...(entry.suggestedFix === undefined ? [] : [entry.suggestedFix]),
      ];
    }
    const location = entry.path === undefined ? '' : ` ${entry.path}`;
    return [
      `${entry.severity.toUpperCase()} [${entry.engine}:${entry.code}]${location}: ${entry.message}`,
      ...(entry.suggestedFix === undefined ? [] : [entry.suggestedFix]),
    ];
  });
}

function emitResult(
  value: unknown,
  json: boolean,
  summary: readonly string[],
  diagnostics: readonly Diagnostic[] = [],
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  for (const line of summary) process.stdout.write(`${line}\n`);
  for (const line of diagnosticsText(diagnostics)) process.stdout.write(`${line}\n`);
}

function installAbortHandlers(): {
  readonly controller: AbortController;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  return {
    controller,
    dispose: () => {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    },
  };
}

async function serve(options: GlobalOptions): Promise<void> {
  const config = resolveRuntimeConfig(configOverrides(options));
  const application = await PackwrightApplication.open(config);
  const handle: StdioServerHandle = serveStdio(() => createPackwrightMcpServer(application), {
    onerror: (error) => {
      process.stderr.write(`packwright-mcp: ${error.stack ?? error.message}\n`);
    },
  });
  const close = (): void => {
    void handle.close().catch((error: unknown) => {
      process.stderr.write(
        `packwright-mcp: failed to close cleanly: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function addGlobalOptions(program: Command): void {
  program
    .option('--workspace <absolute-path>', 'workspace containing datapack projects')
    .option('--java <executable>', 'Java executable (overrides PACKWRIGHT_JAVA)')
    .option('--cache-dir <absolute-path>', 'Packwright cache directory')
    .addOption(new Option('--read-only', 'disable workspace mutations').default(undefined))
    .addOption(
      new Option('--no-read-only', 'override read-only environment mode').default(undefined),
    )
    .addOption(new Option('--offline', 'forbid setup downloads').default(undefined))
    .addOption(new Option('--no-offline', 'override offline environment mode').default(undefined))
    .option('--json', 'emit machine-readable JSON from non-server commands', false);
}

export function createCli(): Command {
  const program = new Command();
  program
    .name('packwright-mcp')
    .description('Local-first MCP server and visual compiler for Minecraft Java 26.2 packs')
    .version('0.4.0')
    .showSuggestionAfterError()
    .showHelpAfterError();
  addGlobalOptions(program);

  program.action(async (_options: GlobalOptions, command: Command) => {
    await serve(globalOptions(command));
  });

  program
    .command('serve')
    .description('serve Packwright MCP over local stdio')
    .action(async (_options: unknown, command: Command) => {
      await serve(globalOptions(command));
    });

  program
    .command('doctor')
    .description('check runtime, workspace, Java, cache, and validators')
    .action(async (_options: unknown, command: Command) => {
      const options = globalOptions(command);
      const config = resolveRuntimeConfig(configOverrides(options));
      const abort = installAbortHandlers();
      try {
        const result = await runDoctor(config, abort.controller.signal);
        emitResult(
          result,
          options.json ?? false,
          result.checks.map(
            (check) =>
              `${check.ok ? 'PASS' : check.required ? 'FAIL' : 'INFO'} ${check.name}: ${check.message}`,
          ),
        );
        if (!result.ok) process.exitCode = 1;
      } finally {
        abort.dispose();
      }
    });

  program
    .command('setup-version')
    .description('prepare explicitly accepted Mojang validation data')
    .argument('<version>', 'Minecraft version (26.2 only)')
    .requiredOption(
      '--accept-minecraft-eula',
      'record explicit human acceptance of the Minecraft EULA',
    )
    .option(
      '--client-assets',
      'also cache the manifest-verified official client jar and asset index',
      false,
    )
    .option(
      '--client-capture',
      'prepare the complete hash-verified client, assets, libraries, natives, and Fabric capture runtime',
      false,
    )
    .action(
      async (
        version: string,
        local: { clientAssets: boolean; clientCapture: boolean },
        command: Command,
      ) => {
        if (version !== '26.2') throw new InvalidArgumentError('Only Minecraft 26.2 is supported.');
        const options = globalOptions(command);
        const config = resolveRuntimeConfig(configOverrides(options));
        const abort = installAbortHandlers();
        try {
          const result = await setupVersion(config, true, abort.controller.signal, {
            clientAssets: local.clientAssets,
            clientCapture: local.clientCapture,
          });
          emitResult(result, options.json ?? false, [
            `Minecraft ${result.minecraftVersion} validation cache is ready.`,
            `Cache: ${result.cacheDir}`,
            `Verified server SHA-1: ${result.serverSha1}`,
            ...(result.clientAssets.selected
              ? [
                  `Verified client SHA-1: ${result.clientAssets.clientSha1 ?? 'unknown'}`,
                  `Verified asset index: ${result.clientAssets.assetIndexId ?? 'unknown'} (${result.clientAssets.assetIndexSha1 ?? 'unknown'})`,
                ]
              : []),
            ...(result.clientCapture.selected
              ? [
                  `Verified client-capture runtime: ${String(result.clientCapture.artifacts ?? 0)} artifacts (${result.clientCapture.manifestSha256 ?? 'unknown'})`,
                  `Capture platform: ${result.clientCapture.platform ?? 'unknown'}/${result.clientCapture.architecture ?? 'unknown'}`,
                ]
              : []),
          ]);
        } finally {
          abort.dispose();
        }
      },
    );

  program
    .command('capture')
    .description('capture a connected visual proposal with the actual Minecraft 26.2 renderer')
    .argument('<project-id>', 'attached Packwright visual project ID')
    .requiredOption('--run <sha256>', 'immutable visual run ID', sha256)
    .option('--revision <sha256>', 'immutable visual revision ID', sha256)
    .requiredOption('--proposal-sha256 <sha256>', 'current connected proposal hash', sha256)
    .requiredOption('--confirm', 'launch the graphical client in a disposable game directory')
    .option('--timeout-ms <milliseconds>', 'timeout from 30000 to 600000', integer, 300_000)
    .option('--width <pixels>', 'framebuffer width from 640 to 1920', integer, 1280)
    .option('--height <pixels>', 'framebuffer height from 360 to 1080', integer, 720)
    .option('--gui-scale <scale>', 'Minecraft GUI scale from 0 to 8', nonNegativeInteger, 2)
    .action(
      async (
        projectId: string,
        local: {
          run: string;
          revision?: string;
          proposalSha256: string;
          confirm: true;
          timeoutMs: number;
          width: number;
          height: number;
          guiScale: number;
        },
        command: Command,
      ) => {
        if (local.timeoutMs < 30_000 || local.timeoutMs > 600_000) {
          throw new InvalidArgumentError('--timeout-ms must be between 30000 and 600000.');
        }
        if (local.width < 640 || local.width > 1920) {
          throw new InvalidArgumentError('--width must be between 640 and 1920.');
        }
        if (local.height < 360 || local.height > 1080) {
          throw new InvalidArgumentError('--height must be between 360 and 1080.');
        }
        if (local.guiScale < 0 || local.guiScale > 8) {
          throw new InvalidArgumentError('--gui-scale must be between 0 and 8.');
        }
        const options = globalOptions(command);
        const config = resolveRuntimeConfig(configOverrides(options));
        const application = await PackwrightApplication.open(config);
        const abort = installAbortHandlers();
        try {
          const result = await application.captureVisual(
            {
              projectId,
              runId: local.run,
              ...(local.revision === undefined ? {} : { revisionId: local.revision }),
              proposalSha256: local.proposalSha256,
              confirm: true,
              timeoutMs: local.timeoutMs,
              resolution: { width: local.width, height: local.height },
              guiScale: local.guiScale,
            },
            operationContext(abort.controller.signal),
          );
          emitResult(
            result,
            options.json ?? false,
            [
              `${result.status.toUpperCase()}: ${String(result.views.length)} Minecraft framebuffer views`,
              ...(result.reportSha256 === undefined
                ? []
                : [`Accepted report SHA-256: ${result.reportSha256}`]),
              ...(result.reportUri === undefined ? [] : [`Report: ${result.reportUri}`]),
              ...(result.contactSheetUri === undefined
                ? []
                : [`Contact sheet: ${result.contactSheetUri}`]),
            ],
            result.diagnostics,
          );
          if (!result.ok) process.exitCode = result.status === 'setup_required' ? 2 : 1;
        } finally {
          abort.dispose();
        }
      },
    );

  program
    .command('validate')
    .description('validate a workspace datapack')
    .argument('<project>', 'workspace-relative datapack path')
    .option('--no-spyglass', 'skip the configured external Spyglass adapter')
    .option('--no-vanilla', 'skip authoritative Minecraft command validation')
    .action(
      async (project: string, local: { spyglass: boolean; vanilla: boolean }, command: Command) => {
        const options = globalOptions(command);
        const config = resolveRuntimeConfig(configOverrides(options));
        const application = await PackwrightApplication.open(config);
        const abort = installAbortHandlers();
        try {
          const result = await application.validateDatapack(
            {
              project,
              includeSpyglass: local.spyglass,
              includeVanilla: local.vanilla,
            },
            operationContext(abort.controller.signal),
          );
          emitResult(
            result,
            options.json ?? false,
            [
              `${result.ok ? 'VALID' : 'INVALID'}: ${String(result.filesScanned)} files, ${String(result.bytesScanned)} bytes`,
            ],
            result.diagnostics,
          );
          if (!result.ok) process.exitCode = result.vanilla?.status === 'setup_required' ? 2 : 1;
        } finally {
          abort.dispose();
        }
      },
    );

  program
    .command('test')
    .description('run a datapack in a disposable vanilla GameTest universe')
    .argument('<project>', 'workspace-relative datapack path')
    .option('--test <resource-id...>', 'exact GameTest resource ID(s)')
    .option('--timeout-ms <milliseconds>', 'timeout capped at 300000', integer, 300_000)
    .action(
      async (project: string, local: { test?: string[]; timeoutMs: number }, command: Command) => {
        if (local.timeoutMs < 1_000 || local.timeoutMs > 300_000) {
          throw new InvalidArgumentError('--timeout-ms must be between 1000 and 300000.');
        }
        if (local.test?.some((selection) => !isValidResourceId(selection))) {
          throw new InvalidArgumentError(
            '--test accepts only exact namespace:path GameTest resource IDs.',
          );
        }
        const options = globalOptions(command);
        const config = resolveRuntimeConfig(configOverrides(options));
        const application = await PackwrightApplication.open(config);
        const abort = installAbortHandlers();
        try {
          const result = await application.testDatapack(
            {
              project,
              ...(local.test === undefined ? {} : { tests: local.test }),
              timeoutMs: local.timeoutMs,
            },
            operationContext(abort.controller.signal),
          );
          emitResult(
            result,
            options.json ?? false,
            [
              `${result.status.toUpperCase()}: ${String(result.tests.length)} test cases in ${String(result.durationMs)} ms`,
            ],
            result.diagnostics,
          );
          if (!result.ok) process.exitCode = result.status === 'setup_required' ? 2 : 1;
        } finally {
          abort.dispose();
        }
      },
    );

  program
    .command('build')
    .description('validate and build a deterministic datapack ZIP')
    .argument('<project>', 'workspace-relative datapack path')
    .option('--output <relative-path>', 'workspace-relative ZIP output')
    .option('--overwrite', 'replace an existing output with a matching hash', false)
    .option('--expected-sha256 <hash>', 'current SHA-256 required for replacement')
    .action(
      async (
        project: string,
        local: { output?: string; overwrite: boolean; expectedSha256?: string },
        command: Command,
      ) => {
        const options = globalOptions(command);
        const config = resolveRuntimeConfig(configOverrides(options));
        const application = await PackwrightApplication.open(config);
        const abort = installAbortHandlers();
        try {
          const result = await application.buildDatapack(
            {
              project,
              ...(local.output === undefined ? {} : { outputPath: local.output }),
              overwrite: local.overwrite,
              ...(local.expectedSha256 === undefined
                ? {}
                : { expectedSha256: local.expectedSha256 }),
            },
            operationContext(abort.controller.signal),
          );
          emitResult(
            result,
            options.json ?? false,
            result.ok
              ? [
                  `BUILT: ${result.path ?? 'unknown'}`,
                  `SHA-256: ${result.sha256 ?? 'unknown'}`,
                  `Size: ${String(result.size ?? 0)} bytes (${String(result.entries)} entries)`,
                ]
              : ['BUILD FAILED'],
            result.diagnostics,
          );
          if (!result.ok) process.exitCode = result.vanilla?.status === 'setup_required' ? 2 : 1;
        } finally {
          abort.dispose();
        }
      },
    );

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  await createCli().parseAsync(argv);
}

main().catch((error: unknown) => {
  if (process.argv.includes('--json')) {
    const payload = isPackwrightError(error)
      ? {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        }
      : {
          ok: false,
          error: {
            code: error instanceof InvalidArgumentError ? 'invalid_argument' : 'internal_error',
            message: error instanceof Error ? error.message : String(error),
          },
        };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  if (isPackwrightError(error)) {
    process.stderr.write(`packwright-mcp: ${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write(
      `packwright-mcp: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exitCode = 1;
});
