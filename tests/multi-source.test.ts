import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContextStore } from '@verevoir/context';
import type { SourceAdapter } from '@verevoir/sources';
import type { ToolHost } from '../src/permissions.js';
import { registerSourceTools } from '../src/tools/source.js';
import { buildMultiSourceNeighbourhood } from '../src/graph.js';
import { resolveSourceUrls } from '../src/source-selection.js';
import { pickSourceAdapter } from '../src/router.js';

vi.mock('../src/router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/router.js')>();
  return { ...actual, pickSourceAdapter: vi.fn(actual.pickSourceAdapter) };
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function handlers(): Record<string, Handler> {
  const result: Record<string, Handler> = {};
  registerSourceTools({
    registerTool(name: string, _config: unknown, handler: Handler) {
      result[name] = handler;
    },
  } as unknown as ToolHost);
  return result;
}

const CALLER = `import { threeWayMerge } from 'schema';\nexport function runSync() { return threeWayMerge(); }`;
const CALLEE = 'export function threeWayMerge() { return 42; }';

describe('source selection', () => {
  it('deduplicates sources without reordering them', () => {
    expect(resolveSourceUrls({ sourceUrls: ['/b', '/a', '/b'] })).toEqual(['/b', '/a']);
  });

  it('preserves a single source', () => {
    expect(resolveSourceUrls({ sourceUrl: '/a' })).toEqual(['/a']);
  });

  it.each([
    {},
    { sourceUrl: '/a', sourceUrls: ['/b'] },
    { sourceUrls: [] },
    { sourceUrl: '' },
    { sourceUrls: ['  '] },
    { sourceUrls: ['/a', ''] },
  ])('rejects ambiguous or empty selection %j', (selection) => {
    expect(() => resolveSourceUrls(selection)).toThrow();
  });
});

