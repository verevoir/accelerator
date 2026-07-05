import { describe, it, expect } from 'vitest';
import { applyEdit, applyMultiEdit, applyInsert, applyDeleteBlock } from '../src/edit.js';

describe('applyEdit', () => {
  it('replaces a unique occurrence', () => {
    expect(applyEdit('const a = X;', 'X', '1')).toEqual({
      content: 'const a = 1;',
      replacements: 1,
    });
  });

  it('throws when oldString is not found', () => {
    expect(() => applyEdit('abc', 'Z', 'Y')).toThrow(/not found/);
  });

  it('throws on multiple matches without replaceAll', () => {
    expect(() => applyEdit('X and X', 'X', 'Y')).toThrow(/matches 2 times/);
  });

  it('replaces every occurrence with replaceAll', () => {
    expect(applyEdit('X and X', 'X', 'Y', true)).toEqual({ content: 'Y and Y', replacements: 2 });
  });

  it('throws when oldString equals newString', () => {
    expect(() => applyEdit('abc', 'a', 'a')).toThrow(/identical/);
  });

  it('throws on an empty oldString', () => {
    expect(() => applyEdit('abc', '', 'x')).toThrow(/must not be empty/);
  });

  it('does not expand $ patterns in newString (split/join, not String.replace)', () => {
    expect(applyEdit('a X b', 'X', '$& $1')).toEqual({ content: 'a $& $1 b', replacements: 1 });
  });

  it('replaces a multi-line block by exact match', () => {
    const before = 'line1\nold line\nline3';
    const after = 'line1\nnew line\nline3';
    expect(applyEdit(before, 'old line', 'new line')).toEqual({ content: after, replacements: 1 });
  });
});

describe('applyMultiEdit', () => {
  it('applies a sequence of edits correctly', () => {
    const result = applyMultiEdit('a b c d', [
      { oldString: 'a', newString: 'A' },
      { oldString: 'b', newString: 'B' },
      { oldString: 'c', newString: 'C' },
    ]);
    expect(result).toEqual({ content: 'A B C d', replacements: 3 });
  });

  it('reports the total replacement count', () => {
    const result = applyMultiEdit('x x x', [
      { oldString: 'x', newString: 'y', replaceAll: true },
      { oldString: 'y', newString: 'z', replaceAll: true },
    ]);
    expect(result).toEqual({ content: 'z z z', replacements: 6 });
  });

  it('throws when edits array is empty', () => {
    expect(() => applyMultiEdit('anything', [])).toThrow(/edits array must not be empty/);
  });

  it('throws when any edit has empty oldString', () => {
    expect(() =>
      applyMultiEdit('abc', [
        { oldString: 'a', newString: 'A' },
        { oldString: '', newString: 'X' },
      ])
    ).toThrow(/oldString must not be empty/);
  });

  it('throws when any edit has identical oldString and newString', () => {
    expect(() =>
      applyMultiEdit('abc', [
        { oldString: 'a', newString: 'A' },
        { oldString: 'b', newString: 'b' },
      ])
    ).toThrow(/identical/);
  });

  it('throws when any edit has oldString not found', () => {
    expect(() =>
      applyMultiEdit('abc', [
        { oldString: 'a', newString: 'A' },
        { oldString: 'z', newString: 'Z' },
      ])
    ).toThrow(/not found/);
  });

  it('throws when any edit has ambiguous match without replaceAll', () => {
    expect(() => applyMultiEdit('x x', [{ oldString: 'x', newString: 'y' }])).toThrow(
      /matches 2 times/
    );
  });

  it('is atomic: when one edit fails, no partial result is produced', () => {
    const content = 'a b c';
    expect(() =>
      applyMultiEdit(content, [
        { oldString: 'a', newString: 'A' },
        { oldString: 'z', newString: 'Z' },
      ])
    ).toThrow(/not found/);
  });

  it('allows replaceAll on individual edits', () => {
    const result = applyMultiEdit('foo bar foo baz', [
      { oldString: 'foo', newString: 'FOO', replaceAll: true },
      { oldString: 'bar', newString: 'BAR' },
    ]);
    expect(result).toEqual({ content: 'FOO BAR FOO baz', replacements: 3 });
  });
});

describe('applyInsert', () => {
  it('inserts text before a unique anchor', () => {
    const result = applyInsert('hello world', 'world', 'beautiful ', 'before');
    expect(result).toEqual({ content: 'hello beautiful world', replacements: 1 });
  });

  it('inserts text after a unique anchor', () => {
    const result = applyInsert('hello world', 'hello', ' there', 'after');
    expect(result).toEqual({ content: 'hello there world', replacements: 1 });
  });

  it('throws when anchor is empty', () => {
    expect(() => applyInsert('abc', '', 'x', 'before')).toThrow(/anchor must not be empty/);
  });

  it('throws when text is empty (a no-op insert)', () => {
    expect(() => applyInsert('abc', 'a', '', 'before')).toThrow(/text must not be empty/);
  });

  it('throws when anchor is not found', () => {
    expect(() => applyInsert('abc', 'z', 'x', 'before')).toThrow(/anchor not found/);
  });

  it('throws when anchor matches more than once', () => {
    expect(() => applyInsert('x and x', 'x', 'y', 'before')).toThrow(/matches 2 times/);
  });

  it('handles multi-line anchor', () => {
    const content = 'line1\nline2\nline3';
    const result = applyInsert(content, 'line2\n', 'inserted\n', 'after');
    expect(result.content).toBe('line1\nline2\ninserted\nline3');
  });

  it('does not expand $ patterns in inserted text (split/join, not String.replace)', () => {
    const result = applyInsert('a X b', 'X', '$& $1 ', 'before');
    expect(result).toEqual({ content: 'a $& $1 X b', replacements: 1 });
  });

  it('inserts before an anchor at the start of content', () => {
    const result = applyInsert('start end', 'start', '>> ', 'before');
    expect(result).toEqual({ content: '>> start end', replacements: 1 });
  });

  it('inserts after an anchor at the end of content', () => {
    const result = applyInsert('start end', 'end', ' <<', 'after');
    expect(result).toEqual({ content: 'start end <<', replacements: 1 });
  });
});

describe('applyDeleteBlock', () => {
  it('deletes a unique block', () => {
    const result = applyDeleteBlock('hello world', 'world');
    expect(result).toEqual({ content: 'hello ', replacements: 1 });
  });

  it('throws when block is empty', () => {
    expect(() => applyDeleteBlock('abc', '')).toThrow(/block must not be empty/);
  });

  it('throws when block is not found', () => {
    expect(() => applyDeleteBlock('abc', 'z')).toThrow(/block not found/);
  });

  it('throws when block matches more than once', () => {
    expect(() => applyDeleteBlock('x and x', 'x')).toThrow(/matches 2 times/);
  });

  it('deletes a multi-line block', () => {
    const content = 'line1\nline2\nline3';
    const result = applyDeleteBlock(content, 'line2\n');
    expect(result.content).toBe('line1\nline3');
  });

  it('deletes block at start of content', () => {
    const result = applyDeleteBlock('start middle end', 'start ');
    expect(result.content).toBe('middle end');
  });

  it('deletes block at end of content', () => {
    const result = applyDeleteBlock('start middle end', ' end');
    expect(result.content).toBe('start middle');
  });
});
