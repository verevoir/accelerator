import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickSourceAdapter, pickWorkflowAdapter, resolveWorkflowEnv } from '../src/router.js';

describe('pickSourceAdapter', () => {
  it('returns the github adapter for a github.com URL', async () => {
    const adapter = await pickSourceAdapter('https://github.com/verevoir/context');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the github adapter for a www.github.com URL', async () => {
    const adapter = await pickSourceAdapter('https://www.github.com/verevoir/context');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for an absolute path', async () => {
    const adapter = await pickSourceAdapter('/Users/adam/projects/foo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a tilde path', async () => {
    const adapter = await pickSourceAdapter('~/projects/foo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a relative ./ path', async () => {
    const adapter = await pickSourceAdapter('./relative/path');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the fs adapter for a file:// URL', async () => {
    const adapter = await pickSourceAdapter('file:///tmp/repo');
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('returns the notion adapter for a notion.so URL', async () => {
    const adapter = await pickSourceAdapter(
      'https://www.notion.so/myws/Root-aabbccdd11223344556677889900aabb'
    );
    expect(adapter).toBeDefined();
    expect(typeof adapter.readFile).toBe('function');
  });

  it('throws for an unsupported URL', async () => {
    await expect(pickSourceAdapter('https://gitlab.com/owner/repo')).rejects.toThrow(
      'Unsupported source URL'
    );
  });

  it('throws for a plain hostname', async () => {
    await expect(pickSourceAdapter('example.com/repo')).rejects.toThrow('Unsupported source URL');
  });
});

describe('pickWorkflowAdapter', () => {
  it('returns the trello adapter for a trello board URL', async () => {
    const adapter = await pickWorkflowAdapter('https://trello.com/b/abc123/my-board');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns the trello adapter for a bare trello board URL (no slug)', async () => {
    const adapter = await pickWorkflowAdapter('https://trello.com/b/abc123');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listCards).toBe('function');
  });

  it('returns the notion adapter for a notion.so database URL', async () => {
    const adapter = await pickWorkflowAdapter(
      'https://www.notion.so/myws/369772cdbf9f80ab8900e7b7a96c5422?v=abcdef'
    );
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns an adapter for an absolute path (Obsidian Kanban board)', async () => {
    const adapter = await pickWorkflowAdapter('/abs/path/Board.md');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('returns an adapter for a file:// board URL (Obsidian Kanban board)', async () => {
    const adapter = await pickWorkflowAdapter('file:///abs/path/Board.md');
    expect(adapter).toBeDefined();
    expect(typeof adapter.listColumns).toBe('function');
  });

  it('routes a Backlog.md project directory to the backlog adapter, not Obsidian', async () => {
    // Behavioural proof of the directory-vs-.md split: the backlog adapter reads
    // columns from backlog/config.yml; Obsidian would try to parse the path as a
    // board .md and never produce these columns.
    const root = mkdtempSync(join(tmpdir(), 'mcp-router-backlog-'));
    mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'backlog', 'config.yml'), 'statuses:\n  - Todo\n  - Shipped\n');
    try {
      const adapter = await pickWorkflowAdapter(root);
      const columns = await adapter.listColumns({ token: '' }, root);
      expect(columns.map((c) => c.name)).toEqual(['Todo', 'Shipped']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws for a Jira URL', async () => {
    await expect(
      pickWorkflowAdapter('https://myorg.atlassian.net/jira/software/projects/P')
    ).rejects.toThrow('Unsupported board URL');
  });

  it('throws for a bare unsupported string', async () => {
    await expect(pickWorkflowAdapter('gitlab.com/x')).rejects.toThrow('Unsupported board URL');
  });
});

describe('resolveSourceEnv — the GitHub credential', () => {
  const GITHUB_SOURCE = 'https://github.com/verevoir/accelerator';
  const saved = {
    path: process.env.PATH,
    token: process.env.GITHUB_TOKEN,
    forkOrg: process.env.SOURCE_FORK_ORG,
  };
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const [k, v] of [
      ['PATH', saved.path],
      ['GITHUB_TOKEN', saved.token],
      ['SOURCE_FORK_ORG', saved.forkOrg],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  /** Put the process in a known credential situation and hand back a freshly
   * imported `resolveSourceEnv`. PATH is narrowed to a throwaway directory, so
   * `gh` exists for the call only when `ghScript` supplies one — the default is
   * the container's situation, no CLI at all. Re-importing per case is what keeps
   * the cases independent: a `gh` hit is remembered for the module's lifetime. */
  async function credentialEnv({
    ghScript,
    githubToken,
    forkOrg,
  }: { ghScript?: string; githubToken?: string; forkOrg?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-router-gh-'));
    tempDirs.push(dir);
    if (ghScript !== undefined) {
      const gh = join(dir, 'gh');
      writeFileSync(gh, ghScript);
      chmodSync(gh, 0o755);
    }
    process.env.PATH = dir;
    for (const [k, v] of [
      ['GITHUB_TOKEN', githubToken],
      ['SOURCE_FORK_ORG', forkOrg],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    return (await import('../src/router.js')).resolveSourceEnv;
  }

  // PATH is narrowed to the fake gh's own directory for the duration of a case, so
  // these scripts restore a usable one for themselves. Without it `sleep` and
  // `dirname` are simply absent and every script below exits 127 immediately —
  // which each of these cases would happily pass on, for entirely the wrong reason.
  const SH = '#!/bin/sh\nPATH=/usr/bin:/bin\n';

  const GH_PRINTS_TOKEN = `${SH}echo gho_from_gh_cli\n`;

  /** A `gh` that reports which invocation it is, so a second call to
   * `resolveSourceEnv` can be told apart from a remembered first one. */
  const GH_COUNTS_ITS_CALLS = [
    SH.trimEnd(),
    'c="$(dirname "$0")/calls"',
    'n=$(( $(cat "$c" 2>/dev/null || echo 0) + 1 ))',
    'echo "$n" > "$c"',
    'echo "gho_call_$n"',
    '',
  ].join('\n');

  /** A `gh` that fails once and would succeed from the second call on — stands in
   * for `gh auth login` happening while the process is running. */
  const GH_FAILS_THEN_SUCCEEDS = [
    SH.trimEnd(),
    'c="$(dirname "$0")/calls"',
    'n=$(( $(cat "$c" 2>/dev/null || echo 0) + 1 ))',
    'echo "$n" > "$c"',
    '[ "$n" = "1" ] && exit 1',
    'echo gho_after_login',
    '',
  ].join('\n');

  /** A `gh` that never returns — a wedged keychain prompt, a hung credential
   * helper. Sleeps far longer than the spawn is allowed to take. */
  const GH_HANGS = `${SH}sleep 30\n`;

  /** The failure as a caller sees it. `message` is non-enumerable on an Error, so
   * lift both facets onto a plain object and match them in one go. */
  function failureOf(fn: () => unknown): { status?: number; message: string } {
    try {
      fn();
    } catch (e) {
      return { status: (e as { status?: number }).status, message: (e as Error).message };
    }
    throw new Error('expected resolveSourceEnv to throw, but it returned a credential');
  }

  it('names GITHUB_TOKEN, as a 401, when neither it nor gh supplies a token', async () => {
    const resolveSourceEnv = await credentialEnv();
    expect(failureOf(() => resolveSourceEnv(GITHUB_SOURCE))).toMatchObject({
      status: 401,
      message: expect.stringContaining('GITHUB_TOKEN'),
    });
  });

  it('does not surface the raw gh exec failure in place of the missing credential', async () => {
    // The reported shape: with no `gh` in the image the caller got an ENOENT from
    // the middle of a tool call, which reads as the tool being broken rather than
    // as a credential nobody configured.
    const resolveSourceEnv = await credentialEnv();
    expect(failureOf(() => resolveSourceEnv(GITHUB_SOURCE)).message).not.toMatch(
      /ENOENT|spawn|Command failed/i
    );
  });

  it('leaves GITHUB_TOKEN unset in the host environment after failing', async () => {
    const resolveSourceEnv = await credentialEnv();
    expect(() => resolveSourceEnv(GITHUB_SOURCE)).toThrow();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('falls back to the gh CLI when GITHUB_TOKEN is unset', async () => {
    const resolveSourceEnv = await credentialEnv({ ghScript: GH_PRINTS_TOKEN });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ token: 'gho_from_gh_cli' });
  });

  it('does not write the gh-resolved token into the host environment', async () => {
    // The token belongs to the call. aigency-runtime's own GitHub client reads
    // process.env.GITHUB_TOKEN; a library rewriting it is a surprise even when the
    // value is good.
    const resolveSourceEnv = await credentialEnv({ ghScript: GH_PRINTS_TOKEN });
    resolveSourceEnv(GITHUB_SOURCE);
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('prefers an explicit GITHUB_TOKEN over the gh fallback', async () => {
    const resolveSourceEnv = await credentialEnv({
      ghScript: GH_PRINTS_TOKEN,
      githubToken: 'gho_explicit',
    });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ token: 'gho_explicit' });
  });

  it('treats a whitespace-only GITHUB_TOKEN as no credential, not as one', async () => {
    const resolveSourceEnv = await credentialEnv({ ghScript: GH_PRINTS_TOKEN, githubToken: '  ' });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ token: 'gho_from_gh_cli' });
  });

  it('forks into verevoir when SOURCE_FORK_ORG is unset', async () => {
    const resolveSourceEnv = await credentialEnv({ githubToken: 'gho_explicit' });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ forkOrg: 'verevoir' });
  });

  it('forks into SOURCE_FORK_ORG when it is set', async () => {
    const resolveSourceEnv = await credentialEnv({
      githubToken: 'gho_explicit',
      forkOrg: 'aigency-forks',
    });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ forkOrg: 'aigency-forks' });
  });

  it('carries the fork org over the gh fallback route too', async () => {
    // The two credential routes build the same env; the fork org must not depend on
    // which one supplied the token.
    const resolveSourceEnv = await credentialEnv({
      ghScript: GH_PRINTS_TOKEN,
      forkOrg: 'aigency-forks',
    });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({
      token: 'gho_from_gh_cli',
      forkOrg: 'aigency-forks',
    });
  });

  it('consults gh once per process, reusing the token it found', async () => {
    const resolveSourceEnv = await credentialEnv({ ghScript: GH_COUNTS_ITS_CALLS });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ token: 'gho_call_1' });
    expect(resolveSourceEnv(GITHUB_SOURCE)).toMatchObject({ token: 'gho_call_1' });
  });

  it('bounds a wedged gh instead of blocking the tool call on it', async () => {
    // execFileSync blocks the whole process, so an unbounded spawn does not just
    // stall this call — it stalls the server. Measured rather than left to the
    // runner's own timeout, which cannot interrupt a synchronous block.
    const resolveSourceEnv = await credentialEnv({ ghScript: GH_HANGS });
    const started = Date.now();
    failureOf(() => resolveSourceEnv(GITHUB_SOURCE));
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it('consults gh once per process even when it fails, keeping the spawn off the hot path', async () => {
    // resolveSourceEnv runs on every GitHub tool call. A gh that keeps failing must
    // not put a subprocess spawn on each of them — so the miss is remembered as
    // firmly as a hit, and a gh that would now succeed is not re-consulted.
    const resolveSourceEnv = await credentialEnv({ ghScript: GH_FAILS_THEN_SUCCEEDS });
    expect(() => resolveSourceEnv(GITHUB_SOURCE)).toThrow(/GITHUB_TOKEN/);
    expect(() => resolveSourceEnv(GITHUB_SOURCE)).toThrow(/GITHUB_TOKEN/);
  });
});

describe('resolveWorkflowEnv', () => {
  it('returns { token: "" } for an absolute path (Obsidian Kanban board)', () => {
    const env = resolveWorkflowEnv('/abs/path/Board.md');
    expect(env).toEqual({ token: '' });
  });

  it('returns { token: "" } for a file:// board URL (Obsidian Kanban board)', () => {
    const env = resolveWorkflowEnv('file:///abs/path/Board.md');
    expect(env).toEqual({ token: '' });
  });

  it('returns { token: "" } for a Backlog.md project directory', () => {
    const env = resolveWorkflowEnv('/abs/path/project');
    expect(env).toEqual({ token: '' });
  });
});
