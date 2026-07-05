import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({})),
}));

import { registerSourceTools } from '../src/tools/source.js';
import { pickSourceAdapter } from '../src/router.js';

/** Capture the tool handlers `registerSourceTools` registers so a test can drive
 * a tool through its real registered handler. */
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function harness(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerSourceTools(server);
  return handlers;
}

/** A mock source adapter over an in-memory file, capturing the write. */
function fileAdapter(initial: string) {
  const state = { content: initial };
  return {
    readFile: vi.fn(async () => ({ content: state.content })),
    writeFile: vi.fn(async (_e: unknown, _u: unknown, _p: unknown, content: string) => {
      state.content = content;
    }),
    state,
  };
}

function reply(res: { content: { text: string }[] }): unknown {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => vi.mocked(pickSourceAdapter).mockReset());

describe('edit-op tools (multi_edit / insert / delete_block)', () => {
  it('registers multi_edit, insert, and delete_block', () => {
    expect(Object.keys(harness())).toEqual(
      expect.arrayContaining(['multi_edit', 'insert', 'delete_block'])
    );
  });

  it('multi_edit applies the edits and returns the total replacement count', async () => {
    const a = fileAdapter('foo bar foo');
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    const res = await harness().multi_edit({
      sourceUrl: '/local',
      path: 'a.txt',
      edits: [{ oldString: 'foo', newString: 'X', replaceAll: true }],
    });
    expect(a.state.content).toBe('X bar X');
    expect(reply(res)).toEqual({ ok: true, replacements: 2 });
  });

  it('insert returns { ok, replacements } — symmetric with edit_file/multi_edit', async () => {
    const a = fileAdapter('hello world');
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    const res = await harness().insert({
      sourceUrl: '/local',
      path: 'a.txt',
      anchor: 'world',
      text: 'big ',
      position: 'before',
    });
    expect(a.state.content).toBe('hello big world');
    expect(reply(res)).toEqual({ ok: true, replacements: 1 });
  });

  it('delete_block returns { ok, replacements } and removes the block', async () => {
    const a = fileAdapter('keep DROP keep');
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    const res = await harness().delete_block({
      sourceUrl: '/local',
      path: 'a.txt',
      block: ' DROP',
    });
    expect(a.state.content).toBe('keep keep');
    expect(reply(res)).toEqual({ ok: true, replacements: 1 });
  });

  it('propagates the op error through the handler and does not write (absent oldString)', async () => {
    const a = fileAdapter('a b c');
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    await expect(
      harness().multi_edit({
        sourceUrl: '/local',
        path: 'a.txt',
        edits: [{ oldString: 'z', newString: 'Z' }],
      })
    ).rejects.toThrow(/not found/);
    expect(a.writeFile).not.toHaveBeenCalled();
  });
});

describe('commit_files tool', () => {
  it('registers commit_files', () => {
    expect(Object.keys(harness())).toEqual(expect.arrayContaining(['commit_files']));
  });

  it('commits the whole file set through the adapter and returns the count', async () => {
    const commitFiles = vi.fn(async () => undefined);
    vi.mocked(pickSourceAdapter).mockResolvedValue({ commitFiles } as never);
    const files = [
      { path: 'a.ts', content: 'A' },
      { path: 'sub/b.ts', content: 'B' },
    ];
    const res = await harness().commit_files({
      sourceUrl: '/local',
      files,
      branch: 'feature',
      commitMessage: 'msg',
    });
    // One atomic adapter call carrying the whole set — not N writeFile calls.
    expect(commitFiles).toHaveBeenCalledTimes(1);
    expect(commitFiles).toHaveBeenCalledWith(expect.anything(), '/local', 'feature', files, 'msg');
    expect(reply(res)).toEqual({ ok: true, files: 2 });
  });

  it('propagates an adapter commit failure through the handler', async () => {
    const commitFiles = vi.fn(async () => {
      throw new Error('ref update rejected');
    });
    vi.mocked(pickSourceAdapter).mockResolvedValue({ commitFiles } as never);
    await expect(
      harness().commit_files({
        sourceUrl: '/local',
        files: [{ path: 'a.ts', content: 'A' }],
        branch: 'feature',
        commitMessage: 'msg',
      })
    ).rejects.toThrow(/ref update rejected/);
  });
});
