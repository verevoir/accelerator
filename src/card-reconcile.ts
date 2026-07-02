import type { WorkflowEnv, Card, Column } from '@verevoir/workflows';
import { extractWorkItemId, type CardMover } from './card-sync.js';

// Periodic reconciler (STDIO-407) — the self-healing safety net under the
// event-driven card-sync (STDIO-236). Events can be missed: a webhook drops, or
// a PR is closed WITHOUT merging and strands its card in "In progress" (the
// drift we kept fixing by hand). This recomputes each card's DESIRED column from
// all live PR state for its work-item id and emits the moves that fix the drift
// — the controller / reconcile-toward-desired-state pattern. This file is the
// pure core; the bin gathers PR state via `gh` and drives the real adapter.

/** A work-item's PR state, reduced from one PR. `closed` means closed *without*
 * merging — distinct from `merged`, because they imply opposite desired states. */
export type PrState = 'open' | 'merged' | 'closed';

/**
 * The board column a card should be in, given every PR state seen for its
 * work-item id. Precedence matters when an id has several PRs:
 *   - any **open** PR → "In preview" (work is actively in review, even if an
 *     earlier PR already merged or was abandoned);
 *   - else any **merged** PR → "Done" (shipped; a superseded closed PR alongside
 *     it doesn't undo that);
 *   - else only **closed-unmerged** PRs → "Not started" (the work isn't
 *     happening — this is the closed-without-merge drift, sent back rather than
 *     left stranded).
 * `null` when there's no PR state at all — no signal, so the card is left where
 * a human put it (manual or pre-PR work the reconciler must not touch).
 */
export function desiredColumn(states: PrState[]): string | null {
  if (states.includes('open')) return 'In preview';
  if (states.includes('merged')) return 'Done';
  if (states.includes('closed')) return 'Not started';
  return null;
}

/** Group PRs by work-item id, reducing each id to the distinct set of states
 * seen across its PRs. The id comes from the branch when present, else the PR
 * title (both follow the `<Namespace>-<id>` convention); a PR carrying no id is
 * ignored rather than guessed at. */
export function indexPrStates(
  prs: { state: PrState; headRefName?: string; title?: string }[]
): Map<string, PrState[]> {
  const byId = new Map<string, Set<PrState>>();
  for (const pr of prs) {
    const id = extractWorkItemId(pr.headRefName ?? '') ?? extractWorkItemId(pr.title ?? '');
    if (!id) continue;
    let states = byId.get(id);
    if (!states) {
      states = new Set();
      byId.set(id, states);
    }
    states.add(pr.state);
  }
  return new Map([...byId].map(([id, states]) => [id, [...states]]));
}

/** A single drift-fixing move the reconciler plans. */
export interface PlannedMove {
  cardId: string;
  readableId: string;
  fromColumn: string;
  toColumn: string;
  toColumnId: string;
}

/** A card the reconciler deliberately left alone, with why — so a pass is
 * legible about what it chose not to touch, not silently selective. */
export interface SkippedCard {
  readableId: string;
  reason: string;
}

/** How to run a reconcile pass. */
export interface ReconcileOptions {
  /** The board user the automation acts as. A card in the in-progress column
   * assigned to a *different* user is someone else's active work, so the
   * reconciler leaves it alone (ownership guard) — unless `force` overrides.
   * When unset, the reconciler can't confirm ownership, so it treats any
   * assigned in-progress card as another's and stays off it. */
  operatingUserId?: string;
  /** The column name that means "actively being worked" (default "In
   * progress") — the only column the ownership guard applies to. */
  inProgressColumn?: string;
  /** Override the ownership guard and reconcile even another user's
   * in-progress cards ("unless instructed to do otherwise"). */
  force?: boolean;
}

/**
 * Compare each card's current column against the one its PR state implies, and
 * plan a move for every card that has drifted. Cards with no PR signal, or
 * already in the right column, are left alone. `columnId` is the source of truth
 * for the current column (`columnName` is only advisory), so both current and
 * target are resolved through the columns list. A desired column that doesn't
 * exist on the board is reported in `unknownColumns` rather than forced.
 *
 * Ownership guard: a card sitting in the in-progress column assigned to a user
 * other than the operating user is someone else's active work — the reconciler
 * records it in `skipped` and does not move it, unless `force` is set.
 */
export function planReconciliation(
  cards: Card[],
  prStatesById: Map<string, PrState[]>,
  columns: Column[],
  opts: ReconcileOptions = {}
): { moves: PlannedMove[]; unknownColumns: string[]; skipped: SkippedCard[] } {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  const inProgress = (opts.inProgressColumn ?? 'In progress').toLowerCase();
  const moves: PlannedMove[] = [];
  const unknownColumns = new Set<string>();
  const skipped: SkippedCard[] = [];

  for (const card of cards) {
    if (!card.readableId) continue; // can't key a card with no human id
    const states = prStatesById.get(card.readableId);
    if (!states || states.length === 0) continue; // no PR signal — don't touch
    const want = desiredColumn(states);
    if (!want) continue;

    const current = byId.get(card.columnId);
    const assignees = card.assigneeIds ?? [];
    const ownedByAnother =
      assignees.length > 0 && (!opts.operatingUserId || !assignees.includes(opts.operatingUserId));
    if (!opts.force && current?.name.toLowerCase() === inProgress && ownedByAnother) {
      skipped.push({
        readableId: card.readableId,
        reason: 'in progress, assigned to another user',
      });
      continue;
    }

    const target = byName.get(want.toLowerCase());
    if (!target) {
      unknownColumns.add(want);
      continue;
    }
    if (target.id === card.columnId) continue; // already where it belongs

    moves.push({
      cardId: card.id,
      readableId: card.readableId,
      fromColumn: current?.name ?? card.columnId,
      toColumn: target.name,
      toColumnId: target.id,
    });
  }
  return { moves, unknownColumns: [...unknownColumns], skipped };
}

/** The outcome of a reconcile pass — what was planned, what moved, what failed,
 * what was deliberately skipped, and any desired columns the board doesn't have. */
export interface ReconcileResult {
  planned: PlannedMove[];
  moved: PlannedMove[];
  failed: { move: PlannedMove; error: string }[];
  skipped: SkippedCard[];
  unknownColumns: string[];
}

/**
 * Reconcile the board toward its PR-derived desired state: list the cards and
 * columns, plan the drift-fixing moves, and apply them. Best-effort per move —
 * one failing move doesn't abort the rest, because a reconciler must not wedge
 * the whole board on a single bad card.
 */
export async function reconcileBoard(
  mover: CardMover,
  env: WorkflowEnv,
  boardUrl: string,
  prStatesById: Map<string, PrState[]>,
  opts: ReconcileOptions = {}
): Promise<ReconcileResult> {
  // Bodies aren't needed (only id / readableId / columnId / assigneeIds), and
  // fetching them is one API call per row on Notion — a timeout risk on a large
  // board, the same one that silently skipped event-driven syncs.
  const cards = await mover.listCards(env, boardUrl, { includeBody: false });
  const columns = await mover.listColumns(env, boardUrl);
  const { moves, unknownColumns, skipped } = planReconciliation(cards, prStatesById, columns, opts);

  const moved: PlannedMove[] = [];
  const failed: { move: PlannedMove; error: string }[] = [];
  for (const move of moves) {
    try {
      await mover.moveCard(env, boardUrl, move.cardId, move.toColumnId);
      moved.push(move);
    } catch (e) {
      failed.push({ move, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { planned: moves, moved, failed, skipped, unknownColumns };
}
