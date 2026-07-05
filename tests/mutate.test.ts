// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextStore } from '@verevoir/context';
import {
  writeSourceFile,
  editSourceFile,
  multiEditSourceFile,
  insertSourceFile,
  deleteBlockSourceFile,
  commitFilesSource,
} from '../src/mutate.js';

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

  it('multiEditSourceFile applies an atomic list of edits and reports the total count', async () => {
    writeFileSync(join(dir, 'm.txt'), 'foo bar foo baz');
    const r = await multiEditSourceFile(
      dir,
      'm.txt',
      [
        { oldString: 'foo', newString: 'FOO', replaceAll: true },
        { oldString: 'bar', newString: 'BAR' },
      ],
      '',
      ''
    );
    expect(r.replacements).toBe(3);
    expect(readFileSync(join(dir, 'm.txt'), 'utf8')).toBe('FOO BAR FOO baz');
  });

  it('multiEditSourceFile writes nothing when one edit in the list fails (atomic on disk)', async () => {
    writeFileSync(join(dir, 'm.txt'), 'a b c');
    await expect(
      multiEditSourceFile(
        dir,
        'm.txt',
        [
          { oldString: 'a', newString: 'A' },
          { oldString: 'z', newString: 'Z' },
        ],
        '',
        ''
      )
    ).rejects.toThrow(/not found/);
    // applyMultiEdit throws before writeFile runs, so the file on disk is untouched.
    expect(readFileSync(join(dir, 'm.txt'), 'utf8')).toBe('a b c');
  });

  it('insertSourceFile inserts text after a unique anchor', async () => {
    writeFileSync(join(dir, 'i.txt'), 'hello world');
    const r = await insertSourceFile(dir, 'i.txt', 'hello', ' there', 'after', '', '');
    expect(r.replacements).toBe(1);
    expect(readFileSync(join(dir, 'i.txt'), 'utf8')).toBe('hello there world');
  });

  it('deleteBlockSourceFile removes a unique block', async () => {
    writeFileSync(join(dir, 'd.txt'), 'keep DROP keep');
    const r = await deleteBlockSourceFile(dir, 'd.txt', ' DROP', '', '');
    expect(r.replacements).toBe(1);
    expect(readFileSync(join(dir, 'd.txt'), 'utf8')).toBe('keep keep');
  });

  it('invalidates the read cache after a multi_edit (isolated store)', async () => {
    writeFileSync(join(dir, 'm.txt'), 'alpha beta');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'm.txt' };
    store.setContent(key, 'stale cached content');
    await multiEditSourceFile(
      dir,
      'm.txt',
      [{ oldString: 'alpha', newString: 'gamma' }],
      '',
      '',
      store
    );
    expect(store.getContent(key)).toBeUndefined();
  });

  it('does not invalidate the cache when a multi_edit fails', async () => {
    writeFileSync(join(dir, 'm.txt'), 'a b c');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'm.txt' };
    store.setContent(key, 'still valid');
    await expect(
      multiEditSourceFile(dir, 'm.txt', [{ oldString: 'z', newString: 'Z' }], '', '', store)
    ).rejects.toThrow(/not found/);
    expect(store.getContent(key)).toBe('still valid');
  });

  it('insertSourceFile inserts before a unique anchor and invalidates the cache', async () => {
    writeFileSync(join(dir, 'i.txt'), 'hello world');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'i.txt' };
    store.setContent(key, 'stale');
    const r = await insertSourceFile(dir, 'i.txt', 'world', 'big ', 'before', '', '', store);
    expect(r.replacements).toBe(1);
    expect(readFileSync(join(dir, 'i.txt'), 'utf8')).toBe('hello big world');
    expect(store.getContent(key)).toBeUndefined();
  });

  it('invalidates the read cache after a delete_block (isolated store)', async () => {
    writeFileSync(join(dir, 'd.txt'), 'keep DROP keep');
    const store = createContextStore();
    const key = { sourceId: dir, version: '', itemId: 'd.txt' };
    store.setContent(key, 'stale');
    await deleteBlockSourceFile(dir, 'd.txt', ' DROP', '', '', store);
    expect(store.getContent(key)).toBeUndefined();
  });

  it('insertSourceFile propagates applyInsert throws (anchor not found)', async () => {
    writeFileSync(join(dir, 'i.txt'), 'hello world');
    await expect(insertSourceFile(dir, 'i.txt', 'zzz', 'x', 'before', '', '')).rejects.toThrow(
      /anchor not found/
    );
  });

  it('deleteBlockSourceFile propagates applyDeleteBlock throws (non-unique block)', async () => {
    writeFileSync(join(dir, 'd.txt'), 'x and x');
    await expect(deleteBlockSourceFile(dir, 'd.txt', 'x', '', '')).rejects.toThrow(
      /matches 2 times/
    );
  });

  it('commitFilesSource writes the whole file set to the source', async () => {
    await commitFilesSource(
      dir,
      '',
      [
        { path: 'x.txt', content: 'X' },
        { path: 'sub/y.txt', content: 'Y' },
      ],
      ''
    );
    expect(readFileSync(join(dir, 'x.txt'), 'utf8')).toBe('X');
    expect(readFileSync(join(dir, 'sub/y.txt'), 'utf8')).toBe('Y');
  });

  it('invalidates the read cache for every committed file (isolated store)', async () => {
    const store = createContextStore();
    const kx = { sourceId: dir, version: '', itemId: 'x.txt' };
    const ky = { sourceId: dir, version: '', itemId: 'y.txt' };
    store.setContent(kx, 'stale');
    store.setContent(ky, 'stale');
    await commitFilesSource(
      dir,
      '',
      [
        { path: 'x.txt', content: 'X' },
        { path: 'y.txt', content: 'Y' },
      ],
      '',
      store
    );
    expect(store.getContent(kx)).toBeUndefined();
    expect(store.getContent(ky)).toBeUndefined();
  });
});
