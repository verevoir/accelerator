import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type * as Context from '@verevoir/context';
import type { ToolHost } from '../src/permissions.js';
import { createContextStore } from '@verevoir/context';
import * as router from '../src/router.js';
import { registerSourceTools } from '../src/tools/source.js';
// Each case owns a fresh store. Bind every real cache entry point, including
// the filesystem adapter's inner cache and symbol lookup, to that same store.
const isolated = vi.hoisted(() => ({ store: undefined as unknown as Context.ContextStore }));
vi.mock('@verevoir/context', async () => {
  const actual = await vi.importActual<typeof Context>('@verevoir/context');
  return {
    ...actual,
    get contextStore() {
      return isolated.store;
    },
    wrapWithCache: (...[adapter, options]: Parameters<typeof actual.wrapWithCache>) =>
      actual.wrapWithCache(adapter, { ...options, store: options?.store ?? isolated.store }),
    warmSource: (...[adapter, env, url, options]: Parameters<typeof actual.warmSource>) =>
      actual.warmSource(adapter, env, url, { ...options, store: options?.store ?? isolated.store }),
    grepSource: (...[adapter, env, url, pattern, options]: Parameters<typeof actual.grepSource>) =>
      actual.grepSource(adapter, env, url, pattern, {
        ...options,
        store: options?.store ?? isolated.store,
      }),
  };
});
vi.mock('@verevoir/context/fs', async () => {
  const { fs } =
    await vi.importActual<typeof import('@verevoir/sources/fs')>('@verevoir/sources/fs');
  const { wrapWithCache } = await vi.importActual<typeof Context>('@verevoir/context');
  return {
    get fs() {
      return wrapWithCache(fs, { store: isolated.store });
    },
  };
});
vi.mock('@verevoir/context/code', async () => {
  const actual =
    await vi.importActual<typeof import('@verevoir/context/code')>('@verevoir/context/code');
  return {
    ...actual,
    findSymbols: (...[name, scope, options]: Parameters<typeof actual.findSymbols>) =>
      actual.findSymbols(name, scope, { ...options, store: options?.store ?? isolated.store }),
  };
});

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
describe('refresh_source', () => {
  let root: string;
  let contextStore: Context.ContextStore;
  let handlers: Record<string, Handler>;
  beforeEach(() => {
    contextStore = isolated.store = createContextStore();
    root = realpathSync(mkdtempSync(join(tmpdir(), 'refresh-source-')));
    writeFileSync(join(root, 'entry.ts'), 'export function originalName() { return 1; }');
    handlers = {};
    registerSourceTools({
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers[name] = handler;
      },
    } as unknown as ToolHost);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  it('registers cache refresh in the public tool surface', () => {
    expect(typeof handlers.refresh_source).toBe('function');
  });
  it.each([{ sourceUrl: '' }, {}])(
    'rejects invalid source selection %j through MCP',
    async (args) => {
      const server = new McpServer({ name: 'refresh-test', version: '1.0.0' });
      registerSourceTools(server);
      const client = new Client({
        name: 'refresh-test-client',
        version: '1.0.0',
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: 'refresh_source',
          arguments: args,
        });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          {
            type: 'text',
            text: expect.stringMatching(/Input validation error:[\s\S]*sourceUrl/),
          },
        ]);
      } finally {
        await client.close();
        await server.close();
      }
    }
  );
  it('makes out-of-band edits visible immediately to read_file', async () => {
    await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    writeFileSync(join(root, 'entry.ts'), 'fresh content');
    await handlers.refresh_source({ sourceUrl: root });
    const result = await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    expect(JSON.parse(result.content[0].text).content).toBe('fresh content');
  });
  it('drops deleted files from the symbol index', async () => {
    const initial = await handlers.find_symbol({ sourceUrl: root, name: 'originalName' });
    expect(JSON.parse(initial.content[0].text)).toEqual([
      expect.objectContaining({ name: 'originalName' }),
    ]);
    unlinkSync(join(root, 'entry.ts'));
    await handlers.refresh_source({ sourceUrl: root });
    expect(
      JSON.parse(
        (await handlers.find_symbol({ sourceUrl: root, name: 'originalName' })).content[0].text
      )
    ).toEqual([]);
  });
  it('rebuilds graph edges after an out-of-band edit', async () => {
    writeFileSync(
      join(root, 'entry.ts'),
      'export function target() {} export function caller() { target(); }'
    );
    const initial = await handlers.code_graph({ sourceUrl: root, symbol: 'target' });
    expect(initial.content[0].text).toContain('called by: caller');
    writeFileSync(
      join(root, 'entry.ts'),
      'export function target() {} export function caller() {}'
    );
    await handlers.refresh_source({ sourceUrl: root });
    const result = await handlers.code_graph({ sourceUrl: root, symbol: 'target' });
    expect(result.content[0].text).toContain('called by: none');
  });
  it('refreshes a path cache through its file URL', async () => {
    await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    writeFileSync(join(root, 'entry.ts'), 'changed through alias');
    await handlers.refresh_source({ sourceUrl: pathToFileURL(root).href });
    expect(
      JSON.parse((await handlers.read_file({ sourceUrl: root, path: 'entry.ts' })).content[0].text)
        .content
    ).toBe('changed through alias');
  });
  it('refreshes file URL reads cached by the real wrapper', async () => {
    const sourceUrl = pathToFileURL(root).href;
    let content = 'before refresh';
    // Local file URL adapter support is separate from refresh. Keep the real
    // cache wrapper and tool handlers, substituting only backend I/O.
    const readFile = vi.fn(async () => ({ content }));
    vi.spyOn(router, 'pickSourceAdapter').mockResolvedValue({ readFile } as never);
    await handlers.read_file({ sourceUrl, path: 'entry.ts' });
    expect(contextStore.getContent({ sourceId: sourceUrl, version: '', itemId: 'entry.ts' })).toBe(
      content
    );
    content = 'after refresh';
    await handlers.refresh_source({ sourceUrl });
    const result = await handlers.read_file({ sourceUrl, path: 'entry.ts' });
    expect(JSON.parse(result.content[0].text).content).toBe(content);
    expect(readFile).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, 'feature'])(
    'invalidates only the requested ref %s, preserving other sources',
    async (ref) => {
      const keys = [
        { sourceId: root, version: '', itemId: 'entry.ts' },
        { sourceId: root, version: 'feature', itemId: 'entry.ts' },
        { sourceId: pathToFileURL(root).href, version: '', itemId: 'entry.ts' },
        { sourceId: pathToFileURL(root).href, version: 'feature', itemId: 'entry.ts' },
        { sourceId: root + '-other', version: '', itemId: 'entry.ts' },
      ];
      for (const key of keys) {
        contextStore.setContent(key, 'cached');
        contextStore.setSymbols(key, []);
        contextStore.setEdges(key, { calls: [], imports: [] });
      }
      await handlers.refresh_source({ sourceUrl: pathToFileURL(root).href, ref });
      expect(
        keys.map((key) => [
          contextStore.getContent(key),
          contextStore.getSymbols(key),
          contextStore.getEdges(key),
        ])
      ).toEqual(
        keys.map((key) =>
          key.sourceId !== root + '-other' && key.version === (ref ?? '')
            ? [undefined, undefined, undefined]
            : ['cached', [], { calls: [], imports: [] }]
        )
      );
    }
  );
  it('is an idempotent no-op for an uncached remote source without fetching credentials', async () => {
    const credentials = vi.spyOn(router, 'resolveSourceEnv').mockImplementation(() => {
      throw new Error('refresh must not resolve credentials');
    });
    const adapter = vi.spyOn(router, 'pickSourceAdapter').mockImplementation(() => {
      throw new Error('refresh must not select a backend');
    });
    const args = { sourceUrl: 'https://github.com/refresh-fixture/uncached', ref: 'feature' };
    const first = await handlers.refresh_source(args);
    const second = await handlers.refresh_source(args);
    expect(credentials).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
    expect([JSON.parse(first.content[0].text), JSON.parse(second.content[0].text)]).toEqual([
      { ok: true, ...args },
      { ok: true, ...args },
    ]);
  });
});
