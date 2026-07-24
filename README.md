# @verevoir/accelerator

The aigency **accelerator** — the commodity developer toolbelt as an MCP server,
plus the substrate/LLM/telemetry/loop primitives it exposes as a library.

Split out of `@verevoir/mcp` (STDIO-523) along the governance boundary: this
package holds everything that is **not** the moat. The governed capabilities
(`provision`, `enact_capability`, the governed `delegate` / `dispatch` / refine /
search family) live in the private **[`@verevoir/capabilities`](https://github.com/verevoir/capabilities)**,
which composes on top of the substrate exported here. A host that wants both
launches both servers.

`accelerator` makes **no LLM calls of its own** — that is the whole point of the
split, and it drives the secrets model below (it needs source/board access, never
a model key).

## Install

`accelerator` is public and available two ways:

```jsonc
// npm (published, public) — MCP client config
{ "command": "npx", "args": ["-y", "@verevoir/accelerator"] }

// or straight from the repo (builds on install via `prepare`)
{ "command": "npx", "args": ["-y", "github:verevoir/accelerator#v0.1.6"] }
```

The `github:` form is what `@verevoir/capabilities` uses as a dependency, so the
private moat never needs a registry.

## Use as a pi plugin (with a permissions scope)

The same codebase is also a **[pi](https://github.com/earendil-works/pi-coding-agent)
plugin**. `package.json` declares a `pi.extensions` entry pointing at the built
`dist/pi.js`, so installing this package as a pi package registers the same
source and work-tracker tools onto pi — reusing the identical tool definitions,
no MCP server process required.

Because pi runs tools in-process, the plugin ships an **annotation-driven
least-privilege scope layer** so a client can run pi with only the tool classes
they intend to grant. Tools are grouped into four classes:

| Class          | Tools                                                               |
| -------------- | ------------------------------------------------------------------- |
| `read`         | every `readOnlyHint` tool — the reads and board queries             |
| `write-local`  | `write_file`, `edit_file`, `multi_edit`, `insert`, `delete_block`   |
| `write-github` | `commit_files`, `ensure_fork`, `ensure_branch`, `open_pull_request` |
| `cards-write`  | `create_card`, `update_card`, `move_card`, `add_comment`            |

Two environment knobs control the scope:

| Env var                     | Effect                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCELERATOR_TOOLS`         | Comma-separated **class names and/or explicit tool names** that may register. Default when unset: `read`. Out-of-scope tools are never registered (fail-closed). An explicit tool name grants just that tool; unknown entries are ignored with a warning on stderr. |
| `ACCELERATOR_GOVERN_NATIVE` | When truthy (`1`/`true`/`on`/`yes`), install a `tool_call` gate that applies the **same** scope policy to pi's own native tools (`read`/`grep`/`find`/`ls`/`write`/`edit`/`bash`), blocking out-of-scope calls with a reason. Default **off**.                      |

Examples:

```bash
# read-only (the default) — no writes register at all
pi ...

# allow local edits and board writes, and govern pi's native bash/write too
ACCELERATOR_TOOLS='read,write-local,cards-write' ACCELERATOR_GOVERN_NATIVE=1 pi ...

# a single explicit tool
ACCELERATOR_TOOLS='read_file,open_pull_request' pi ...
```

**Honest framing:** this is a **policy + least-privilege + audit layer, not a
sandbox.** It fails closed and keeps out-of-scope tools unregistered, but pi's
`bash` remains unbounded once granted. The real isolation boundary is **running
pi in a container** — the scope layer narrows what the agent is handed; the
container is what contains it. See
[`docs/2026-07-24-pi-plugin-and-permissions.md`](docs/2026-07-24-pi-plugin-and-permissions.md).

## Secrets / environment — and _why_ each

`accelerator` only exposes **source** and **work-tracker** tools, so it only ever
needs **source/board credentials**. It has no model tier, so **no model API keys
belong here** — putting an `ANTHROPIC_API_KEY` on this server would be dead
config and a needless secret exposure. That asymmetry is deliberate: the split
lets you hand the commodity server the keys that read your code and boards, and
keep the model keys on the moat.

| Env var                                                | Why the server needs it                                                                                                                                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                                         | GitHub source adapter — `read_file`/`grep`/`find_symbol`/`code_graph`, and `write_file`/`edit_file`/`multi_edit`/`insert`/`delete_block`/`commit_files`/`ensure_fork`/`ensure_branch`/`open_pull_request`. |
| `NOTION_API_KEY`                                       | Notion source (pages as a file tree) **and** the Notion work-tracker board (`list_cards`/`create_card`/…).                                                                                                 |
| `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, `TRELLO_REFERER` | Trello work-tracker backend, when the board is Trello.                                                                                                                                                     |
| `AIGENCY_AUDIT`, `AIGENCY_AUDIT_DIR`                   | Emit audit spans (the shared telemetry lib lives here) and where to write them.                                                                                                                            |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                          | OTLP export of those spans to a collector.                                                                                                                                                                 |

Local paths and public GitHub repos need no token; the tokens gate private
sources and writes.

## Tools it registers (22)

**Source** (cached + tree-sitter indexed via `@verevoir/context`): `read_file`,
`list_files`, `get_repo_tree`, `grep`, `find_symbol`, `code_graph`, `write_file`,
`edit_file`, `multi_edit`, `insert`, `delete_block`, `commit_files`, `ensure_fork`,
`ensure_branch`, `open_pull_request`.
**Work tracker** (via `@verevoir/workflows`): `list_cards`, `get_card`,
`create_card`, `update_card`, `move_card`, `list_columns`, `list_comments`,
`add_comment`.

Prefer these over built-in filesystem/shell tools so the shared read cache +
symbol index stay correct across a session.

## Library (subpath exports)

Every compiled module is importable by subpath — `@verevoir/accelerator/tiers`,
`/router`, `/audit`, `/metering`, `/result`, `/edit`, `/cache`, `/graph`,
`/architecture`, `/manifest`, `/instructions`, `/loop/evals`, `/loop/refine`, `/loop/search`,
`/tools/source`, `/tools/workflow`. `@verevoir/capabilities` imports these; the
dependency direction is **capabilities → accelerator** (never the reverse), which
keeps governance out of the commodity layer.

## Configuring the antagonistic-review gate

This repo carries the gate: `.github/workflows/antagonistic-review.yml`, the
decision script `.github/antagonistic-review/aggregate.sh`, the merge-base
resolver `.github/antagonistic-review/resolve-merge-base.sh`, and
`.github/antagonistic-review/mcp.json`. The reviewer's rubric comes from
`provision`, which lives in `@verevoir/capabilities` — so the gate's MCP is
**capabilities**, git-installed from its private repo. The full setup (the
secrets, the clone step, the reviewer `allowed_tools`) is documented in the
**[capabilities README → "Antagonistic-review gate"](https://github.com/verevoir/capabilities#antagonistic-review-gate)**,
since capabilities is the reviewer engine. In short, the gate mints a per-run,
least-privilege token from a **GitHub App** (org secrets `VEREVOIR_APP_ID` +
`VEREVOIR_APP_PRIVATE_KEY`, scoped to just the repos it reads — no standing
PAT), plus a reviewer model credential (`CLAUDE_CODE_OAUTH_TOKEN`, or
`ANTHROPIC_API_KEY`).

## Bins

`accelerator` / `verevoir-accelerator` (server), `verevoir-card-sync`,
`verevoir-audit-trace`.

## Licence

Apache-2.0.
