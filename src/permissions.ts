import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The host-agnostic tool-registration seam. `McpServer` already satisfies it
 * (its `registerTool` IS this shape), so the SAME tool definitions —
 * `registerSourceTools` / `registerWorkflowTools` — serve both the MCP server
 * and the pi plugin unchanged. The seam is earned: the two hosts genuinely
 * diverge (one speaks MCP over stdio, the other is pi's in-process
 * ExtensionAPI), yet both register a tool by name, config and handler, so that
 * single shared shape is all the tool files depend on.
 */
export interface ToolHost {
  registerTool: McpServer['registerTool'];
}

/**
 * A tool's privilege class — the unit a scope grants. `read` is exactly the
 * `readOnlyHint: true` tools; the three write classes split the mutations by
 * BLAST RADIUS (local files vs git/GitHub vs work-tracker board), a distinction
 * the MCP annotations alone cannot express, so a scope can grant local edits
 * without granting GitHub or board writes.
 */
export type ToolClass = 'read' | 'write-local' | 'write-github' | 'cards-write';

export const TOOL_CLASS_NAMES: readonly ToolClass[] = [
  'read',
  'write-local',
  'write-github',
  'cards-write',
];

/**
 * Every accelerator tool, mapped to exactly one privilege class. The taxonomy
 * is TOTAL and is pinned by a test that drives both registration functions and
 * asserts every registered tool appears here exactly once — and that the `read`
 * class matches the `readOnlyHint: true` set from the MCP annotations.
 */
export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  // read — readOnlyHint:true; safe to auto-allow.
  read_file: 'read',
  list_files: 'read',
  get_repo_tree: 'read',
  grep: 'read',
  find_symbol: 'read',
  code_graph: 'read',
  list_columns: 'read',
  list_cards: 'read',
  get_card: 'read',
  list_comments: 'read',
  // write-local — filesystem mutations.
  write_file: 'write-local',
  edit_file: 'write-local',
  multi_edit: 'write-local',
  insert: 'write-local',
  delete_block: 'write-local',
  // write-github — git / GitHub mutations.
  commit_files: 'write-github',
  ensure_fork: 'write-github',
  ensure_branch: 'write-github',
  open_pull_request: 'write-github',
  // cards-write — work-tracker board mutations.
  create_card: 'cards-write',
  update_card: 'cards-write',
  move_card: 'cards-write',
  add_comment: 'cards-write',
};

/**
 * pi's built-in tools, mapped to the same privilege classes so the native gate
 * applies ONE policy across accelerator tools and pi's own read/grep/find/ls
 * and write/edit/bash. `bash` is unbounded (it can push to GitHub or delete
 * files), so it is gated behind `write-local` at minimum and — like every
 * mutating native tool — is blocked under a read-only scope.
 *
 * CAVEAT — `write-local` grants a shell that subsumes the other write classes.
 * Because `bash` is here under `write-local`, granting `write-local` for local
 * edits also grants an unbounded shell that can `git push` or write to the
 * board — i.e. it effectively subsumes `write-github` and `cards-write`. The
 * class split therefore constrains the accelerator's OWN tools by blast radius,
 * but NOT native `bash`: withhold `write-local` (or native governance, or
 * pi's `bash`) if that shell must not exist. A dedicated `shell` class that
 * separates `bash` from local file edits is left as a deliberate follow-up.
 *
 * This is a POLICY layer, not a sandbox: the real isolation boundary is running
 * pi in a container.
 */
export const NATIVE_TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  read: 'read',
  grep: 'read',
  find: 'read',
  ls: 'read',
  write: 'write-local',
  edit: 'write-local',
  bash: 'write-local',
};

export function toolClass(name: string): ToolClass | undefined {
  return TOOL_CLASSES[name];
}

function isToolClass(token: string): token is ToolClass {
  return (TOOL_CLASS_NAMES as readonly string[]).includes(token);
}

/**
 * A resolved permission scope.
 *
 * - `classes` are the privilege classes granted by a *class* token — they drive
 *   the native tool gate.
 * - `tools` are the accelerator tool names permitted to register — the union of
 *   every tool in a granted class plus any explicitly named tool.
 * - `warnings` records non-fatal parse issues (unknown tokens) for the host to
 *   surface.
 *
 * Explicit tool names grant narrow accelerator-tool access WITHOUT widening
 * `classes`: naming `write_file` registers only that tool and does not relax the
 * native gate for pi's `write`/`bash`. Grant a whole class to loosen native
 * gating.
 */
