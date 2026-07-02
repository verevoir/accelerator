import { describe, it, expect, vi } from 'vitest';
import { syncCard, extractWorkItemId, type CardMover } from '../src/card-sync.js';
import type { Card, Column, WorkflowEnv } from '@verevoir/workflows';

const env: WorkflowEnv = { token: 't' };
const board = 'https://www.notion.so/board';

function mover(
  cards: Partial<Card>[],
  columns: Partial<Column>[]
): CardMover & { listCards: ReturnType<typeof vi.fn>; moveCard: ReturnType<typeof vi.fn> } {
  return {
    listCards: vi.fn(async () => cards as Card[]),
    listColumns: async () => columns as Column[],
    moveCard: vi.fn(async () => ({ ok: true })),
  };
}

describe('extractWorkItemId (STDIO-236)', () => {
  it('pulls the namespaced work-item id from a branch name', () => {
    expect(extractWorkItemId('STDIO-404-a2a-auth')).toBe('STDIO-404');
    expect(extractWorkItemId('Trello-34-bump-deps')).toBe('Trello-34');
  });

  it('returns null when the branch carries no work-item id', () => {
    expect(extractWorkItemId('main')).toBeNull();
    expect(extractWorkItemId('fix-the-thing')).toBeNull();
  });
});

describe('syncCard (STDIO-236)', () => {
  it('moves the card matching the readableId to the named column', async () => {
    const m = mover(
      [
        { id: 'c1', readableId: 'STDIO-404' },
        { id: 'c2', readableId: 'STDIO-236' },
      ],
      [
        { id: 'col-prev', name: 'In preview' },
        { id: 'col-done', name: 'Done' },
      ]
    );
    const r = await syncCard(m, env, board, 'STDIO-236', 'Done');
    expect(r).toEqual({ status: 'moved', cardId: 'c2', toColumnId: 'col-done' });
    expect(m.moveCard).toHaveBeenCalledWith(env, board, 'c2', 'col-done');
  });

  it('lists cards without bodies — a large board times out fetching every row', async () => {
    const m = mover([{ id: 'c1', readableId: 'STDIO-1' }], [{ id: 'd', name: 'Done' }]);
    await syncCard(m, env, board, 'STDIO-1', 'Done');
    expect(m.listCards).toHaveBeenCalledWith(env, board, { includeBody: false });
  });

  it('matches the column name case-insensitively', async () => {
    const m = mover([{ id: 'c1', readableId: 'STDIO-1' }], [{ id: 'p', name: 'In Preview' }]);
    expect((await syncCard(m, env, board, 'STDIO-1', 'in preview')).status).toBe('moved');
  });

  it('reports card-not-found and moves nothing', async () => {
    const m = mover([{ id: 'c1', readableId: 'STDIO-1' }], [{ id: 'd', name: 'Done' }]);
    expect(await syncCard(m, env, board, 'STDIO-999', 'Done')).toEqual({
      status: 'card-not-found',
      readableId: 'STDIO-999',
    });
    expect(m.moveCard).not.toHaveBeenCalled();
  });

  it('reports column-not-found and moves nothing', async () => {
    const m = mover([{ id: 'c1', readableId: 'STDIO-1' }], [{ id: 'd', name: 'Done' }]);
    expect(await syncCard(m, env, board, 'STDIO-1', 'Nope')).toEqual({
      status: 'column-not-found',
      column: 'Nope',
    });
    expect(m.moveCard).not.toHaveBeenCalled();
  });
});
