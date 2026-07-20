// @vitest-environment node
//
// E2E proof-of-function for the context-0.14 lazy-grep win, quantified: the real
// MCP `grep` tool, given a small maxResults, terminates early and reads strictly
// FEWER files than a whole-tree warm of the same fixture. We count the reads the
// adapter actually performs, driving the lazy path through the real grep handler.
//
// The grep tool resolves its adapter from the router; that is the one seam we
// override, to slot in a counting wrapper over the REAL fs adapter — the lazy
// logic and the tool path stay genuine, only the read count is instrumented.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceAdapter } from '@verevoir/sources';
import { fs as realFs } from '@verevoir/context/fs';
import { warmSource, createContextStore } from '@verevoir/context';

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

/** A SourceAdapter identical to the real fs adapter, but recording the files its
 * `readFile` actually pulls — the instrumentation for "how much was read". */
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

const ENV = { token: '', forkOrg: '' };
const NEEDLE = 'FIND_ME_MARKER';
const TOTAL_FILES = 60;
const MATCHING = 3; // the first three files, in sort order, carry the needle

describe('e2e: lazy grep reads fewer files than a whole-tree warm', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-lazy-'));
    // a00..a02 (sort first) carry the needle; b03..bNN do not. Zero-padded so the
    // deterministic search order puts the matches strictly first — the lazy pass
    // settles on them and stops before it reaches the filler.
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

  it('a bounded cold grep finds the matches and reads strictly fewer files than a whole-tree warm', async () => {
    // Lazy: the real grep tool with maxResults, its adapter reads counted.
    const lazy = countingFsAdapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(lazy.adapter as never);
    const hits = (await realHandlers()
      .grep({ sourceUrl: dir, pattern: NEEDLE, maxResults: MATCHING })
      .then((r) => JSON.parse(r.content[0].text))) as Array<{
      itemId: string;
      lineNumber: number;
    }>;

    // Correctness first: exactly the matches, at their real 1-indexed lines.
    expect(hits).toHaveLength(MATCHING);
    expect(new Set(hits.map((h) => h.itemId))).toEqual(new Set(['a00.ts', 'a01.ts', 'a02.ts']));
    expect(hits.every((h) => h.lineNumber === 1)).toBe(true);

    // Baseline: a whole-tree warm of the same fixture reads every file.
    const warm = countingFsAdapter();
    await warmSource(warm.adapter, ENV, dir, { store: createContextStore() });
    expect(warm.reads.length).toBe(TOTAL_FILES);

    // The win: the bounded grep read strictly fewer — it settled on the matched
    // prefix (plus a bounded read-ahead window) and never scanned the filler.
    // (The exact lazy count jitters with async read-ahead scheduling; the robust,
    // non-flaky claim is that it beat the whole-tree baseline.)
    expect(lazy.reads.length).toBeLessThan(warm.reads.length);
  });
});
