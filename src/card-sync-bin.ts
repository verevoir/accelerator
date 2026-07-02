#!/usr/bin/env node
import { pickWorkflowAdapter, resolveWorkflowEnv } from './router.js';
import { syncCard, extractWorkItemId } from './card-sync.js';

// Move the work-tracker card for this PR (STDIO-236). Run by the card-sync CI
// workflow off the PR lifecycle — opened → "In preview", merged → "Done" —
// keyed by the work-item id in the branch. Best-effort: ANY failure (missing
// config, unknown card, network) logs and exits 0, because board sync must
// never block a merge; the periodic reconciler (follow-on) catches misses.
//
// Env: BOARD_URL, PR_HEAD_REF (the branch), TARGET_COLUMN, and the board's
// token (NOTION_API_KEY for a Notion board) — supplied as CI secrets, never
// committed and never logged.

async function main(): Promise<void> {
  const boardUrl = process.env.BOARD_URL?.trim();
  const ref = process.env.PR_HEAD_REF?.trim() ?? '';
  const toColumn = process.env.TARGET_COLUMN?.trim();
  const id = ref ? extractWorkItemId(ref) : null;

  if (!boardUrl || !toColumn || !id) {
    console.log(
      `card-sync: nothing to do (board=${Boolean(boardUrl)}, column=${toColumn || '—'}, id=${id ?? '—'})`
    );
    return;
  }

  const adapter = await pickWorkflowAdapter(boardUrl);
  const env = resolveWorkflowEnv(boardUrl);
  const result = await syncCard(adapter, env, boardUrl, id, toColumn);
  console.log(`card-sync: ${id} → "${toColumn}" — ${result.status}`);
}

main().catch((err: unknown) => {
  // Never fail the pipeline over a board-sync hiccup; the message carries no
  // secret (config/network errors don't echo the token).
  console.warn(
    `card-sync: skipped after error — ${err instanceof Error ? err.message : String(err)}`
  );
});
