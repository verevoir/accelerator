import type { SourceAdapter } from '@verevoir/sources';
import { pickSourceAdapter } from './router.js';

export const SOURCE_TIMEOUT_MS = 60_000;
export const SEARCH_TIMEOUT_MS = 300_000;

/** Bound routing and traversal; adapters cannot cancel requests already in flight. */
export async function withinSourceDeadline<T>(
  sourceUrl: string,
  searchDeadline: number,
  action: (adapter: SourceAdapter) => Promise<T>
): Promise<T> {
  const deadline = Math.min(Date.now() + SOURCE_TIMEOUT_MS, searchDeadline);
  const error = new Error(
    deadline === searchDeadline
      ? 'Search deadline exceeded (5 minutes).'
      : 'Source deadline exceeded (60 seconds).'
  );
  if (deadline <= Date.now()) throw error;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(error);
    }, deadline - Date.now());
  });
  async function bounded<R>(operation: () => Promise<R>): Promise<R> {
    if (expired || Date.now() >= deadline) throw error;
    const result = await Promise.race([operation(), timeout]);
    if (expired || Date.now() >= deadline) throw error;
    return result;
  }
  try {
    return await bounded(async () => {
      const adapter = await bounded(() => pickSourceAdapter(sourceUrl));
      // Preserve the receiver for adapters whose methods use internal state.
      const guarded: SourceAdapter = {
        ...adapter,
        getRepoTree: (...args) => bounded(() => adapter.getRepoTree(...args)),
        readFile: (...args) => bounded(() => adapter.readFile(...args)),
      };
      return action(guarded);
    });
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
