// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore } from '@verevoir/context';
import { writeSourceFile, editSourceFile } from '../src/mutate.js';

describe('mutate cycle (local source)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mutate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeSourceFile writes full contents to the source', async () => {
    await writeSourceFile(dir, 'a.txt', 'hello world', '', '');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello world');
  });

  it('invalidates the read cache after a write (isolated store)', async () => {
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'cached.txt' };
    store.setContent(key, 'stale cached content');
    await writeSourceFile(dir, 'cached.txt', 'fresh on disk', '', '', store);
    expect(store.getContent(key)).toBeUndefined();
  });

  it('does not invalidate the cache when a write fails', async () => {
    // A file at the parent path makes the adapter's mkdir fail, so the write rejects
    // before invalidate would run — the still-valid entry must survive.
    writeFileSync(join(dir, 'blocker'), 'not a directory');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'blocker/x.txt' };
    store.setContent(key, 'still valid');
    await expect(writeSourceFile(dir, 'blocker/x.txt', 'new', '', '', store)).rejects.toThrow();
    expect(store.getContent(key)).toBe('still valid');
  });

  it('editSourceFile reads, applies the edit, writes back, and reports the count', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo bar foo');
    const r = await editSourceFile(dir, 'a.txt', 'foo', 'baz', true, '', '');
    expect(r.replacements).toBe(2);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('baz bar baz');
  });

  it('invalidates the read cache after an edit (isolated store)', async () => {
    writeFileSync(join(dir, 'e.txt'), 'alpha beta');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'e.txt' };
    store.setContent(key, 'stale cached content');
    await editSourceFile(dir, 'e.txt', 'alpha', 'gamma', false, '', '', store);
    expect(store.getContent(key)).toBeUndefined();
  });

  it('does not invalidate the cache when an edit cannot complete', async () => {
    // Same invariant as the write path: invalidate is the last step, so an edit that
    // throws before it (here the read, under a file-as-parent path) leaves the entry.
    writeFileSync(join(dir, 'blk'), 'not a directory');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'blk/y.txt' };
    store.setContent(key, 'still valid');
    await expect(
      editSourceFile(dir, 'blk/y.txt', 'x', 'y', false, '', '', store)
    ).rejects.toThrow();
    expect(store.getContent(key)).toBe('still valid');
  });

  it('editSourceFile propagates applyEdit throws (non-unique anchor without replaceAll)', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x x');
    await expect(editSourceFile(dir, 'a.txt', 'x', 'y', false, '', '')).rejects.toThrow(
      /matches 2 times/
    );
  });
});
