import { spawn } from 'node:child_process';

import { MAX_MCP_PAYLOAD_BYTES } from '../core/limits.js';

export interface ProcessResult {
  readonly exitCode?: number;
  readonly signal?: NodeJS.Signals;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface RunProcessOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes?: number;
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void {
  if (state.bytes >= limit) {
    state.truncated = true;
    return;
  }
  const remaining = limit - state.bytes;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    state.bytes += chunk.length;
    return;
  }
  chunks.push(chunk.subarray(0, remaining));
  state.bytes += remaining;
  state.truncated = true;
}

/** Run a subprocess without a shell and reliably terminate its process group. */
export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? MAX_MCP_PAYLOAD_BYTES;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  let timedOut = false;
  let cancelled = options.signal?.aborted ?? false;

  if (cancelled) {
    return {
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
    };
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      detached,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const kill = (): void => {
      if (child.pid === undefined || child.killed) return;
      try {
        if (detached) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      forceKillTimer = setTimeout(() => {
        if (child.pid === undefined || child.exitCode !== null) return;
        try {
          if (detached) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 2_000);
      forceKillTimer.unref();
    };

    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Abort may occur after the initial snapshot above but before the listener
    // is installed. Re-check after registration so that narrow race cannot
    // leave a subprocess running until its timeout.
    if (options.signal?.aborted) onAbort();

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
      timeoutTimer.unref();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      appendBounded(stdout, chunk, stdoutState, maxOutputBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      appendBounded(stderr, chunk, stderrState, maxOutputBytes);
    });

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result: ProcessResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutTruncated: stdoutState.truncated,
        stderrTruncated: stderrState.truncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      };
      resolve(result);
    });
  });
}
