import type { ProcessResult } from '../runtime/process.js';
import { runProcess } from '../runtime/process.js';

export interface JavaVersionResult {
  readonly available: boolean;
  readonly major?: number;
  readonly description: string;
  readonly process?: ProcessResult;
}

function parseJavaMajor(output: string): number | undefined {
  const match = /(?:java|openjdk) version\s+"?(\d+)(?:[._][^"\s]+)?/iu.exec(output);
  if (match?.[1] === undefined) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function getJavaVersion(
  javaCommand: string,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<JavaVersionResult> {
  try {
    const result = await runProcess({
      command: javaCommand,
      args: ['-version'],
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      maxOutputBytes: 64 * 1024,
    });
    const output = `${result.stderr}\n${result.stdout}`.trim();
    const major = parseJavaMajor(output);
    if (result.cancelled) {
      return { available: false, description: 'Java check was cancelled', process: result };
    }
    if (result.timedOut) {
      return { available: false, description: 'Java version check timed out', process: result };
    }
    if (result.exitCode !== 0 || major === undefined) {
      return {
        available: false,
        description: output || 'Java did not report a recognizable version',
        process: result,
      };
    }
    return {
      available: true,
      major,
      description: `Java ${String(major)}`,
      process: result,
    };
  } catch (error) {
    return {
      available: false,
      description: error instanceof Error ? error.message : String(error),
    };
  }
}

export { parseJavaMajor };
