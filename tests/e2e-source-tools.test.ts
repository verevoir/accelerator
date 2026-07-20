// @vitest-environment node
//
// E2E proof-of-function: exercise the real MCP source tools end to end against
// a real filesystem fixture (no mocks). Each tool is driven through the exact
// handler `registerSourceTools` registers on the server — the same path the
// running MCP takes — and asserted on real fs I/O, so a green here means the
// read/search/enumerate surface actually works, not that a mock was configured.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSourceTools } from '../src/tools/source.js';

// Capture the handlers the real `registerSourceTools` wires up, so a test drives
// each tool through its registered handler exactly as the MCP server would.
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function realHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerSourceTools(server);
  return handlers;
}

function reply(res: { content: { text: string }[] }): unknown {
  return JSON.parse(res.content[0].text);
}

const FILE_A = `export function calculateTotal(items: number[]): number {
  return items.reduce((sum, n) => sum + n, 0);
}

export const TAX_RATE = 0.2;
`;

const FILE_B = `import { calculateTotal } from './a.js';

export class Cart {
  private items: number[] = [];
  add(n: number): void {
    this.items.push(n);
  }
  total(): number {
    return calculateTotal(this.items);
  }
}
`;

describe('e2e: MCP source tools round-trip over a real fs fixture', () => {
  let dir: string;
  let tools: Record<string, Handler>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-src-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), FILE_A);
    writeFileSync(join(dir, 'src', 'b.ts'), FILE_B);
    writeFileSync(join(dir, 'README.md'), '# Fixture\n');
    tools = realHandlers();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('read_file returns the exact on-disk content plus a sha', async () => {
    // `jsonText` (STDIO-315) expands escaped newlines in string fields back to
    // real newlines for readability, so a multi-line read result is not
    // round-trippable JSON — assert on the raw tool text instead of re-parsing.
    const text = (await tools.read_file({ sourceUrl: dir, path: 'src/a.ts' })).content[0].text;
    expect(text).toContain(FILE_A);
    expect(text).toMatch(/"sha":\s*"[^"]+"/);
  });

  it('grep finds a pattern with the correct 1-indexed line number', async () => {
    const hits = reply(await tools.grep({ sourceUrl: dir, pattern: 'TAX_RATE' })) as Array<{
      itemId: string;
      lineNumber: number;
      line: string;
    }>;
    // `TAX_RATE` appears once, on line 5 of src/a.ts.
    expect(hits).toHaveLength(1);
    expect(hits[0].itemId).toBe('src/a.ts');
    expect(hits[0].lineNumber).toBe(5);
    expect(hits[0].line).toContain('TAX_RATE');
  });

  it('grep matches across files and honours case-sensitivity', async () => {
    const hits = reply(await tools.grep({ sourceUrl: dir, pattern: 'calculateTotal' })) as Array<{
      itemId: string;
    }>;
    // Definition in a.ts (line 1), import + call in b.ts — at least one per file.
    const files = new Set(hits.map((h) => h.itemId));
    expect(files.has('src/a.ts')).toBe(true);
    expect(files.has('src/b.ts')).toBe(true);
  });

  it('find_symbol locates a symbol with the full SymbolHit contract', async () => {
    const hits = reply(
      await tools.find_symbol({ sourceUrl: dir, name: 'calculateTotal' })
    ) as Array<{
      sourceId: string;
      itemId: string;
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
    }>;
    const fn = hits.find((h) => h.name === 'calculateTotal' && h.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn!.itemId).toBe('src/a.ts');
    expect(fn!.sourceId).toBe(dir);
    // Every SymbolHit field is populated to its contract.
    expect(fn!.startLine).toBe(1);
    expect(fn!.endLine).toBeGreaterThanOrEqual(fn!.startLine);
    expect(typeof fn!.kind).toBe('string');
  });

  it('find_symbol filters by kind', async () => {
    const asClass = reply(
      await tools.find_symbol({ sourceUrl: dir, name: 'Cart', kind: 'class' })
    ) as Array<{ name: string; kind: string }>;
    expect(asClass.length).toBeGreaterThanOrEqual(1);
    expect(asClass.every((h) => h.kind === 'class')).toBe(true);
    expect(asClass.some((h) => h.name === 'Cart')).toBe(true);

    // The same name, restricted to a kind it is not, yields nothing.
    const asEnum = reply(
      await tools.find_symbol({ sourceUrl: dir, name: 'Cart', kind: 'enum' })
    ) as unknown[];
    expect(asEnum).toHaveLength(0);
  });

  it('get_repo_tree enumerates every file in the fixture', async () => {
    const tree = reply(await tools.get_repo_tree({ sourceUrl: dir })) as {
      entries: Array<{ path: string; type: string }>;
    };
    // TreeEntry.type is git-flavoured: blob = file, tree = dir.
    const paths = new Set(tree.entries.filter((e) => e.type === 'blob').map((e) => e.path));
    expect(paths.has('src/a.ts')).toBe(true);
    expect(paths.has('src/b.ts')).toBe(true);
    expect(paths.has('README.md')).toBe(true);
  });

  it('list_files enumerates a directory prefix', async () => {
    const entries = reply(await tools.list_files({ sourceUrl: dir, prefix: 'src' })) as Array<{
      name: string;
      type: string;
    }>;
    const names = new Set(entries.map((e) => e.name));
    expect(names.has('a.ts')).toBe(true);
    expect(names.has('b.ts')).toBe(true);
    // README lives at the root, not under src/.
    expect(names.has('README.md')).toBe(false);
  });
});
