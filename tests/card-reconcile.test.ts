import { describe, it, expect, vi } from 'vitest';
import {
  desiredColumn,
  indexPrStates,
  planReconciliation,
  reconcileBoard,
  type PrState,
} from '../src/card-reconcile.js';
import type { CardMover } from '../src/card-sync.js';
import type { Card, Column, WorkflowEnv } from '@verevoir/workflows';

const env: WorkflowEnv = { token: 't' };
const board = 'https://www.notion.so/board';

const COLUMNS = [
  { id: 'col-todo', name: 'Not started' },
  { id: 'col-prog', name: 'In progress' },
  { id: 'col-prev', name: 'In preview' },
  { id: 'col-done', name: 'Done' },
] as Column[];

function mover(
  cards: Partial<Card>[],
  columns: Partial<Column>[] = COLUMNS
): CardMover & { listCards: ReturnType<typeof vi.fn>; moveCard: ReturnType<typeof vi.fn> } {
  return {
    listCards: vi.fn(async () => cards as Card[]),
    listColumns: async () => columns as Column[],
    moveCard: vi.fn(async () => ({ ok: true })),
  };
}

describe('desiredColumn (STDIO-407)', () => {
  it('an open PR puts the card in preview', () => {
    expect(desiredColumn(['open'])).toBe('In preview');
  });

  it('a merged PR puts the card in done', () => {
    expect(desiredColumn(['merged'])).toBe('Done');
  });

  it('a PR closed without merging sends the card back to not started', () => {
    expect(desiredColumn(['closed'])).toBe('Not started');
  });

  it('an open PR wins over a merged or closed one for the same work-item', () => {
    // A follow-up PR is open while an earlier one merged — the work is in review.
    expect(desiredColumn(['merged', 'open'])).toBe('In preview');
    expect(desiredColumn(['closed', 'open'])).toBe('In preview');
  });

  it('a merge wins over a superseded closed PR', () => {
    expect(desiredColumn(['closed', 'merged'])).toBe('Done');
  });

  it('returns null when there is no PR signal, so the card is left untouched', () => {
    expect(desiredColumn([])).toBeNull();
  });
});

describe('indexPrStates (STDIO-407)', () => {
  it('groups PRs by work-item id, taking the id from the branch or the title', () => {
    const map = indexPrStates([
      { state: 'merged', headRefName: 'STDIO-236-card-sync' },
      { state: 'open', title: 'STDIO-407: reconciler' },
    ]);
    expect(map.get('STDIO-236')).toEqual(['merged']);
    expect(map.get('STDIO-407')).toEqual(['open']);
  });

  it('collects the distinct set of states across an id with several PRs', () => {
    const map = indexPrStates([
      { state: 'closed', title: 'STDIO-9: first attempt' },
      { state: 'merged', title: 'STDIO-9: redo' },
      { state: 'merged', title: 'STDIO-9: follow-up' },
    ]);
    expect(map.get('STDIO-9')?.sort()).toEqual(['closed', 'merged']);
  });

  it('ignores a PR carrying no work-item id rather than guessing', () => {
    const map = indexPrStates([{ state: 'open', title: 'tidy up the readme' }]);
    expect(map.size).toBe(0);
  });
});

