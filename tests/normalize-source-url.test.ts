import { describe, it, expect } from 'vitest';
import { normalizeSourceUrl } from '../src/tools/source.js';

describe('normalizeSourceUrl', () => {
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
