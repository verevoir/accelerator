import { describe, it, expect } from 'vitest';
import { applyEdit } from '../src/edit.js';

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
