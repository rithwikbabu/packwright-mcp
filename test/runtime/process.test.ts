import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { runProcess } from '../../src/runtime/process.js';

describe('runProcess', () => {
  it('bounds captured stdout and records truncation', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4096))"],
      maxOutputBytes: 64,
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
    });
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(64);
  });

  it('terminates a subprocess group when its deadline expires', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
    expect(result.signal ?? result.exitCode).toBeDefined();
  });

  it('terminates a subprocess group when its AbortSignal is cancelled', async () => {
    const controller = new AbortController();
    const running = runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await delay(100);
    controller.abort();

    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
    expect(result.signal ?? result.exitCode).toBeDefined();
  });

  it('does not spawn when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProcess({
        command: 'this-command-does-not-exist',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      cancelled: true,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('observes cancellation that races with abort-listener registration', async () => {
    let abortedReads = 0;
    const racingSignal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads >= 2;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;

    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: racingSignal,
      timeoutMs: 5_000,
    });

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(5_000);
  });
});
