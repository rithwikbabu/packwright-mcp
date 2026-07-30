const pathLocks = new Map<string, Promise<void>>();

export async function withPathLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  pathLocks.set(path, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (pathLocks.get(path) === queued) pathLocks.delete(path);
  }
}
