# @verevoir/accelerator

The aigency **accelerator**: the commodity developer toolbelt, as an MCP server —
plus the substrate and LLM/telemetry/loop primitives it exposes as a library.

Split out of `@verevoir/mcp` (STDIO-523) along the governance boundary: this
package holds everything that is *not* the moat. The governed capabilities
(`provision`, `enact_capability`, the governed `delegate` / `dispatch` / refine /
search family) live in **`@verevoir/capabilities`**, which composes on top of the
substrate exported here. A host wanting both launches both servers.

## The server

`verevoir-accelerator` (bin: `accelerator`) registers the cached, indexed
developer tools — read/list/tree/grep/find_symbol/write/edit, fork/branch/PR and
`code_graph` over any source (`@verevoir/context`), and work-tracker CRUD
(`@verevoir/workflows`). These are the tools an agent should prefer over its
built-in filesystem/shell, so the shared read cache + tree-sitter index stay
correct.

```jsonc
// MCP client config
{ "command": "npx", "args": ["-y", "@verevoir/accelerator"] }
```

## The library

Every compiled module is importable by subpath (`@verevoir/accelerator/tiers`,
`/router`, `/audit`, `/metering`, `/loop/evals`, …). `@verevoir/capabilities`
imports these rather than re-implementing them — the `capabilities → accelerator`
dependency direction that keeps governance out of the commodity layer.

## Bins

- `accelerator` / `verevoir-accelerator` — the MCP server
- `verevoir-card-sync` — work-tracker card sync
- `verevoir-audit-trace` — render an audit trace

## Licence

Apache-2.0.
