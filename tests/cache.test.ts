import { describe, it, expect } from 'vitest';
import { createContextStore } from '@verevoir/context';
import { invalidateWrittenFile } from '../src/cache.js';

describe('invalidateWrittenFile', () => {
  const key = { sourceId: '/repo', version: '', itemId: 'a.ts' };

  it('write drops the file from the shared read cache', () => {
    const store = createContextStore();
    store.setContent(key, 'pre-write content');
    invalidateWrittenFile('/repo', 'a.ts', 'main', store);
    expect(store.getContent(key)).toBeUndefined();
  });

  it('next search re-fetches and re-indexes after a write', () => {
    const store = createContextStore();
    store.setContent(key, 'pre-write content');
    store.setSymbols(key, [{ name: 'foo', kind: 'function', startLine: 1, endLine: 3 }]);
    invalidateWrittenFile('/repo', 'a.ts', 'main', store);
    expect(store.getContent(key)).toBeUndefined();
    expect(store.getSymbols(key)).toBeUndefined();
  });

  it('drops a branch-scoped entry too (interim until a primary key — STDIO-164)', () => {
    const store = createContextStore();
    const branchKey = { sourceId: '/repo', version: 'main', itemId: 'a.ts' };
    store.setContent(branchKey, 'pre-write content');
    invalidateWrittenFile('/repo', 'a.ts', 'main', store);
    expect(store.getContent(branchKey)).toBeUndefined();
  });

  it('leaves other files untouched', () => {
    const store = createContextStore();
    const other = { sourceId: '/repo', version: '', itemId: 'b.ts' };
    store.setContent(other, 'other content');
    invalidateWrittenFile('/repo', 'a.ts', 'main', store);
    expect(store.getContent(other)).toBe('other content');
  });
});
