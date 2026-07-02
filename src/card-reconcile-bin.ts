#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pickWorkflowAdapter, resolveWorkflowEnv } from './router.js';
import { reconcileBoard, indexPrStates, type PrState } from './card-reconcile.js';

// Periodic board reconciler (STDIO-407). Run on a schedule by the card-reconcile
// workflow: it recomputes each card's desired column from live PR state across
// the org and fixes drift the event-driven card-sync (STDIO-236) may have missed
// — most importantly a PR closed WITHOUT merging, which strands its card.
// Best-effort: any failure logs and exits 0, because a reconcile must never wedge
// the pipeline. The board token (NOTION_API_KEY) is never logged.
//
// Env: BOARD_URL (the board), NOTION_API_KEY (board token), GH_OWNER (the org to
// scan, default verevoir), RECONCILE_USER_ID (the board user the automation acts
// as — cards in progress assigned to anyone else are left alone), and a
// gh-authenticated token (GH_TOKEN / GITHUB_TOKEN) for the PR search.

const owner = process.env.GH_OWNER?.trim() || 'verevoir';

/** Search the org's PRs in one state bucket, tagging each row with that state.
 * The work-item id is read from the PR title downstream (the cross-org search
 * doesn't expose the branch). */
function searchPrs(query: string, state: PrState): { state: PrState; title: string }[] {
  const out = execFileSync(
    'gh',
    ['search', 'prs', query, '--owner', owner, '--limit', '500', '--json', 'title'],
    { encoding: 'utf8' }
  );
  const rows = JSON.parse(out) as { title: string }[];
  return rows.map((r) => ({ state, title: r.title }));
}

async function main(): Promise<void> {
  const boardUrl = process.env.BOARD_URL?.trim();
  if (!boardUrl) {
    console.log('card-reconcile: nothing to do (no BOARD_URL)');
    return;
  }

  // Gather PR state across the org in three buckets — open, merged, and
  // closed-without-merge — then reduce to the set of states per work-item id.
  const prs = [
    ...searchPrs('is:open', 'open'),
    ...searchPrs('is:merged', 'merged'),
    ...searchPrs('is:closed is:unmerged', 'closed'),
  ];
  const prStatesById = indexPrStates(prs);

  const adapter = await pickWorkflowAdapter(boardUrl);
  const env = resolveWorkflowEnv(boardUrl);
  const result = await reconcileBoard(adapter, env, boardUrl, prStatesById, {
    operatingUserId: process.env.RECONCILE_USER_ID?.trim() || undefined,
  });

  if (result.moved.length === 0 && result.failed.length === 0) {
    console.log(
      `card-reconcile: board already in sync (${prStatesById.size} work-item id(s) with PRs).`
    );
  }
  for (const m of result.moved) {
    console.log(
      `card-reconcile: ${m.readableId} "${m.fromColumn}" → "${m.toColumn}" (drift fixed)`
    );
  }
  for (const s of result.skipped) {
    console.log(`card-reconcile: ${s.readableId} left alone — ${s.reason}`);
  }
  for (const f of result.failed) {
    console.warn(`card-reconcile: ${f.move.readableId} → "${f.move.toColumn}" failed — ${f.error}`);
  }
  if (result.unknownColumns.length) {
    console.warn(`card-reconcile: board has no column named: ${result.unknownColumns.join(', ')}`);
  }
}

main().catch((err: unknown) => {
  // Never fail the pipeline over a reconcile hiccup; config/network errors don't
  // echo the board token.
  console.warn(
    `card-reconcile: skipped after error — ${err instanceof Error ? err.message : String(err)}`
  );
});