export interface Scope {
  classes: ReadonlySet<ToolClass>;
  tools: ReadonlySet<string>;
  warnings: readonly string[];
}

/** The default scope when `ACCELERATOR_TOOLS` is unset or empty: read-only. */
export const DEFAULT_SCOPE_SPEC = 'read';

/**
 * Parse an `ACCELERATOR_TOOLS` value — a comma-separated list of class names
 * (`read`, `write-local`, `write-github`, `cards-write`) and/or explicit tool
 * names — into a {@link Scope}. Unknown entries are ignored with a warning
 * rather than failing. When the value is unset or empty the scope defaults to
 * `read`.
 */
export function resolveScope(spec: string | undefined): Scope {
  const tokens = (spec ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const effective = tokens.length > 0 ? tokens : [DEFAULT_SCOPE_SPEC];

  const classes = new Set<ToolClass>();
  const tools = new Set<string>();
  const warnings: string[] = [];

  for (const token of effective) {
    if (isToolClass(token)) {
      classes.add(token);
      for (const [name, cls] of Object.entries(TOOL_CLASSES)) {
        if (cls === token) tools.add(name);
      }
    } else if (token in TOOL_CLASSES) {
      tools.add(token);
    } else {
      warnings.push(
        `ignoring unknown ACCELERATOR_TOOLS entry "${token}" (expected a class ` +
          `[${TOOL_CLASS_NAMES.join(', ')}] or a tool name)`
      );
    }
  }

  return { classes, tools, warnings };
}

/** Resolve the scope from the process environment (`ACCELERATOR_TOOLS`). */
export function scopeFromEnv(env: NodeJS.ProcessEnv = process.env): Scope {
  return resolveScope(env.ACCELERATOR_TOOLS);
}

/**
 * Wrap a {@link ToolHost} so only in-scope tools are ever registered.
 * Out-of-scope tools are never forwarded to the underlying host — they are
 * ABSENT, not merely hidden (fail-closed): a tool that was never registered
 * cannot be invoked.
 */
export function withScope(host: ToolHost, scope: Scope): ToolHost {
  const register = ((name: string, config: unknown, handler: unknown): unknown => {
    if (!scope.tools.has(name)) return undefined;
    return (host.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(
      name,
      config,
      handler
    );
  }) as unknown as ToolHost['registerTool'];
  return { registerTool: register };
}

export interface NativeGateDecision {
  block: true;
  reason: string;
}

/**
 * Decide whether a pi-native tool call is permitted under `scope`. Returns
 * `undefined` when the call is ALLOWED (a pi `tool_call` handler then returns
 * nothing and execution proceeds); otherwise a `{ block, reason }` decision.
 *
 * pi's `tool_call` event fires before EVERY tool — including the accelerator's
 * own registered tools — so the gate must first let an in-scope accelerator tool
 * through: it was only registered because `withScope` already admitted it, so
 * re-blocking it here would make the plugin unusable whenever native governance
 * is on. Only genuine native (or unrecognised) tools reach the class check.
 *
 * Fail-closed: an unclassified native tool, or one whose class the scope does
 * not grant, is blocked. There is no consent prompt — an out-of-scope call is
 * never auto-allowed, with or without a UI.
 */
export function gateNativeToolCall(toolName: string, scope: Scope): NativeGateDecision | undefined {
  // An accelerator tool the scope admitted (and `withScope` therefore
  // registered) is already governed at registration time — allow it through.
  if (scope.tools.has(toolName)) return undefined;
  const cls = NATIVE_TOOL_CLASSES[toolName];
  if (cls && scope.classes.has(cls)) return undefined;
  const reason = cls
    ? `@verevoir/accelerator: native tool "${toolName}" needs the "${cls}" scope, ` +
      `which ACCELERATOR_TOOLS does not grant.`
    : `@verevoir/accelerator: native tool "${toolName}" is not permitted under the ` +
      `current ACCELERATOR_TOOLS scope.`;
  return { block: true, reason };
}
