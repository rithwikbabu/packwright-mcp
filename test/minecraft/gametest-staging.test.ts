import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatapack } from '../../src/core/authoring.js';
import { MAX_SCAN_BYTES } from '../../src/core/limits.js';
import { scanDatapack } from '../../src/core/scanner.js';
import { stageDatapackFromSnapshot } from '../../src/minecraft/gametest.js';
import { temporaryWorkspace } from '../core/helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('GameTest staging snapshots', () => {
  it('copies only bytes matching the scanned size and hash', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const destination = await mkdtemp(path.join(os.tmpdir(), 'packwright-stage-test-'));
    cleanups.push(() => rm(destination, { recursive: true, force: true }));
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'demo',
      description: 'Before',
    });
    const scan = await scanDatapack(fixture.workspace, 'pack');
    const manifest = path.join(fixture.root, 'pack/pack.mcmeta');
    const original = await readFile(manifest, 'utf8');
    await writeFile(manifest, original.replace('Before', 'After!'));

    await expect(
      stageDatapackFromSnapshot(fixture.workspace, 'pack', destination, scan),
    ).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('rejects an out-of-bounds supplied staging snapshot before copying', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const destination = path.join(fixture.root, 'staged');

    await expect(
      stageDatapackFromSnapshot(fixture.workspace, 'pack', destination, {
        entries: [],
        totalBytes: MAX_SCAN_BYTES + 1,
      }),
    ).rejects.toMatchObject({ code: 'scan_limit' });
  });
});
