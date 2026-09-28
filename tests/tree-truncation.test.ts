import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceAdapter } from '@verevoir/sources';
import type { ToolHost } from '../src/permissions.js';
import { fs as realFs } from '@verevoir/context/fs';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: () => ({ token: '', forkOrg: '' }),
}));
import { pickSourceAdapter } from '../src/router.js';
import { registerSourceTools } from '../src/tools/source.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const handlers: Record<string, Handler> = {};
registerSourceTools({
  registerTool(name: string, _config: unknown, handler: Handler) {
    handlers[name] = handler;
  },
} as unknown as ToolHost);
const tools = ['get_repo_tree', 'grep', 'find_symbol', 'code_graph'];
let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'tree-warning-')));
  writeFileSync(join(dir, 'sample.ts'), 'export function sample() { return 1; }');
});
afterEach(() => {
  vi.resetAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function fixture(truncated: boolean) {
  const adapter: SourceAdapter = {
    ...realFs,
    async readFile(...args) {
      if (this !== adapter) throw new Error('lost read receiver');
      return realFs.readFile(...args);
    },
    getRepoTree: vi.fn(async function (
      this: SourceAdapter,
      ...args: Parameters<SourceAdapter['getRepoTree']>
    ) {
      if (this !== adapter) throw new Error('lost adapter receiver');
      return { ...(await realFs.getRepoTree(...args)), truncated };
    }),
  };
  vi.mocked(pickSourceAdapter).mockResolvedValue(adapter);
  return adapter;
}
const args = () => ({ sourceUrl: dir, pattern: 'absent', name: 'absent', symbol: 'absent' });

describe.each(tools)('%s tree completeness', (tool) => {
  it('warns even when a truncated search has no hits, without a second tree walk', async () => {
    const adapter = fixture(true);
    const result = await handlers[tool](args());
    expect({
      warning: result.content[1]?.text,
      walks: vi.mocked(adapter.getRepoTree).mock.calls.length,
    }).toEqual({
      warning: `⚠ tree truncated at 1 entries [${dir}]; results may be incomplete. Use list_files to inspect narrower directories.`,
      walks: 1,
    });
  });
  it('preserves the first result and adds nothing when the same tree is complete', async () => {
    fixture(false);
    const complete = await handlers[tool](args());
    fixture(true);
    const partial = await handlers[tool](args());
    if (tool === 'get_repo_tree') {
      expect(JSON.parse(complete.content[0].text)).toEqual({
        ...JSON.parse(partial.content[0].text),
        truncated: false,
      });
    } else {
      expect(complete.content).toEqual([partial.content[0]]);
    }
  });
  it('propagates tree failures instead of presenting a complete empty result', async () => {
    const adapter = fixture(false);
    vi.mocked(adapter.getRepoTree).mockRejectedValue(new Error('tree unavailable'));
    await expect(handlers[tool](args())).rejects.toThrow('tree unavailable');
  });
});

it('keeps warning state independent when a shared adapter serves overlapping requests', async () => {
  const adapter = fixture(false);
  vi.mocked(adapter.getRepoTree).mockImplementation(async (_env, _src, ref) => ({
    entries: [],
    truncated: ref === 'partial',
  }));
  const results = await Promise.all(
    ['partial', 'complete'].map((ref) => handlers.find_symbol({ ...args(), ref }))
  );
  expect(results.map((result) => result.content.length)).toEqual([2, 1]);
});

it('does not infer truncation from a tree with exactly 5000 entries', async () => {
  const adapter = fixture(false);
  vi.mocked(adapter.getRepoTree).mockResolvedValue({
    entries: Array.from({ length: 5000 }, (_, i) => ({ path: `dir${i}`, type: 'tree', sha: '' })),
    truncated: false,
  });
  const result = await handlers.get_repo_tree(args());
  expect(result.content.length).toBe(1);
});

it('reports the real filesystem walk cap to callers', async () => {
  for (let i = 0; i < 5000; i++) writeFileSync(join(dir, `file${i}.txt`), '');
  vi.mocked(pickSourceAdapter).mockResolvedValue(realFs);
  const result = await handlers.get_repo_tree(args());
  expect({
    count: JSON.parse(result.content[0].text).entries.length,
    warning: result.content[1]?.text,
  }).toEqual({
    count: 5000,
    warning: `⚠ tree truncated at 5000 entries [${dir}]; results may be incomplete. Use list_files to inspect narrower directories.`,
  });
});

it.each(['grep', 'find_symbol', 'code_graph'])(
  'retains file reads and useful hits through the %s adapter receiver',
  async (tool) => {
    fixture(true);
    const result = await handlers[tool]({
      sourceUrl: dir,
      pattern: 'sample',
      name: 'sample',
      symbol: 'sample',
    });
    expect(result.content[0].text).toContain('sample.ts');
  }
);
