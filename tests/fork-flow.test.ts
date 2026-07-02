import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../src/router.js', () => ({
  pickSourceAdapter: vi.fn(),
  resolveSourceEnv: vi.fn(() => ({ token: 't', forkOrg: 'aigency-forks' })),
}));

import { registerSourceTools } from '../src/tools/source.js';
import { pickSourceAdapter } from '../src/router.js';

const env = { token: 't', forkOrg: 'aigency-forks' };

/** Capture the tool handlers a `registerSourceTools` call registers, so a test
 * can drive a tool through its real registered handler. */
type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
function harness(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerSourceTools(server);
  return handlers;
}

function adapter() {
  return {
    ensureFork: vi.fn(async () => 'https://github.com/aigency-forks/repo.git'),
    ensureBranch: vi.fn(async () => undefined),
    openPullRequest: vi.fn(async () => 'https://github.com/owner/repo/pull/7'),
  };
}

beforeEach(() => vi.mocked(pickSourceAdapter).mockReset());

describe('fork-isolated write-flow tools (STDIO-409)', () => {
  it('registers ensure_fork, ensure_branch, and open_pull_request', () => {
    const h = harness();
    expect(Object.keys(h)).toEqual(
      expect.arrayContaining(['ensure_fork', 'ensure_branch', 'open_pull_request'])
    );
  });

  it('ensure_fork forks the source repo and returns the working URL (the fork)', async () => {
    const a = adapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    const res = await harness().ensure_fork({ sourceUrl: 'https://github.com/owner/repo' });
    expect(a.ensureFork).toHaveBeenCalledWith(env, 'https://github.com/owner/repo');
    expect(res.content[0].text).toContain('workingUrl');
    expect(res.content[0].text).toContain('aigency-forks/repo');
  });

  it('ensure_branch creates the branch on the working URL (the fork), not the source', async () => {
    const a = adapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    const res = await harness().ensure_branch({
      workingUrl: 'https://github.com/aigency-forks/repo',
      branch: 'NC-5-onboard-tf',
    });
    expect(a.ensureBranch).toHaveBeenCalledWith(
      env,
      'https://github.com/aigency-forks/repo',
      'NC-5-onboard-tf'
    );
    expect(res.content[0].text).toContain('NC-5-onboard-tf');
  });

  it('open_pull_request targets the source repo with a head built from the working fork', async () => {
    const a = adapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    const res = await harness().open_pull_request({
      sourceUrl: 'https://github.com/owner/repo',
      workingUrl: 'https://github.com/aigency-forks/repo',
      branch: 'NC-5-onboard-tf',
      base: 'main',
      title: 'NC-5: onboard terraform',
      body: 'docs/infrastructure.md',
    });
    // PR opened against the SOURCE (target), head built from the WORKING fork's
    // owner — the hermetic shape (changes live on the fork, the source only ever
    // receives a PR). The caller never hand-builds the `<owner>:<branch>` head.
    expect(a.openPullRequest).toHaveBeenCalledWith(
      env,
      'https://github.com/owner/repo',
      'aigency-forks:NC-5-onboard-tf',
      'main',
      'NC-5: onboard terraform',
      'docs/infrastructure.md'
    );
    expect(res.content[0].text).toContain('/pull/7');
  });

  it('open_pull_request uses a same-repo head when source and working are the same (owned repo)', async () => {
    const a = adapter();
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    await harness().open_pull_request({
      sourceUrl: 'https://github.com/owner/repo',
      workingUrl: 'https://github.com/owner/repo',
      branch: 'feature-x',
      base: 'main',
      title: 't',
      body: 'b',
    });
    // No fork → head is just the branch, not `owner:branch`.
    expect(a.openPullRequest).toHaveBeenCalledWith(
      env,
      'https://github.com/owner/repo',
      'feature-x',
      'main',
      't',
      'b'
    );
  });

  it('surfaces a fork failure to the caller rather than swallowing it', async () => {
    const a = adapter();
    a.ensureFork.mockRejectedValueOnce(new Error('GitHub forkRepo failed (403)'));
    vi.mocked(pickSourceAdapter).mockResolvedValue(a as never);
    await expect(
      harness().ensure_fork({ sourceUrl: 'https://github.com/owner/repo' })
    ).rejects.toThrow(/forkRepo failed/);
  });
});
