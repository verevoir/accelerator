import { afterEach, describe, expect, it, vi } from 'vitest';
import { realpath } from 'node:fs/promises';
import { registerSourceTools } from '../src/tools/source.js';
import type { ToolHost } from '../src/permissions.js';
import { normalizeSourceUrlAsync } from '../src/source-url.js';

vi.mock('node:fs/promises', () => ({ realpath: vi.fn() }));
vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof import('node:fs')>('node:fs')),
  realpathSync: () => {
    throw new Error('async resolution must not block');
  },
}));

vi.mock('../src/router.js', () => ({
  resolveSourceEnv: () => ({}),
  pickSourceAdapter: async () => ({
    readFile: async () => ({ content: 'old' }),
    writeFile: async () => undefined,
    commitFiles: async () => undefined,
    getRepoTree: async () => ({ entries: [] }),
  }),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});
describe('asynchronous source resolution', () => {
  it.each([
    ['read_file', { path: 'entry.ts' }],
    ['write_file', { path: 'entry.ts', content: 'new' }],
    ['edit_file', { path: 'entry.ts', oldString: 'old', newString: 'new' }],
    ['commit_files', { files: [{ path: 'entry.ts', content: 'new' }] }],
    ['code_graph', { symbol: 'target' }],
  ] as const)(
    '%s completes without synchronous path resolution or duplicate lookups',
    async (name, args) => {
      vi.mocked(realpath).mockResolvedValue('/canonical');
      type Handler = (args: Record<string, unknown>) => Promise<unknown>;
      const handlers: Record<string, Handler> = {};
      registerSourceTools({
        registerTool(tool: string, _config: unknown, handler: Handler) {
          handlers[tool] = handler;
        },
      } as unknown as ToolHost);
      await handlers[name]({ sourceUrl: 'file:///alias', ...args });
      expect(realpath).toHaveBeenCalledExactlyOnceWith('/alias');
    }
  );
  it('keeps other work running while a filesystem lookup is pending', async () => {
    let finish!: (path: string) => void;
    vi.mocked(realpath).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        })
    );
    const pending = normalizeSourceUrlAsync('file:///alias');
    expect(await normalizeSourceUrlAsync('https://github.com/o/r')).toBe('https://github.com/o/r');
    finish('/real');
    expect(await pending).toBe('/real');
  });
  it('bounds a stalled filesystem lookup', async () => {
    vi.useFakeTimers();
    vi.mocked(realpath).mockImplementation(() => new Promise<string>(() => {}));
    const pending = expect(normalizeSourceUrlAsync('/stalled')).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves a lexical missing-root identity and clears the timer', async () => {
    vi.useFakeTimers();
    vi.mocked(realpath).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await normalizeSourceUrlAsync('file:///missing/')).toBe('/missing');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('propagates filesystem failures without claiming a canonical identity', async () => {
    const error = Object.assign(new Error('loop'), { code: 'ELOOP' });
    vi.mocked(realpath).mockRejectedValue(error);
    await expect(normalizeSourceUrlAsync('/loop')).rejects.toBe(error);
  });
});
