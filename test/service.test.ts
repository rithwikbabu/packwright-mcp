import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatapack, upsertResource } from '../src/core/index.js';
import { PackwrightApplication } from '../src/service.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()));
});

describe('Packwright application payload bounds', () => {
  it('accounts for JSON escaping when truncating a resource_read result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-service-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));

    const application = await PackwrightApplication.open({
      workspaceRoot: root,
      cacheDir: path.join(root, '.cache'),
      javaCommand: 'java',
      readOnly: false,
      offline: true,
    });
    await createDatapack(application.workspace, {
      packPath: 'example',
      namespace: 'example',
      description: 'Payload-bound regression fixture',
    });
    await upsertResource(application.workspace, 'example', {
      type: 'function',
      id: 'example:escaped',
      content: '\\'.repeat(900 * 1024),
    });

    const result = await application.readResource({
      project: 'example',
      selector: {
        kind: 'resource',
        resourceType: 'function',
        id: 'example:escaped',
      },
    });

    expect(result.truncated).toBe(true);
    expect(result.bytesReturned).toBeLessThan(result.size);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(700 * 1024);
  });

  it('reports deep validators ready only when their runtime prerequisites work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-readiness-'));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));

    const application = await PackwrightApplication.open({
      workspaceRoot: root,
      cacheDir: path.join(root, '.cache'),
      javaCommand: path.join(root, 'missing-java'),
      spyglassCommand: path.join(root, 'missing-spyglass'),
      readOnly: false,
      offline: true,
    });
    await createDatapack(application.workspace, {
      packPath: 'example',
      namespace: 'example',
      description: 'Readiness regression fixture',
    });

    const result = await application.inspectDatapack(
      { project: 'example' },
      {
        signal: new AbortController().signal,
        reportProgress: () => Promise.resolve(),
      },
    );

    expect(result.validationReadiness).toEqual({
      structural: true,
      spyglass: false,
      vanilla: false,
    });
  });
});
