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
{ "command": "npx", "args": ["-y", "github:verevoir/accelerator#v0.1.1"] }
```

The `github:` form is what `@verevoir/capabilities` uses as a dependency, so the
private moat never needs a registry.

## Secrets / environment — and *why* each

`accelerator` only exposes **source** and **work-tracker** tools, so it only ever
needs **source/board credentials**. It has no model tier, so **no model API keys
belong here** — putting an `ANTHROPIC_API_KEY` on this server would be dead
config and a needless secret exposure. That asymmetry is deliberate: the split
lets you hand the commodity server the keys that read your code and boards, and
keep the model keys on the moat.

| Env var | Why the server needs it |
|---|---|
| `GITHUB_TOKEN` | GitHub source adapter — `read_file`/`grep`/`find_symbol`/`code_graph`, and `write_file`/`edit_file`/`ensure_fork`/`ensure_branch`/`open_pull_request`. |
| `NOTION_API_KEY` | Notion source (pages as a file tree) **and** the Notion work-tracker board (`list_cards`/`create_card`/…). |
| `TRELLO_API_KEY`, `TRELLO_API_TOKEN`, `TRELLO_REFERER` | Trello work-tracker backend, when the board is Trello. |
| `AIGENCY_AUDIT`, `AIGENCY_AUDIT_DIR` | Emit audit spans (the shared telemetry lib lives here) and where to write them. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP export of those spans to a collector. |

Local paths and public GitHub repos need no token; the tokens gate private
sources and writes.

## Tools it registers (19)

**Source** (cached + tree-sitter indexed via `@verevoir/context`): `read_file`,
`list_files`, `get_repo_tree`, `grep`, `find_symbol`, `code_graph`, `write_file`,
`edit_file`, `ensure_fork`, `ensure_branch`, `open_pull_request`.
**Work tracker** (via `@verevoir/workflows`): `list_cards`, `get_card`,
`create_card`, `update_card`, `move_card`, `list_columns`, `list_comments`,
`add_comment`.

Prefer these over built-in filesystem/shell tools so the shared read cache +
symbol index stay correct across a session.

## Library (subpath exports)

Every compiled module is importable by subpath — `@verevoir/accelerator/tiers`,
`/router`, `/audit`, `/metering`, `/result`, `/edit`, `/cache`, `/graph`,
`/manifest`, `/instructions`, `/loop/evals`, `/loop/refine`, `/loop/search`,
`/tools/source`, `/tools/workflow`. `@verevoir/capabilities` imports these; the
dependency direction is **capabilities → accelerator** (never the reverse), which
keeps governance out of the commodity layer.

## Configuring the antagonistic-review gate

This repo carries the gate (`.github/workflows/antagonistic-review.yml` +
`.github/antagonistic-review/mcp.json`). The reviewer's rubric comes from
`provision`, which lives in `@verevoir/capabilities` — so the gate's MCP is
**capabilities**, git-installed from its private repo. The full setup (the two
secrets, the clone step, the reviewer `allowed_tools`) is documented in the
**[capabilities README → "Antagonistic-review gate"](https://github.com/verevoir/capabilities#antagonistic-review-gate)**,
since capabilities is the reviewer engine. In short, this repo needs two org
secrets: `CUTOVER_PUSH_TOKEN` (Contents:read — clones the private capabilities
MCP and reads the corpus) and `CLAUDE_CODE_OAUTH_TOKEN` (the reviewer's model
credential).

## Bins

`accelerator` / `verevoir-accelerator` (server), `verevoir-card-sync`,
`verevoir-audit-trace`.

## Licence

Apache-2.0.
