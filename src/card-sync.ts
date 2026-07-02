import type { WorkflowEnv, Card, Column, CardFilter } from '@verevoir/workflows';

// Card sync (STDIO-236) — move a work-tracker card to a column from the PR
// lifecycle, deterministically, instead of an agent remembering to do it by
// hand. The CI workflow keys off the work-item id in the branch / PR (the
// `<Namespace>-<id>` convention) and the PR event (opened → preview, merged →
// Done). This file is the pure core; the bin wires env + the real adapter.

/** The slice of a `@verevoir/workflows` adapter this needs — structural, so the
 * real adapter satisfies it and a test can fake just these three. */
export interface CardMover {
  listCards(env: WorkflowEnv, boardUrl: string, filter?: CardFilter): Promise<Card[]>;
  listColumns(env: WorkflowEnv, boardUrl: string): Promise<Column[]>;
  moveCard(
    env: WorkflowEnv,
    boardUrl: string,
    cardId: string,
    toColumnId: string
  ): Promise<unknown>;
}

export type SyncResult =
  | { status: 'moved'; cardId: string; toColumnId: string }
  | { status: 'card-not-found'; readableId: string }
  | { status: 'column-not-found'; column: string };

/** Pull the work-item id (`STDIO-404`, `Trello-34`, …) out of a branch name or
 * PR title. The id namespace is mandatory by convention, so the match is
 * `<Namespace>-<number>`. Returns null when there's no id to act on (a branch
 * that doesn't follow the convention is skipped, not an error). */
export function extractWorkItemId(text: string): string | null {
  const m = text.match(/\b([A-Za-z][A-Za-z0-9]*-\d+)\b/);
  return m ? m[1] : null;
}

/**
 * Move the card whose `readableId` matches to the named column. Returns a
 * legible result rather than throwing for the expected misses (no such card on
 * the board, no such column) — the caller logs it and carries on; board sync
 * must never block a merge. Column match is case-insensitive.
 */
export async function syncCard(
  mover: CardMover,
  env: WorkflowEnv,
  boardUrl: string,
  readableId: string,
  toColumnName: string
): Promise<SyncResult> {
  // Without bodies: card-sync only needs id / readableId / columnId, and on a
  // large Notion board fetching every card's markdown body is one API call per
  // row — which times out (the `pages.retrieveMarkdown` timeout that silently
  // skipped real syncs). `getCard` fetches a single body on demand if ever needed.
  const cards = await mover.listCards(env, boardUrl, { includeBody: false });
  const card = cards.find((c) => c.readableId === readableId);
  if (!card) return { status: 'card-not-found', readableId };

  const columns = await mover.listColumns(env, boardUrl);
  const column = columns.find((c) => c.name.toLowerCase() === toColumnName.toLowerCase());
  if (!column) return { status: 'column-not-found', column: toColumnName };

  await mover.moveCard(env, boardUrl, card.id, column.id);
  return { status: 'moved', cardId: card.id, toColumnId: column.id };
}
