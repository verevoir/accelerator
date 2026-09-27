import { normalizeSourceUrl } from './source-url.js';
import { contextStore, type ContextStore } from '@verevoir/context';

/** Synchronous compatibility API; resolving a local alias can block indefinitely.
 * Async mutations instead pass an already-resolved identity to the helper below.
 */
export function invalidateWrittenFile(
  sourceUrl: string,
  path: string,
  branch: string,
  store: ContextStore = contextStore
): void {
  invalidateCanonicalWrittenFile(normalizeSourceUrl(sourceUrl), path, branch, store);
}

/** Invalidate an already-resolved source identity without filesystem I/O.
 * Mutation operations use the identity resolved before their write.
 */
export function invalidateCanonicalWrittenFile(
  sourceUrl: string,
  path: string,
  branch: string,
  store: ContextStore = contextStore
): void {
  // Both ref scopes: a prior warm could have keyed the file under the
  // default ref or under the write's branch.
  store.invalidateItem({ sourceId: sourceUrl, version: '', itemId: path });
  if (branch) {
    store.invalidateItem({ sourceId: sourceUrl, version: branch, itemId: path });
  }
}
