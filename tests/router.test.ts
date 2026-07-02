import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickSourceAdapter, pickWorkflowAdapter, resolveWorkflowEnv } from '../src/router.js';

describe('pickSourceAdapter', () => {
  it('returns the github adapter for a github.com URL', async () => {
    const adapter = await pickSourceAdapter('https://github.com/verevoir/context');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the github adapter for a www.github.com URL', async () => {
    const adapter = await pickSourceAdapter('https://www.github.com/verevoir/context');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for an absolute path', async () => {
    const adapter = await pickSourceAdapter('/Users/adam/projects/foo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a tilde path', async () => {
    const adapter = await pickSourceAdapter('~/projects/foo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a relative ./ path', async () => {
    const adapter = await pickSourceAdapter('./relative/path');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a file:// URL', async () => {
    const adapter = await pickSourceAdapter('file:///tmp/repo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the notion adapter for a notion.so URL', async () => {
    const adapter = await pickSourceAdapter(
      'https://www.notion.so/myws/Root-aabbccdd11223344556677889900aabb'
    );
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('throws for an unsupported URL', async () => {
    await expect(pickSourceAdapter('https://gitlab.com/owner/repo')).rejects.toThrow(
      'Unsupported source URL'
    );
  });

  it('throws for a plain hostname', async () => {
    await expect(pickSourceAdapter('example.com/repo')).rejects.toThrow('Unsupported source URL');
  });
});

describe('pickWorkflowAdapter', () => {
  it('returns the trello adapter for a trello board URL', async () => {
    const adapter = await pickWorkflowAdapter('https://trello.com/b/abc123/my-board');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns the trello adapter for a bare trello board URL (no slug)', async () => {
    const adapter = await pickWorkflowAdapter('https://trello.com/b/abc123');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listCards).toBe('function');
  });

  it('returns the notion adapter for a notion.so database URL', async () => {
    const adapter = await pickWorkflowAdapter(
      'https://www.notion.so/myws/369772cdbf9f80ab8900e7b7a96c5422?v=abcdef'
    );
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns an adapter for an absolute path (Obsidian Kanban board)', async () => {
    const adapter = await pickWorkflowAdapter('/abs/path/Board.md');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns an adapter for a file:// board URL (Obsidian Kanban board)', async () => {
    const adapter = await pickWorkflowAdapter('file:///abs/path/Board.md');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('routes a Backlog.md project directory to the backlog adapter, not Obsidian', async () => {
    // Behavioural proof of the directory-vs-.md split: the backlog adapter reads
    // columns from backlog/config.yml; Obsidian would try to parse the path as a
    // board .md and never produce these columns.
    const root = mkdtempSync(join(tmpdir(), 'mcp-router-backlog-'));
    mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'backlog', 'config.yml'), 'statuses:\n  - Todo\n  - Shipped\n');
    try {
      const adapter = await pickWorkflowAdapter(root);
      const columns = await adapter.listColumns({ token: '' }, root);
      expect(columns.map((c) => c.name)).toEqual(['Todo', 'Shipped']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws for a Jira URL', async () => {
    await expect(
      pickWorkflowAdapter('https://myorg.atlassian.net/jira/software/projects/P')
    ).rejects.toThrow('Unsupported board URL');
  });

  it('throws for a bare unsupported string', async () => {
    await expect(pickWorkflowAdapter('gitlab.com/x')).rejects.toThrow('Unsupported board URL');
  });
});

describe('resolveWorkflowEnv', () => {
  it('returns { token: "" } for an absolute path (Obsidian Kanban board)', () => {
    const env = resolveWorkflowEnv('/abs/path/Board.md');
    expect(env).toEqual({ token: '' });
  });

  it('returns { token: "" } for a file:// board URL (Obsidian Kanban board)', () => {
    const env = resolveWorkflowEnv('file:///abs/path/Board.md');
    expect(env).toEqual({ token: '' });
  });

  it('returns { token: "" } for a Backlog.md project directory', () => {
    const env = resolveWorkflowEnv('/abs/path/project');
    expect(env).toEqual({ token: '' });
  });
});
