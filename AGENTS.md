# @verevoir/accelerator — agent context

`@verevoir/accelerator` is the **commodity MCP tool layer** of the verevoir stack: source
and work-tracker access, the raw worker/loop primitives, and the LLM binding — everything
that makes **no governance decision**. `@verevoir/capabilities` depends on it and adds the
governed moat (`enact`/`provision` + the gate). The dependency direction is one-way:
capabilities → accelerator, never the reverse.

## Stack & layout

- TypeScript, ESM, Node ≥ 20. Built with `tsc`; tested with `vitest`.
- `src/` — the substrate: `router.ts` (backend routing), `cache.ts`, `edit.ts` + `mutate.ts`
  (file mutation), `graph.ts` (code graph), `tiers.ts` / `registry.ts` / `metering.ts` (the
  LLM binding), `audit.ts` / `otlp.ts` (telemetry), `loop/*` (raw refine/search/eval primitives).
- `src/tools/` — MCP tool registrations: `source.ts` (read/list/tree/grep/find_symbol/
  code_graph/write/edit/multi_edit/insert/delete_block/fork/branch/PR), `workflow.ts`
  (board CRUD).
- `src/index.ts` — `createServer()`; `src/bin.ts` — the stdio server bin (aliased
  `accelerator` / `verevoir-accelerator`). The other declared bins are `verevoir-card-sync`
  and `verevoir-audit-trace`.
- Every compiled module is importable by subpath (`@verevoir/accelerator/<name>`); the list
  lives in `llms.txt`. Consumers (capabilities) import these.

## Build / test / run

- `npm run build` (`tsc`) · `npm run typecheck` (`tsc --noEmit`).
- `npm test` / `npx vitest run` — the suite · `npm run lint` (`prettier --check .`).
- `npx @verevoir/accelerator` (or `node dist/bin.js`) launches the MCP server over stdio.

## Credentials

Source/board access only — accelerator makes **no** LLM calls, so **no model API key**
belongs here. `GITHUB_TOKEN` (GitHub reads + writes/PRs), `NOTION_API_KEY` (Notion source +
board), `TRELLO_*` (Trello board). Public repos / local paths need no token.

## Project context

This repo is one of several sibling packages (`@verevoir/capabilities`, `sources`, `context`,
`recipes`, `llm`, …). The **cross-repo project record — intent, decisions (ADRs), user
journeys, and the work tracker — lives in Notion**, reached through the verevoir MCP, and is
the source of truth for everything beyond this repo. Look there, not just here, for the _why_.

## Standards

Generated and changed code is held to the aigency guardrails corpus. **Before changing
code, call the `provision` MCP tool** to pull the bar; every source-changing commit carries a
`Practices:` trailer (CI-enforced), and every change goes through a PR gated by the
antagonistic review. `instructions.md` holds the MCP front-door doctrine — write through the
MCP, and route substantial _produce_ to the worker tier rather than hand-writing it.