describe('planReconciliation (STDIO-407)', () => {
  const states = (entries: [string, PrState[]][]) => new Map(entries);
  const cards = (xs: Partial<Card>[]) => xs as Card[];

  it('plans a move for a card stranded out of the column its PR state implies', () => {
    // The drift this card exists to fix: a closed-unmerged PR left its card in
    // "In progress"; it belongs back in "Not started".
    const { moves } = planReconciliation(
      cards([{ id: 'c1', readableId: 'STDIO-314', columnId: 'col-prog' }]),
      states([['STDIO-314', ['closed']]]),
      COLUMNS
    );
    expect(moves).toEqual([
      {
        cardId: 'c1',
        readableId: 'STDIO-314',
        fromColumn: 'In progress',
        toColumn: 'Not started',
        toColumnId: 'col-todo',
      },
    ]);
  });

  it('plans no move for a card already in its desired column', () => {
    const { moves } = planReconciliation(
      cards([{ id: 'c1', readableId: 'STDIO-1', columnId: 'col-done' }]),
      states([['STDIO-1', ['merged']]]),
      COLUMNS
    );
    expect(moves).toEqual([]);
  });

  it('leaves a card with no PR signal untouched', () => {
    const { moves } = planReconciliation(
      cards([{ id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog' }]),
      states([]),
      COLUMNS
    );
    expect(moves).toEqual([]);
  });

  it('skips a card with no readableId — it cannot be keyed to a PR', () => {
    const { moves } = planReconciliation(
      cards([{ id: 'c1', columnId: 'col-prog' }]),
      states([['STDIO-1', ['merged']]]),
      COLUMNS
    );
    expect(moves).toEqual([]);
  });

  it('reports a desired column the board does not have rather than forcing it', () => {
    const { moves, unknownColumns } = planReconciliation(
      cards([{ id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog' }]),
      states([['STDIO-1', ['merged']]]),
      [{ id: 'col-prog', name: 'In progress' }] as Column[] // no "Done" column
    );
    expect(moves).toEqual([]);
    expect(unknownColumns).toEqual(['Done']);
  });

  it('leaves an in-progress card assigned to another user alone, recording why', () => {
    const { moves, skipped } = planReconciliation(
      cards([
        { id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog', assigneeIds: ['someone-else'] },
      ]),
      states([['STDIO-1', ['open']]]), // PR state would otherwise move it to preview
      COLUMNS,
      { operatingUserId: 'me' }
    );
    expect(moves).toEqual([]);
    expect(skipped).toEqual([
      { readableId: 'STDIO-1', reason: 'in progress, assigned to another user' },
    ]);
  });

  it('reconciles an in-progress card assigned to the operating user', () => {
    const { moves } = planReconciliation(
      cards([{ id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog', assigneeIds: ['me'] }]),
      states([['STDIO-1', ['open']]]),
      COLUMNS,
      { operatingUserId: 'me' }
    );
    expect(moves.map((m) => m.toColumn)).toEqual(['In preview']);
  });

  it('only guards the in-progress column — another user owning a merged card still gets it moved to Done', () => {
    const { moves } = planReconciliation(
      cards([
        { id: 'c1', readableId: 'STDIO-1', columnId: 'col-prev', assigneeIds: ['someone-else'] },
      ]),
      states([['STDIO-1', ['merged']]]),
      COLUMNS,
      { operatingUserId: 'me' }
    );
    expect(moves.map((m) => m.toColumn)).toEqual(['Done']);
  });

  it('force overrides the ownership guard ("unless instructed otherwise")', () => {
    const { moves, skipped } = planReconciliation(
      cards([
        { id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog', assigneeIds: ['someone-else'] },
      ]),
      states([['STDIO-1', ['open']]]),
      COLUMNS,
      { operatingUserId: 'me', force: true }
    );
    expect(skipped).toEqual([]);
    expect(moves.map((m) => m.toColumn)).toEqual(['In preview']);
  });
});

describe('reconcileBoard (STDIO-407)', () => {
  it('applies the planned moves through the adapter', async () => {
    const m = mover([
      { id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog' }, // merged → Done
      { id: 'c2', readableId: 'STDIO-2', columnId: 'col-prev' }, // already In preview
    ]);
    const result = await reconcileBoard(
      m,
      env,
      board,
      new Map<string, PrState[]>([
        ['STDIO-1', ['merged']],
        ['STDIO-2', ['open']],
      ])
    );
    expect(result.moved.map((x) => x.readableId)).toEqual(['STDIO-1']);
    expect(m.moveCard).toHaveBeenCalledTimes(1);
    expect(m.moveCard).toHaveBeenCalledWith(env, board, 'c1', 'col-done');
  });

  it('lists cards without bodies — fetching every row times out on a large board', async () => {
    const m = mover([{ id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog' }]);
    await reconcileBoard(m, env, board, new Map<string, PrState[]>([['STDIO-1', ['merged']]]));
    expect(m.listCards).toHaveBeenCalledWith(env, board, { includeBody: false });
  });

  it('keeps going when one move fails, reporting the failure rather than wedging', async () => {
    const m = mover([
      { id: 'c1', readableId: 'STDIO-1', columnId: 'col-prog' },
      { id: 'c2', readableId: 'STDIO-2', columnId: 'col-prog' },
    ]);
    m.moveCard.mockImplementationOnce(async () => {
      throw new Error('notion 502');
    });
    const result = await reconcileBoard(
      m,
      env,
      board,
      new Map<string, PrState[]>([
        ['STDIO-1', ['merged']],
        ['STDIO-2', ['merged']],
      ])
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toContain('notion 502');
    expect(result.moved).toHaveLength(1); // the other still moved
  });
});
