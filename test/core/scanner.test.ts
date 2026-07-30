import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatapack } from '../../src/core/authoring.js';
import { scanDatapack } from '../../src/core/scanner.js';
import { temporaryWorkspace } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('datapack scanning', () => {
  it('honors an already-aborted scan signal', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'example',
      description: 'Cancellation fixture',
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      scanDatapack(fixture.workspace, 'pack', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects encoded or ambiguous paths already present inside a pack', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    await createDatapack(fixture.workspace, {
      packPath: 'pack',
      namespace: 'example',
      description: 'Unsafe inventory fixture',
    });
    await writeFile(path.join(fixture.root, 'pack', '%2e%2e'), 'ambiguous');

    await expect(scanDatapack(fixture.workspace, 'pack')).rejects.toMatchObject({
      code: 'unsafe_path',
    });
  });
});
