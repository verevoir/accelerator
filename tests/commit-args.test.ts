import { describe, it, expect } from 'vitest';
import { commitArgs } from '../src/tools/source.js';

describe('commitArgs', () => {
  it('requires branch + commitMessage for a GitHub source', () => {
    expect(() => commitArgs('https://github.com/owner/repo', undefined, 'msg')).toThrow(
      /GitHub source/
    );
    expect(() => commitArgs('https://github.com/owner/repo', 'main', undefined)).toThrow(
      /GitHub source/
    );
  });

  it('passes them through for a GitHub source when present', () => {
    expect(commitArgs('https://github.com/owner/repo', 'main', 'msg')).toEqual({
      branch: 'main',
      commitMessage: 'msg',
    });
  });

  it('coerces to empty strings for filesystem + Notion sources (commit args ignored)', () => {
    expect(commitArgs('/abs/path')).toEqual({ branch: '', commitMessage: '' });
    expect(commitArgs('file:///tmp/repo')).toEqual({ branch: '', commitMessage: '' });
    expect(commitArgs('https://www.notion.so/abc123')).toEqual({ branch: '', commitMessage: '' });
  });
});
