import { describe, it, expect } from 'vitest';
import { jsonText } from '../src/result.js';

describe('jsonText', () => {
  it('returns a plain string unchanged', () => {
    expect(jsonText('hello\nworld')).toBe('hello\nworld');
  });

  it('expands escaped newlines in string fields to real newlines', () => {
    const out = jsonText({ content: 'line1\nline2', sha: 'abc' });
    expect(out).toContain('line1\nline2'); // real newline, not the literal \n
    expect(out).not.toContain('line1\\nline2');
    expect(out).toContain('"sha": "abc"'); // structure preserved + indented
  });

  it('expands escaped quotes inside string values', () => {
    const out = jsonText({ msg: 'he said "hi"' });
    expect(out).toContain('he said "hi"');
  });

  it('pretty-prints structured values with indentation', () => {
    expect(jsonText({ ok: true })).toBe('{\n  "ok": true\n}');
  });
});
