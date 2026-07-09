import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from '../src/tools/source.js';
import { registerWorkflowTools } from '../src/tools/workflow.js';

// STDIO-544 — pin the annotation CONTRACT, not just presence. A host permissions
// a tool from these hints (auto-allow reads, gate destructive writes, dedup only
// genuinely idempotent calls), so a WRONG value is worse than a missing one: e.g.
// write_file is destructive-but-not-idempotent (every call is a fresh git commit),
// so a host that dedups a retry would silently drop a write. This asserts the exact
// expected hints for every registered tool — one named case per tool.
const EXPECTED: Record<string, Record<string, boolean>> = {
  // Reads — safe to auto-allow; reach GitHub/Notion so open-world.
  read_file: { readOnlyHint: true, openWorldHint: true },
  list_files: { readOnlyHint: true, openWorldHint: true },
  get_repo_tree: { readOnlyHint: true, openWorldHint: true },
  grep: { readOnlyHint: true, openWorldHint: true },
  find_symbol: { readOnlyHint: true, openWorldHint: true },
  code_graph: { readOnlyHint: true, openWorldHint: true },
  list_columns: { readOnlyHint: true, openWorldHint: true },
  list_cards: { readOnlyHint: true, openWorldHint: true },
  get_card: { readOnlyHint: true, openWorldHint: true },
  list_comments: { readOnlyHint: true, openWorldHint: true },
  // Mutating writes — destructive; NOT idempotent (each is a distinct commit / write).
  write_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  edit_file: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  multi_edit: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  insert: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  delete_block: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  commit_files: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  update_card: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  // Create-if-missing / set-state — additive, and genuinely idempotent.
  ensure_fork: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  ensure_branch: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  move_card: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Additive, non-idempotent (each creates a new PR / card / comment).
  open_pull_request: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  create_card: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  add_comment: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

/** Drive both registration functions with a mock server that records each tool's
 * declared annotations, so the contract can be asserted without a real server. */
function registeredAnnotations(): Record<string, unknown> {
  const captured: Record<string, unknown> = {};
  const mock = {
    registerTool: (name: string, config: { annotations?: unknown }) => {
      captured[name] = config.annotations;
      return {} as unknown;
    },
  } as unknown as McpServer;
  registerSourceTools(mock);
  registerWorkflowTools(mock);
  return captured;
}

describe('MCP tool annotation hints (STDIO-544)', () => {
  const tools = registeredAnnotations();

  it('registers exactly the expected set of tools', () => {
    expect(Object.keys(tools).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s declares exactly its expected hints', (name, expected) => {
    expect(tools[name]).toEqual(expected);
  });
});
