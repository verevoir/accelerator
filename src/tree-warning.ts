import type { SourceAdapter } from '@verevoir/sources';

/** Observe the tree already fetched by a query, without another traversal.
 * Each request owns its warnings; methods retain the original adapter receiver. */
export function observeTreeTruncation(source: SourceAdapter) {
  const warnings: { type: 'text'; text: string }[] = [];
  const getRepoTree: SourceAdapter['getRepoTree'] = async (...args) => {
    const tree = await source.getRepoTree(...args);
    if (tree.truncated) {
      warnings.push({
        type: 'text',
        text: `⚠ tree truncated at ${tree.entries.length} entries [${args[1]}]; results may be incomplete. Use list_files to inspect narrower directories.`,
      });
    }
    return tree;
  };
  const adapter = new Proxy(source, {
    get(target, property) {
      if (property === 'getRepoTree') return getRepoTree;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { adapter, warnings: () => [...warnings] };
}
