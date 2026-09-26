import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contextStore } from '@verevoir/context';
import type { ToolHost } from '../src/permissions.js';
import { registerSourceTools } from '../src/tools/source.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
describe('refresh_source', () => {
  let root: string;
  let handlers: Record<string, Handler>;
  beforeEach(() => {
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
    contextStore.invalidateVersion(root, '');
    contextStore.invalidateVersion(root, 'feature');
    contextStore.invalidateVersion(root + '-other', '');
    rmSync(root, { recursive: true, force: true });
  });
  it('registers cache refresh in the public tool surface', () => {
    expect(typeof handlers.refresh_source).toBe('function');
  });
  it('makes out-of-band edits visible immediately to read_file', async () => {
    await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    writeFileSync(join(root, 'entry.ts'), 'fresh content');
    await handlers.refresh_source({ sourceUrl: root });
    const result = await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    expect(JSON.parse(result.content[0].text).content).toBe('fresh content');
  });
  it('drops deleted files from the symbol index', async () => {
    await handlers.find_symbol({ sourceUrl: root, name: 'originalName' });
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
    await handlers.code_graph({ sourceUrl: root, symbol: 'target' });
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
  it.each([undefined, 'feature'])(
    'invalidates only the requested ref %s, preserving other sources',
    async (ref) => {
      const keys = [
        { sourceId: root, version: '', itemId: 'entry.ts' },
        { sourceId: root, version: 'feature', itemId: 'entry.ts' },
        { sourceId: root + '-other', version: '', itemId: 'entry.ts' },
      ];
      for (const key of keys) {
        contextStore.setContent(key, 'cached');
        contextStore.setSymbols(key, []);
        contextStore.setEdges(key, { calls: [], imports: [] });
      }
      await handlers.refresh_source({ sourceUrl: root, ref });
      expect(
        keys.map((key) => [
          contextStore.getContent(key),
          contextStore.getSymbols(key),
          contextStore.getEdges(key),
        ])
      ).toEqual(
        keys.map((key) =>
          key.sourceId === root && key.version === (ref ?? '')
            ? [undefined, undefined, undefined]
            : ['cached', [], { calls: [], imports: [] }]
        )
      );
    }
  );
  it('is an idempotent no-op for an uncached remote source without fetching credentials', async () => {
    const args = { sourceUrl: 'https://github.com/refresh-fixture/uncached', ref: 'feature' };
    const first = await handlers.refresh_source(args);
    const second = await handlers.refresh_source(args);
    expect([JSON.parse(first.content[0].text), JSON.parse(second.content[0].text)]).toEqual([
      { ok: true, ...args },
      { ok: true, ...args },
    ]);
  });
});
