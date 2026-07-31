import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { runProcess } from '../src/runtime/process.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('compiled CLI', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

  it('runs when Node receives a symlinked npm-style bin path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-cli-bin-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    const launcher = path.join(root, 'packwright-mcp');
    await symlink(cli, launcher);

    const result = await runProcess({
      command: process.execPath,
      args: [launcher, '--help'],
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: packwright-mcp');
  });

  it('exposes explicit client-assets setup without changing the default setup command', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [cli, 'setup-version', '--help'],
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--accept-minecraft-eula');
    expect(result.stdout).toContain('--client-assets');
    expect(result.stdout).toContain('--client-capture');
  });

  it('exposes an explicitly confirmed official-client capture command', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [cli, 'capture', '--help'],
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--proposal-sha256');
    expect(result.stdout).toContain('--confirm');
    expect(result.stdout).toContain('--gui-scale');
    expect(result.stdout).toContain('--representation-json');
    expect(result.stdout).toContain('--include-scale-reference-views');
    expect(result.stdout).toContain('--include-debug-hitbox-views');
    expect(result.stdout).toContain('--display-settling-ticks');
  });

  it('emits a structured failure when --json is requested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-cli-json-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));

    const result = await runProcess({
      command: process.execPath,
      args: [cli, 'build', 'missing', '--workspace', root, '--json'],
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});
