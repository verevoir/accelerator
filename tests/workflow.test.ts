import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../src/router.js', () => ({
  pickWorkflowAdapter: vi.fn(),
  resolveWorkflowEnv: vi.fn(() => ({ token: 't' })),
}));

import { definedOnly, registerWorkflowTools } from '../src/tools/workflow.js';
import { pickWorkflowAdapter } from '../src/router.js';

describe('definedOnly', () => {
  it('drops keys whose value is undefined', () => {
    expect(definedOnly({ title: 'x', body: undefined, columnId: undefined })).toEqual({
      title: 'x',
    });
  });

  it('keeps falsy-but-defined values — an empty body or empty label set are meaningful writes', () => {
    expect(definedOnly({ body: '', labelIds: [] })).toEqual({ body: '', labelIds: [] });
  });

  it('returns an empty object when every field is undefined', () => {
    expect(definedOnly({ title: undefined, body: undefined })).toEqual({});
  });
});

/** Capture the tool handlers `registerWorkflowTools` registers, to drive a tool
 * through its real handler with a faked adapter. */
type Handler = (args: Record<string, unknown>) => Promise<unknown>;
function handlers(): Record<string, Handler> {
  const h: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      h[name] = handler;
    },
  } as unknown as McpServer;
  registerWorkflowTools(server);
  return h;
}

describe('card assignees through update_card / create_card (STDIO-408)', () => {
  it('update_card passes assigneeIds through to the adapter patch', async () => {
    const updateCard = vi.fn(async () => {});
    vi.mocked(pickWorkflowAdapter).mockResolvedValue({ updateCard } as never);
    await handlers().update_card({ boardUrl: 'b', cardId: 'c', assigneeIds: ['u1'] });
    expect(updateCard).toHaveBeenCalledWith({ token: 't' }, 'b', 'c', { assigneeIds: ['u1'] });
  });

  it('omitting assigneeIds leaves it out of the patch — no clobber of existing assignees', async () => {
    const updateCard = vi.fn(async () => {});
    vi.mocked(pickWorkflowAdapter).mockResolvedValue({ updateCard } as never);
    await handlers().update_card({ boardUrl: 'b', cardId: 'c', title: 'x' });
    expect(updateCard).toHaveBeenCalledWith({ token: 't' }, 'b', 'c', { title: 'x' });
  });

  it('create_card carries assigneeIds into the created card fields', async () => {
    const createCard = vi.fn(async () => ({ id: 'c' }));
    vi.mocked(pickWorkflowAdapter).mockResolvedValue({ createCard } as never);
    await handlers().create_card({
      boardUrl: 'b',
      columnId: 'col',
      title: 't',
      assigneeIds: ['u1'],
    });
    expect((createCard.mock.calls[0] as unknown[])[3]).toMatchObject({
      title: 't',
      assigneeIds: ['u1'],
    });
  });
});
