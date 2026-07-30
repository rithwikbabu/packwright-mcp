import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../../src/core/workspace.js';

export async function temporaryWorkspace(): Promise<{
  root: string;
  workspace: Workspace;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'packwright-core-'));
  return {
    root,
    workspace: await Workspace.open(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
