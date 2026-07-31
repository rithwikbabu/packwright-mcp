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

/**
 * Acquire multiple in-process path locks in deterministic order. Sorting and
 * de-duplicating here prevents two overlapping visual transactions from
 * deadlocking when their proposals list files in different orders.
 */
export async function withPathLocks<T>(
  paths: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(paths)].sort((left, right) => left.localeCompare(right, 'en'));
  const acquire = async (index: number): Promise<T> => {
    const current = ordered[index];
    if (current === undefined) return task();
    return withPathLock(current, () => acquire(index + 1));
  };
  return acquire(0);
}
