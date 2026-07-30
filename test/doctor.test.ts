import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/doctor.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('doctor', () => {
  it('rejects a readable regular file as the workspace root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-doctor-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const workspaceFile = path.join(root, 'not-a-directory');
    await writeFile(workspaceFile, 'file');

    const result = await runDoctor({
      workspaceRoot: workspaceFile,
      cacheDir: path.join(root, 'cache'),
      javaCommand: path.join(root, 'missing-java'),
      readOnly: false,
      offline: true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.name === 'workspace_read')).toMatchObject({
      ok: false,
      required: true,
    });
  });
});
