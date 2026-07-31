import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as CoreModule from '../src/core/index.js';
import { validateDatapack } from '../src/core/index.js';
import { DatapackTestInputSchema } from '../src/mcp/schemas.js';
import { PackwrightApplication } from '../src/service.js';

vi.mock('../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  return {
    ...actual,
    validateDatapack: vi.fn(
      async (_workspace: unknown, _packPath: string, options: { readonly signal?: AbortSignal }) =>
        await new Promise<never>((_resolve, reject) => {
          const cancelled = (): void =>
            reject(new actual.PackwrightError('cancelled', 'Validation was cancelled.'));
          if (options.signal?.aborted) {
            cancelled();
            return;
          }
          options.signal?.addEventListener('abort', cancelled, { once: true });
        }),
    ),
  };
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('Packwright shared GameTest deadline', () => {
  it('returns a structured timeout when the deadline expires during validation', async () => {
    vi.useFakeTimers();
    const container = await mkdtemp(path.join(os.tmpdir(), 'packwright-test-deadline-'));
    cleanups.push(async () => rm(container, { recursive: true, force: true }));
    const root = path.join(container, 'workspace');
    await mkdir(root);
    const application = await PackwrightApplication.open({
      workspaceRoot: root,
      cacheDir: path.join(container, 'cache'),
      javaCommand: 'java',
      readOnly: false,
      offline: true,
    });
    const externalController = new AbortController();
    const input = DatapackTestInputSchema.parse({
      project: 'pack',
      timeoutMs: 1_000,
    });

    const resultPromise = application.testDatapack(input, {
      signal: externalController.signal,
      reportProgress: () => Promise.resolve(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(validateDatapack)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      status: 'timeout',
      durationMs: 1_000,
      tests: [],
      diagnostics: [
        expect.objectContaining({
          authority: 'authoritative',
          severity: 'error',
          code: 'minecraft.timeout',
        }),
      ],
    });
    expect(externalController.signal.aborted).toBe(false);
  });
});
