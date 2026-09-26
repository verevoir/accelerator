import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { normalizeSourceUrl } from '../src/tools/source.js';

describe('normalizeSourceUrl', () => {
  it.each([
    'https://github.com/o/r/',
    'https://gitlab.com/group/repo/?ref=feature%2Fone',
    'not-a-source',
  ])('preserves remote or unrecognized input %s', (source) => {
    expect(normalizeSourceUrl(source)).toBe(source);
  });
  it('preserves the filesystem root', () => {
    expect(normalizeSourceUrl('file:///')).toBe('/');
  });
  it('resolves dot-relative roots', () => {
    expect(normalizeSourceUrl('./')).toBe(realpathSync('.'));
  });
  it('expands home-relative roots', () => {
    expect(normalizeSourceUrl('~/')).toBe(realpathSync(homedir()));
  });
  it('rejects malformed file URLs', () => {
    expect(() => normalizeSourceUrl('file:///bad%')).toThrow();
  });
  it('converts a file:// URL to its bare absolute path (so warm + query share one key)', () => {
    expect(normalizeSourceUrl('file:///abs/path/repo')).toBe('/abs/path/repo');
    // a path with spaces is percent-decoded by fileURLToPath
    expect(normalizeSourceUrl('file:///abs/my%20repo')).toBe('/abs/my repo');
  });

  it('passes bare paths, GitHub, and Notion URLs through unchanged', () => {
    expect(normalizeSourceUrl('/abs/path/repo')).toBe('/abs/path/repo');
    expect(normalizeSourceUrl('https://github.com/o/r')).toBe('https://github.com/o/r');
    expect(normalizeSourceUrl('https://www.notion.so/abc')).toBe('https://www.notion.so/abc');
  });
});