describe('MCP searches across independent repositories', () => {
  let root: string;
  let core: string;
  let schema: string;
  let tools: Record<string, Handler>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'accelerator-multi-')));
    core = join(root, 'core');
    schema = join(root, 'schema');
    mkdirSync(core);
    mkdirSync(schema);
    writeFileSync(join(core, 'index.ts'), CALLER);
    writeFileSync(join(schema, 'index.ts'), CALLEE);
    tools = handlers();
    vi.mocked(pickSourceAdapter).mockClear();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.mocked(pickSourceAdapter).mockRestore();
  });

  it('resolves runSync to threeWayMerge in another repository', async () => {
    const result = await tools.code_graph({ sourceUrls: [core, schema], symbol: 'runSync' });
    expect(result.content[0].text).toContain(`calls: [${schema}] threeWayMerge`);
  });

  it('labels the definition and incoming caller with their repositories', async () => {
    const result = await tools.code_graph({ sourceUrls: [core, schema], symbol: 'threeWayMerge' });
    expect(result.content[0].text).toBe(
      '`threeWayMerge` — defined at [' +
        schema +
        '] index.ts:1 (function)\n' +
        'called by: runSync ([' +
        core +
        '] index.ts:2)\ncalls: none\n' +
        'imported by: [' +
        core +
        '] index.ts'
    );
  });

  it('finds symbols in both repositories with source identities', async () => {
    const result = await tools.find_symbol({ sourceUrls: [core, schema], name: '' });
    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        sourceId: core,
        itemId: 'index.ts',
        name: 'runSync',
        kind: 'function',
        startLine: 2,
        endLine: 2,
      },
      {
        sourceId: schema,
        itemId: 'index.ts',
        name: 'threeWayMerge',
        kind: 'function',
        startLine: 1,
        endLine: 1,
      },
    ]);
  });

  it('keeps same-path grep results distinct across sources', async () => {
    const result = await tools.grep({
      sourceUrls: [core, schema],
      pattern: 'export function',
      maxResults: 2,
    });
    const hits = JSON.parse(result.content[0].text);
    expect(
      hits.map(({ sourceId, itemId }: { sourceId: string; itemId: string }) => ({
        sourceId,
        itemId,
      }))
    ).toEqual([
      { sourceId: core, itemId: 'index.ts' },
      { sourceId: schema, itemId: 'index.ts' },
    ]);
  });

  it('returns large grep result sets without exceeding function argument limits', async () => {
    const hitCount = 150_000;
    writeFileSync(join(core, 'index.ts'), '');
    writeFileSync(join(core, 'large.txt'), 'x\n'.repeat(hitCount));
    const result = await tools.grep({ sourceUrl: core, pattern: 'x', maxResults: hitCount });
    expect(JSON.parse(result.content[0].text)).toHaveLength(hitCount);
  });

  it('applies one total grep budget in source order', async () => {
    writeFileSync(join(schema, 'index.ts'), CALLEE + '\nexport function extra() {}');
    const limited = await tools.grep({
      sourceUrls: [core, schema],
      pattern: 'export function',
      maxResults: 2,
    });
    expect(
      JSON.parse(limited.content[0].text).map((hit: { sourceId: string }) => hit.sourceId)
    ).toEqual([core, schema]);
  });

  it('does not repeat results for duplicate sources or equivalent file URLs', async () => {
    const result = await tools.find_symbol({
      sourceUrls: [core, pathToFileURL(core).href, core],
      name: 'runSync',
    });
    expect(JSON.parse(result.content[0].text)).toHaveLength(1);
  });

  it('preserves the single-source graph rendering', async () => {
    const result = await tools.code_graph({ sourceUrl: core, symbol: 'runSync' });
    expect(result.content[0].text).toBe(
      '`runSync` — defined at index.ts:2 (function)\ncalled by: none\ncalls: none\nimported by: none'
    );
  });

  it('labels graph locations when sourceUrls contains only one source', async () => {
    const result = await tools.code_graph({ sourceUrls: [schema], symbol: 'threeWayMerge' });
    expect(result.content[0].text).toContain(`defined at [${schema}] index.ts:1`);
  });

  it.each(['grep', 'find_symbol', 'code_graph'])(
    'rejects ambiguous selectors in %s',
    async (name) => {
      await expect(
        tools[name]({
          sourceUrl: core,
          sourceUrls: [schema],
          name: '',
          symbol: 'runSync',
          pattern: 'export',
        })
      ).rejects.toThrow('exactly one');
    }
  );

  it.each(['grep', 'find_symbol', 'code_graph'])(
    'reports the failing source instead of partial success in %s',
    async (name) => {
      const failing = 'https://gitlab.com/group/unreachable';
      const actual = await vi.importActual<typeof import('../src/router.js')>('../src/router.js');
      vi.mocked(pickSourceAdapter).mockImplementation(async (url) => {
        if (url === failing) throw new Error('unavailable');
        return actual.pickSourceAdapter(url);
      });
      await expect(
        tools[name]({ sourceUrls: [core, failing], name: '', symbol: 'runSync', pattern: 'export' })
      ).rejects.toThrow(`Source ${failing} failed: unavailable`);
    }
  );

  it('mixes local and GitLab sources with independently routed adapters', async () => {
    const remote = `https://gitlab.com/group/${root.split('/').pop()}`;
    const getRepoTree = vi.fn(async () => ({
      entries: [{ path: 'index.ts', type: 'blob' }],
      truncated: false,
    }));
    const readFile = vi.fn(async () => ({ content: CALLEE, sha: 'remote-sha' }));
    const adapter = { getRepoTree, readFile } as unknown as SourceAdapter;
    const actual = await vi.importActual<typeof import('../src/router.js')>('../src/router.js');
    vi.mocked(pickSourceAdapter).mockImplementation(async (url) =>
      url === remote ? adapter : actual.pickSourceAdapter(url)
    );
    const result = await tools.code_graph({ sourceUrls: [core, remote], symbol: 'runSync' });
    expect(result.content[0].text).toContain(`calls: [${remote}] threeWayMerge`);
    expect(getRepoTree).toHaveBeenCalledWith(expect.anything(), remote, undefined);
    expect(readFile).toHaveBeenCalledWith(expect.anything(), remote, 'index.ts', undefined);
  });

  it('forwards a shared ref to each remote source', async () => {
    const sources = ['https://gitlab.com/group/core', 'https://gitlab.com/group/schema'];
    const getRepoTree = vi.fn(async () => ({ entries: [], truncated: false }));
    vi.mocked(pickSourceAdapter).mockResolvedValue({ getRepoTree } as unknown as SourceAdapter);
    await tools.find_symbol({ sourceUrls: sources, name: 'threeWayMerge', ref: 'feature' });
    expect(getRepoTree.mock.calls).toEqual(
      sources.map((source) => [expect.anything(), source, 'feature'])
    );
  });

  it('reuses a remote source cache warmed by an earlier single-source query', async () => {
    const remote = `https://gitlab.com/group/${root.split('/').pop()}`;
    const getRepoTree = vi.fn(async () => ({
      entries: [{ path: 'index.ts', type: 'blob' }],
      truncated: false,
    }));
    const readFile = vi.fn(async () => ({ content: CALLEE, sha: 'remote-sha' }));
    const adapter = { getRepoTree, readFile } as unknown as SourceAdapter;
    const actual = await vi.importActual<typeof import('../src/router.js')>('../src/router.js');
    vi.mocked(pickSourceAdapter).mockImplementation(async (url) =>
      url === remote ? adapter : actual.pickSourceAdapter(url)
    );
    await tools.find_symbol({ sourceUrl: remote, name: 'threeWayMerge' });
    await tools.code_graph({ sourceUrls: [core, remote], symbol: 'runSync' });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});

describe('combined graph identity', () => {
  it('retains same-name callers and imports at identical paths in different sources', () => {
    const store = createContextStore();
    for (const sourceId of ['/a', '/b']) {
      store.setContent({ sourceId, version: '', itemId: 'index.ts' }, CALLER);
    }
    const nb = buildMultiSourceNeighbourhood(
      store,
      ['/a', '/b'].map((sourceId) => ({ sourceId, version: '' })),
      'threeWayMerge'
    );
    expect(nb).toMatchObject({
      callers: [
        { sourceId: '/a', from: 'runSync', file: 'index.ts', line: 2 },
        { sourceId: '/b', from: 'runSync', file: 'index.ts', line: 2 },
      ],
      importedBy: [
        { sourceId: '/a', file: 'index.ts' },
        { sourceId: '/b', file: 'index.ts' },
      ],
    });
  });

  it('labels every possible callee source for ambiguous names', () => {
    const store = createContextStore();
    store.setContent({ sourceId: '/core', version: '', itemId: 'index.ts' }, CALLER);
    for (const sourceId of ['/a', '/b']) {
      store.setContent({ sourceId, version: '', itemId: 'index.ts' }, CALLEE);
    }
    const nb = buildMultiSourceNeighbourhood(
      store,
      ['/core', '/a', '/b'].map((sourceId) => ({ sourceId, version: '' })),
      'runSync'
    );
    expect(nb.callees).toEqual([
      { sourceId: '/a', name: 'threeWayMerge' },
      { sourceId: '/b', name: 'threeWayMerge' },
    ]);
  });
});
