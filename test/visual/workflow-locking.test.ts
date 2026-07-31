import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VisualWorkflow } from '../../src/visual/workflow.js';
import { temporaryWorkspace } from '../core/helpers.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('visual project operation locking', () => {
  it('serializes the same project across workflow instances without blocking other projects', async () => {
    const fixture = await temporaryWorkspace();
    cleanups.push(fixture.cleanup);
    const cache = path.join(fixture.root, 'cache');
    const firstWorkflow = new VisualWorkflow(fixture.workspace, cache);
    const secondWorkflow = new VisualWorkflow(fixture.workspace, cache);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = firstWorkflow.runProjectOperation('firestaff', async () => {
      entered();
      await held;
    });
    await firstEntered;

    let sameProjectEntered = false;
    const sameProject = secondWorkflow.runProjectOperation('firestaff', () => {
      sameProjectEntered = true;
      return Promise.resolve();
    });
    let otherProjectEntered = false;
    await secondWorkflow.runProjectOperation('other-project', () => {
      otherProjectEntered = true;
      return Promise.resolve();
    });

    expect(otherProjectEntered).toBe(true);
    expect(sameProjectEntered).toBe(false);
    release();
    await Promise.all([first, sameProject]);
    expect(sameProjectEntered).toBe(true);
  });
});
