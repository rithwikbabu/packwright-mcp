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

function diagnosticsText(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((entry) => {
    const location = entry.path === undefined ? '' : ` ${entry.path}`;
    return `${entry.severity.toUpperCase()} [${entry.engine}:${entry.code}]${location}: ${entry.message}`;
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
    .description('Local-first MCP server and CLI for Minecraft Java 26.2 datapacks')
    .version('0.1.2')
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
    .action(async (version: string, _local: unknown, command: Command) => {
      if (version !== '26.2') throw new InvalidArgumentError('Only Minecraft 26.2 is supported.');
      const options = globalOptions(command);
      const config = resolveRuntimeConfig(configOverrides(options));
      const abort = installAbortHandlers();
      try {
        const result = await setupVersion(config, true, abort.controller.signal);
        emitResult(result, options.json ?? false, [
          `Minecraft ${result.minecraftVersion} validation cache is ready.`,
          `Cache: ${result.cacheDir}`,
          `Verified server SHA-1: ${result.serverSha1}`,
        ]);
      } finally {
        abort.dispose();
      }
    });

  program
    .command('validate')
    .description('validate a workspace datapack')
    .argument('<project>', 'workspace-relative datapack path')
    .option('--no-spyglass', 'skip the configured external Spyglass adapter')
    .action(async (project: string, local: { spyglass: boolean }, command: Command) => {
      const options = globalOptions(command);
      const config = resolveRuntimeConfig(configOverrides(options));
      const application = await PackwrightApplication.open(config);
      const abort = installAbortHandlers();
      try {
        const result = await application.validateDatapack(
          { project, includeSpyglass: local.spyglass },
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
        if (!result.ok) process.exitCode = 1;
      } finally {
        abort.dispose();
      }
    });

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
          if (!result.ok) process.exitCode = 1;
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
