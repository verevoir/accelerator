// @vitest-environment node
//
// E2E proof-of-function: the wrapWithCache dual-scope invariant, exercised
// through the real MCP tool surface. A read warms the shared cache; a write
// through the MCP write path must invalidate it, so the next read returns the
// just-written content — fresh, never stale. Driven through the real registered
// handlers (no mocks) so this proves the actual read/write tools stay coherent,
// which is the property a mid-session edit-then-read depends on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSourceTools } from '../src/tools/source.js';

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

describe('e2e: cache coherence across the MCP write/read boundary', () => {
  let dir: string;
  let tools: Record<string, Handler>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'e2e-cache-'));
    tools = realHandlers();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('read after write_file returns the fresh content, not the cached original', async () => {
    writeFileSync(join(dir, 'note.txt'), 'version one');

    // First read warms the shared read cache with v1.
    const first = reply(await tools.read_file({ sourceUrl: dir, path: 'note.txt' })) as {
      content: string;
      sha: string;
    };
    expect(first.content).toBe('version one');

    // Write v2 through the MCP write path — must invalidate the cached v1.
    await tools.write_file({ sourceUrl: dir, path: 'note.txt', content: 'version two' });
    // The write really hit disk.
    expect(readFileSync(join(dir, 'note.txt'), 'utf8')).toBe('version two');

    // Read again through the same cached path: fresh, not the stale v1.
    const second = reply(await tools.read_file({ sourceUrl: dir, path: 'note.txt' })) as {
      content: string;
      sha: string;
    };
    expect(second.content).toBe('version two');
    expect(second.sha).not.toBe(first.sha);
  });

  it('read after edit_file returns the edited content through the cached read path', async () => {
    writeFileSync(join(dir, 'code.ts'), 'const port = 3000;\n');

    // Warm the cache. (Content carries a trailing newline, so read on the raw
    // tool text — jsonText expands newlines and is not round-trippable JSON.)
    const before = (await tools.read_file({ sourceUrl: dir, path: 'code.ts' })).content[0].text;
    expect(before).toContain('3000');

    // Surgical edit through the MCP edit path.
    const editRes = reply(
      await tools.edit_file({
        sourceUrl: dir,
        path: 'code.ts',
        oldString: '3000',
        newString: '8080',
      })
    ) as { ok: boolean; replacements: number };
    expect(editRes).toEqual({ ok: true, replacements: 1 });

    // Re-read: the cached read surface reflects the edit — fresh 8080, no stale 3000.
    const after = (await tools.read_file({ sourceUrl: dir, path: 'code.ts' })).content[0].text;
    expect(after).toContain('const port = 8080;');
    expect(after).not.toContain('3000');
  });

  it('a brand-new file written through the MCP is immediately readable', async () => {
    // No prior read — proves the read path fetches a file the cache has never
    // seen, straight after an MCP write created it.
    await tools.write_file({ sourceUrl: dir, path: 'created.txt', content: 'hello fresh' });
    const res = reply(await tools.read_file({ sourceUrl: dir, path: 'created.txt' })) as {
      content: string;
    };
    expect(res.content).toBe('hello fresh');
  });
});
