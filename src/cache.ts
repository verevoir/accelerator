import { contextStore, type ContextStore } from '@verevoir/context';

export function invalidateWrittenFile(
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
