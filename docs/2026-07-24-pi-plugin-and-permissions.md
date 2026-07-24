# DESIGN & BUILD SPEC — accelerator as a pi plugin + portable permissions shim

GOAL: package @verevoir/accelerator so the SAME codebase serves as (a) its current MCP server AND (b) a pi (pi-coding-agent) plugin, and add an annotation-driven permissions/scope layer used by the pi form. This is for careful client use of pi.

PRINCIPLES
- Additive: the MCP path (src/bin.ts, src/index.ts createServer, src/tools/*) stays behaviourally identical. No tool behaviour changes.
- Thin: reuse the existing host-agnostic tool registration. registerSourceTools/registerWorkflowTools already accept a duck-typed { registerTool } (the tests already feed them a mock of exactly that). Do NOT rewrite the tool files beyond, at most, typing the host parameter.
- Policy-in-package: the scope model lives in accelerator so it holds in any host.
- Honest framing: this is a policy + least-privilege + audit layer, NOT an isolation boundary. The real sandbox is running pi in a container. Do not call the shim a sandbox anywhere in code or docs.

ARCHITECTURE
- ToolHost interface: { registerTool(name, config, handler) } — McpServer already satisfies it.
- Permissions/scope module (new, e.g. src/permissions.ts): tool CLASSES derived from each tool MCP annotation (readOnlyHint/destructiveHint/idempotentHint) already present in src/tools/source.ts and src/tools/workflow.ts:
    read        = every readOnlyHint:true tool (read_file, list_files, get_repo_tree, grep, find_symbol, code_graph, list_columns, list_cards, get_card, list_comments)
    write-local = filesystem mutations (write_file, edit_file, multi_edit, insert, delete_block)
    write-github= git/GitHub mutations (commit_files, ensure_fork, ensure_branch, open_pull_request)
    cards-write = board mutations (create_card, update_card, move_card, add_comment)
  Scope is declared via env ACCELERATOR_TOOLS (comma-separated class names and/or explicit tool names). Default when unset: read.
  Registration-time gating: a withScope(host, scope) ToolHost decorator that only forwards registerTool for in-scope tools; out-of-scope tools are never registered (fail-closed).
- pi entry (new, src/pi.ts): a default-exported function (pi) => { ... } that (a) builds a piHost:ToolHost whose registerTool maps to pi.registerTool (translating the tool config/inputSchema as pi expects), (b) wraps it withScope(piHost, scopeFromEnv()) and calls registerSourceTools + registerWorkflowTools on it (reusing the tool defs unchanged), and (c) installs a native-tool gate: pi.on(tool_call, handler) applying the SAME scope policy to pi native tools (bash/read/write/edit), returning { block: true, reason } for out-of-scope/destructive calls. Native gating controlled by env ACCELERATOR_GOVERN_NATIVE (default off); when on and there is no UI, fail closed.
- package.json: add a pi.extensions field pointing at the built pi entry (see pi-mcp-adapter package.json for the exact shape: it uses { "pi": { "extensions": ["./index.ts"] } } but this package ships built JS from dist/, so point at the built file and make sure the build emits it and files[] includes it). Keep bin/main/exports intact.

GROUND THE pi API IN REALITY (do not guess signatures):
- pi types + docs live at /Users/adamsurgenor/.nvm/versions/node/v24.13.1/lib/node_modules/@earendil-works/pi-coding-agent — read docs/extensions.md (Events section; the tool_call event: fires before execution for every tool incl. native, event.toolName / event.input mutable / return { block:true, reason }) and the *.d.ts for ExtensionAPI, pi.on, pi.registerTool exact signatures.
- A working pi extension package to mirror for packaging is /Users/adamsurgenor/.pi/agent/npm/node_modules/pi-mcp-adapter (its package.json pi field, its index.ts, how it registers tools).

TESTS (vitest; reuse the existing registerTool-mock pattern from tests/*.test.ts):
- the annotation->class taxonomy is correct and TOTAL (every registered tool maps to exactly one class).
- withScope registers exactly the declared tools (default read; a named class; explicit tool names; unknown names ignored with a warning).
- the native tool_call gate: with GOVERN_NATIVE on, blocks out-of-scope bash/write and allows reads; off => no gating.
- the MCP path is unchanged: createServer still registers all tools.

DOCS: commit this spec verbatim to docs/2026-07-24-pi-plugin-and-permissions.md, and update README.md / instructions.md with the pi-plugin usage, the ACCELERATOR_TOOLS and ACCELERATOR_GOVERN_NATIVE env knobs, and the honest "policy layer, container is the boundary" framing.

OUT OF SCOPE (do NOT do): any change to @verevoir/capabilities; any change to MCP tool behaviour; any publish/release/version bump; anything on main. Corpus/wiki/loops are a later capabilities phase, not this one.
