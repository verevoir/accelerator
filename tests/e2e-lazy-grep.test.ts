// @vitest-environment node
//
// E2E proof-of-function for the context-0.14 lazy-grep win, quantified: a cold
// grep with a small maxResults must read FEWER files than the tree holds,
// terminating early once the result is settled — versus a whole-tree warm that
// reads every file. The seam is the SourceAdapter's own `readFile`: we wrap the
// REAL fs adapter, count the reads it actually performs, and drive the lazy path
// through the real MCP `grep` tool handler. No src change — the router is the
// only injection point, so we swap in the counting adapter there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceAdapter } from '@verevoir/sources';
import { fs as realFs } from '@verevoir/context/fs';
import { warmSource, createContextStore } from '@verevoir/context';

// The grep tool asks the router for its adapter; that is the seam. Swap in a
// counting wrapper over the REAL fs adapter — the lazy logic under test is
// genuine, only the read count is instrumented.
vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({ token: '', forkOrg: '' })),
}));

import { registerSourceTools } from '../src/tools/source.js';
import { pickSourceAdapter } from '../src/router.js';

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

/** A SourceAdapter identical to the real fs adapter, but counting the files its
 * `readFile` actually pulls — the instrumentation seam for "how much was read". */
function countingFsAdapter(): { adapter: SourceAdapter; reads: string[] } {
  const reads: string[] = [];
  const adapter: SourceAdapter = {
    ...realFs,
    readFile: async (env, repoUrl, path, ref) => {
      reads.push(path);
      return realFs.readFile(env, repoUrl, path, ref);
    },
  };
  return { adapter, reads };
}

const NEEDLE = 'FIND_ME_MARKER';
const TOTAL_FILES = 60;
const MATCHING = 3; // the first three files, in sort order, carry the needle

describe('e2e: lazy grep reads fewer files than a whole-tree warm', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-lazy-'));
    // a00..a02 (sort first) carry the needle; b03..bNN do not. Zero-padded so
    // the deterministic sort order puts the matches strictly first.
    for (let i = 0; i < MATCHING; i++) {
      const n = String(i).padStart(2, '0');
      writeFileSync(join(dir, `a${n}.ts`), `export const marker = '${NEEDLE}'; // ${n}\n`);
    }
    for (let i = MATCHING; i < TOTAL_FILES; i++) {
      const n = String(i).padStart(2, '0');
      writeFileSync(join(dir, `b${n}.ts`), `export const filler${n} = ${i};\n`);
    }
    vi.mocked(pickSourceAdapter).mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cold grep with a small maxResults terminates early, reading a fraction of the tree', async () => {
    const { adapter, reads } = countingFsAdapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(adapter as never);

    const hits = reply(
      await realHandlers().grep({ sourceUrl: dir, pattern: NEEDLE, maxResults: MATCHING })
    ) as Array<{ itemId: string; lineNumber: number }>;

    // Correctness first: it found exactly the matches, with real line numbers.
    expect(hits).toHaveLength(MATCHING);
    expect(new Set(hits.map((h) => h.itemId))).toEqual(new Set(['a00.ts', 'a01.ts', 'a02.ts']));
    expect(hits.every((h) => h.lineNumber === 1)).toBe(true);

    // The win: it did NOT read the whole tree. Early termination after the
    // settled result means it reads only the matched prefix plus a bounded
    // read-ahead window — a small fraction of the 60 files present, never the
    // whole tree. (The exact count jitters with async read-ahead scheduling, so
    // we assert a generous fraction, not an exact number — the saving is what
    // matters, and the third test pins it against the whole-tree baseline.)
    expect(reads.length).toBeLessThan(TOTAL_FILES / 2);
  });

  it('a whole-tree warm reads every file — the baseline the lazy path beats', async () => {
    const { adapter, reads } = countingFsAdapter();
    // warmSource is the deliberate, eager half of the pair: whole tree, own store.
    await warmSource(adapter, { token: '', forkOrg: '' }, dir, { store: createContextStore() });
    expect(reads.length).toBe(TOTAL_FILES);
  });

  it('lazy grep reads strictly fewer files than the whole-tree warm', async () => {
    // Lazy read count, via the real grep tool path.
    const lazy = countingFsAdapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(lazy.adapter as never);
    await realHandlers().grep({ sourceUrl: dir, pattern: NEEDLE, maxResults: MATCHING });

    // Whole-tree warm count, same fixture, isolated store.
    const warm = countingFsAdapter();
    await warmSource(warm.adapter, { token: '', forkOrg: '' }, dir, {
      store: createContextStore(),
    });

    expect(lazy.reads.length).toBeLessThan(warm.reads.length);
    expect(warm.reads.length).toBe(TOTAL_FILES);
  });
});
