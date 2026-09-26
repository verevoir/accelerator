import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolHost } from '../src/permissions.js';
import { registerSourceTools, normalizeSourceUrl } from '../src/tools/source.js';
import { queryCodeGraph } from '../src/graph.js';
import { invalidateWrittenFile } from '../src/cache.js';
import { contextStore } from '@verevoir/context';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
describe('local source aliases', () => {
  let dir: string;
  let root: string;
  let aliases: string[];
  let handlers: Record<string, Handler>;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'source-alias-')));
    root = join(dir, 'repo with spaces');
    mkdirSync(root);
    symlinkSync(root, join(dir, 'alias'));
    aliases = [root + '/', pathToFileURL(root).href, join(dir, 'alias')];
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
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([0, 1, 2])('canonicalizes alias %i to the real source', (index) => {
    expect(normalizeSourceUrl(aliases[index])).toBe(root);
  });
  it.each([0, 1, 2])(
    'read and grep through alias %i use the already warmed cache',
    async (index) => {
      await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
      writeFileSync(join(root, 'entry.ts'), 'out of band');
      const read = await handlers.read_file({ sourceUrl: aliases[index], path: 'entry.ts' });
      const grep = await handlers.grep({ sourceUrl: aliases[index], pattern: 'originalName' });
      expect({
        read: JSON.parse(read.content[0].text).content,
        hits: JSON.parse(grep.content[0].text).map((hit: { sourceId: string }) => hit.sourceId),
      }).toEqual({ read: 'export function originalName() { return 1; }', hits: [root] });
    }
  );
  it.each([0, 1, 2])(
    'write through alias %i invalidates canonical symbols and content',
    async (index) => {
      await handlers.find_symbol({ sourceUrl: root, name: 'originalName' });
      await handlers.write_file({
        sourceUrl: aliases[index],
        path: 'entry.ts',
        content: 'export function replacementName() { return 2; }',
      });
      const old = await handlers.find_symbol({ sourceUrl: root, name: 'originalName' });
      const read = await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
      expect({
        old: JSON.parse(old.content[0].text),
        content: JSON.parse(read.content[0].text).content,
      }).toEqual({ old: [], content: 'export function replacementName() { return 2; }' });
    }
  );
  it.each(['list_files', 'get_repo_tree', 'find_symbol', 'code_graph'])(
    '%s gives the same result through every alias',
    async (name) => {
      const args = { name: 'originalName', symbol: 'originalName' };
      const expected = await handlers[name]({ sourceUrl: root, ...args });
      expect(
        await Promise.all(aliases.map((sourceUrl) => handlers[name]({ sourceUrl, ...args })))
      ).toEqual(aliases.map(() => expected));
    }
  );
  it('graph queries through aliases reuse canonical cached definitions', async () => {
    const expected = await handlers.code_graph({ sourceUrl: root, symbol: 'originalName' });
    writeFileSync(join(root, 'entry.ts'), 'export function differentName() {}');
    expect(
      await Promise.all(
        aliases.map((sourceUrl) => handlers.code_graph({ sourceUrl, symbol: 'originalName' }))
      )
    ).toEqual(aliases.map(() => expected));
  });
  it('edit_file through a file URL invalidates the canonical read cache', async () => {
    await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    await handlers.edit_file({
      sourceUrl: aliases[1],
      path: 'entry.ts',
      oldString: 'originalName',
      newString: 'editedName',
    });
    const result = await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
    expect(JSON.parse(result.content[0].text).content).toBe(
      'export function editedName() { return 1; }'
    );
  });
  it.each([0, 1, 2])(
    'exported graph query resolves alias %i without the tool handler',
    async (index) => {
      await handlers.find_symbol({ sourceUrl: root, name: 'originalName' });
      expect(queryCodeGraph(aliases[index], '', 'originalName')).toContain('defined at entry.ts:1');
    }
  );
  it.each([0, 1, 2])('exported invalidation through alias %i clears both ref scopes', (index) => {
    for (const version of ['', 'feature']) {
      const key = { sourceId: root, version, itemId: 'entry.ts' };
      contextStore.setContent(key, 'stale');
      contextStore.setSymbols(key, [{ name: 'stale', kind: 'function', startLine: 1, endLine: 1 }]);
    }
    invalidateWrittenFile(aliases[index], 'entry.ts', 'feature');
    for (const version of ['', 'feature']) {
      const key = { sourceId: root, version, itemId: 'entry.ts' };
      expect(contextStore.getContent(key)).toBeUndefined();
      expect(contextStore.getSymbols(key)).toBeUndefined();
    }
  });
  it.each([
    [
      'multi_edit',
      { edits: [{ oldString: 'originalName', newString: 'changedName' }] },
      'export function changedName() { return 1; }',
    ],
    [
      'insert',
      { anchor: 'return', text: '/* inserted */ ', position: 'before' },
      'export function originalName() { /* inserted */ return 1; }',
    ],
    ['delete_block', { block: ' return 1;' }, 'export function originalName() { }'],
  ] as const)(
    '%s accepts file URLs and refreshes the canonical read',
    async (name, args, expected) => {
      await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
      await handlers[name]({
        sourceUrl: aliases[1],
        path: 'entry.ts',
        ...args,
      });
      const result = await handlers.read_file({ sourceUrl: root, path: 'entry.ts' });
      expect(JSON.parse(result.content[0].text).content).toBe(expected);
    }
  );
  it('preserves a lexical absolute path when the root is missing', () => {
    expect(normalizeSourceUrl(join(dir, 'missing') + '/')).toBe(join(dir, 'missing'));
  });
  it('does not conceal symlink loops as missing roots', () => {
    symlinkSync(join(dir, 'loop'), join(dir, 'loop'));
    expect(() => normalizeSourceUrl(join(dir, 'loop'))).toThrow();
  });
});
