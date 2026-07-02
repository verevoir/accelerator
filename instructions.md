# Working with this project via Verevoir

Verevoir is the front door for reading and writing files, code, and project context. These tools share a cache + tree-sitter index across the whole session; your built-in filesystem/shell tools do not — so reaching for them in preference is not a style nicety, it keeps that shared view correct.

- **Writes — always through the MCP.** Make every change to a covered `sourceUrl` / `boardUrl` with `write_file` / `edit_file` (or the card tools). A write that goes around them — shell redirection, `sed -i`, or the built-in Edit/Write on a covered path — leaves the shared cache stale and _wrong_ for the rest of the session, so later reads and searches serve pre-write content. This is the firm rule: never edit a covered file out-of-band.
- **Reads — prefer the MCP.** Use `read_file` / `grep` / `find_symbol` over the built-in Read / `cat` / shell `grep` / `find` / `ls`. A bypassed read is less costly than a bypassed write — it only misses the cache + index benefit (slower, duplicate fetches, no Notion) rather than corrupting state — but the MCP is still the default whenever a `sourceUrl` fits.

## Before you change code, consult the bar

Before you implement, write, or change code, call **`provision`** with a short description of the work. Treat this as a precondition for the change, the same way writing through the MCP is: skip it and your code is judged against standards you never read.

It returns, in one call as text, the **foundational floor practices in full** plus a **menu of the concern practices** (each a one-line summary). You see the whole task, so you narrow better than any isolated classifier: **pick the concerns that apply and call `provision` again with `concerns: ['id', …]`** to pull their full text alongside the floor — a complete frame you can also hand to a worker. (`find_governance` is still there for browsing the wider record; `provision` is the triggered shortcut for "what am I held to for _this_.")

If you hand the work to another model, the bar must travel with it — a floor worker won't fetch it itself. The **`delegate`** tool does this for you by default (it provisions the worker's task and carries the frame into its prompt); for a sub-agent you spawn another way, pass a provisioned frame in its prompt yourself. A weak/headless caller with no coordinator to narrow can pass `autoTag: true` to have `provision` select the concerns in-MCP instead of returning a menu.

## Before you generate substantial work — route it, don't hand-write it

This is a precondition, the same way consulting the bar is: **the moment you're about to produce a substantial amount of output yourself — anything past a small, surgical edit — stop and hand it down.** The trigger is the _volume of what you're about to generate_, NOT whether it "feels mechanical." Careful, high-stakes, coupled generation is not the exception to this — it is the most valuable work to route.

- **Capability-shaped work → `enact_capability`.** If a capability covers it (converting a design system to tokens, scaffolding a service, a discovery pass), name the capability + a directive: it loads the done-well, provisions the bar, produces on the worker tier, and verifies (the capability's gate where it declares one, plus a review), looping until it passes. One door — the tiering and verify are structural, so you never hand-write capability work.
- **Free-form bulk → `delegate` / `dispatch`.** A bounded sub-task, or a whole task a worker drives, on a cheaper tier with the bar carried in. A sub-agent you spawn any other way inherits _your_ tier — faster, not cheaper, and unheld to any bar.

**"It's too coupled / too careful to delegate" is the trap — it's the signal to _decompose_, not to self-generate.** Cross-file consistency, a shared vocabulary N outputs must agree on, output that's expensive to verify by eye: that instinct to keep it yourself is exactly where the substrate earns its place. Force a shared **scaffold** stage first that **documents the common contract** — the token file, the schema, the class vocabulary the variants must agree on — then make each variant a leaf that references that documented contract. The coupling doesn't vanish: it **relocates into one explicit, documented contract** the leaves read, instead of implicit consistency each leaf must maintain against all the others. So each leaf is narrow, delegatable, and parallel (it reads the contract, not its siblings), and the **gate verifies every leaf against the documented contract** deterministically. The work that feels un-delegatable is precisely what enacting makes safe: the decomposition turns hidden coupling into an explicit contract, and the gate enforces it.

Rule of thumb: **the reasoning, the decomposition, and the decision of what to hand off stay with you; every substantial _produce_ goes to `enact_capability` (capability-shaped) or `delegate` / `dispatch` (free-form bulk).** Keep truly inline only the small surgical edits and the coordination itself.

## One surface, auto-routed by URL

The same tools work uniformly across:

- **Local repos / files** — absolute path or `file://` (e.g. `/Users/you/project`)
- **Git hosts** — `https://github.com/owner/repo` (more adapters land over time)
- **Notion** — `https://www.notion.so/<id>` (pages read as a file tree; databases act as work-tracker boards)

Reads are cached and tree-sitter symbol-indexed via `@verevoir/context` and shared across the whole session, so reading a file also warms it for later search. Native reads bypass that cache and its freshness tracking — and can't see Notion at all.

## File workflow

`get_repo_tree` or `list_files` to orient → `read_file` to pull a specific file (this warms the cache) → `grep` / `find_symbol` to search. `grep` and `find_symbol` scan the whole source on demand and warm the cache as they go, so they need no prior `read_file` — reach for them directly when you're searching rather than opening one file you already know.

## Project state lives in the tools, not the local git tree

- **The board is the project's current state.** Asked what's going on — the state, what's in progress, what's next, what's left — read the work tracker first (`list_columns` / `list_cards`). The local git tree and open PRs are the operational shell, **not** the project's state: a clean working tree does not mean there is no work in flight.
- **The board is also where work goes.** Anything work-shaped — a to-do, a gap, a bug, a deferred decision — is a card (`create_card` / `update_card` / `move_card`), not a note kept off to the side.
- **Project record** — ADRs, intent, and other durable context live in Notion; reach them via the Notion source tools, not by grepping local files.

## Fix the source, not the leaf

When something is wrong, or a change needs to land in many places, ask whether you are patching an _artefact_ or its _generator_. Prefer the upstream fix — the template, the prompt, the tool that emits the thing — over editing each downstream copy by hand.

## Working discipline

- **Trace work to the tracker.** When you act on a tracked item, carry its id through the branch, commit, and PR title (e.g. `<id>: <subject>`) so the change links back to the board.
- **One change, one purpose.** Keep commits and PRs single-purpose, and state how you verified them (tests run, checks passed). Prefer a stack of small PRs over one omnibus diff.
- **Code changes are gated by antagonistic review where a project adopts it.** When a project's git-ops includes the `antagonistic-review-established` gate, every change is blocked behind an independent, adversarial review against the provisioned practices — a brief never has to ask for it. The gate fails loud: a reviewer that cannot run (no credential, out of tokens) blocks and surfaces the change, never self-merges, skips, or rewrites the check to get past it.
- **Trust git for merge state, not `gh`.** In a multi-repo workspace `gh` infers the repo from the current directory, so `gh pr view N` can silently report a _different_ repo's PR (tell-tale: a `mergedAt` that predates the PR's creation). Pass `--repo owner/name` on every `gh` call, and confirm a merge with git — `git fetch && git merge-base --is-ancestor <sha> origin/main` — not `gh pr view`.
