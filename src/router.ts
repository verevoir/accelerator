import type { SourceAdapter } from '@verevoir/sources';
import type { WorkflowAdapter, WorkflowEnv } from '@verevoir/workflows';
import { execFileSync } from 'node:child_process';
import { envFromTrelloProcessEnv } from '@verevoir/workflows/trello';
import { envFromNotionProcessEnv } from '@verevoir/workflows/notion';
import { envFromObsidianProcessEnv, parseObsidianBoardPath } from '@verevoir/workflows/obsidian';
import { envFromBacklogProcessEnv, parseBacklogBoardPath } from '@verevoir/workflows/backlog';
import { wrapWorkflowWithCache } from '@verevoir/context';

// ---------------------------------------------------------------------------
// Source adapter routing
// ---------------------------------------------------------------------------

type SourceKind = 'github' | 'fs' | 'notion';

function classifySourceUrl(sourceUrl: string): SourceKind {
  if (/^https?:\/\/(www\.)?github\.com\//.test(sourceUrl)) return 'github';
  if (/^https?:\/\/(www\.)?notion\.so\//.test(sourceUrl)) return 'notion';
  if (
    sourceUrl.startsWith('/') ||
    sourceUrl.startsWith('~/') ||
    sourceUrl.startsWith('./') ||
    sourceUrl.startsWith('file://')
  )
    return 'fs';
  throw new Error(
    `Unsupported source URL: ${sourceUrl}. Expected github.com URL, notion.so URL, or absolute filesystem path.`
  );
}

/** Dynamically import and return the cached SourceAdapter for the given URL. */
export async function pickSourceAdapter(sourceUrl: string): Promise<SourceAdapter> {
  const kind = classifySourceUrl(sourceUrl);
  if (kind === 'github') {
    const { github } = await import('@verevoir/context/github');
    return github;
  }
  if (kind === 'notion') {
    const { notion } = await import('@verevoir/context/notion');
    return notion;
  }
  const { fs } = await import('@verevoir/context/fs');
  return fs;
}

/** Milliseconds a `gh auth token` spawn may take before it is killed. `gh` is a
 * local process reading a config file or a keychain; anything past this is
 * wedged, and every GitHub tool call waits behind it. */
const GH_CLI_TIMEOUT_MS = 5_000;

/** `undefined` until the `gh` route has been tried; the outcome — token or
 * `null` for a miss — afterwards. */
let ghCliToken: string | null | undefined;
/** Local-dev fallback for the GitHub credential: borrow the `gh` CLI's auth
 * token so a developer already logged into `gh` can read their private repos
 * without configuring anything. Returns null — never throws — when `gh` is
 * absent or unauthenticated, which is every deployment without the CLI (the
 * runtime container image has no `gh`), so the caller can name the credential
 * that is actually missing instead of surfacing an ENOENT.
 *
 * Tried at most once per process, and the miss is remembered as firmly as the
 * hit: `resolveSourceEnv` runs on every GitHub tool call, so a `gh` that keeps
 * failing would otherwise put a subprocess spawn on a hot path indefinitely.
 * The spawn is timeout-bounded for the same reason. */
function githubTokenFromGhCli(): string | null {
  if (ghCliToken !== undefined) return ghCliToken;
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GH_CLI_TIMEOUT_MS,
    }).trim();
    return (ghCliToken = token || null);
  } catch {
    return (ghCliToken = null);
  }
}

/** GitHub credential, resolved into a returned value: `GITHUB_TOKEN` first,
 * then the `gh` CLI fallback. Deliberately never assigns to `process.env` — the
 * token belongs to this call, and the host process reads the same variable for
 * its own GitHub client. Building the env here (rather than via
 * `envFromProcessEnv`) keeps one source of truth for the fork org across both
 * routes. */
function resolveGithubSourceEnv(): { token: string; forkOrg: string } {
  const token = process.env.GITHUB_TOKEN?.trim() || githubTokenFromGhCli();
  if (!token) {
    throw Object.assign(
      new Error(
        'GITHUB_TOKEN not set — set it to a GitHub token with access to this source. ' +
          'The `gh auth token` fallback is a local-dev convenience and yielded nothing ' +
          'here (`gh` is absent or not authenticated).'
      ),
      { status: 401 }
    );
  }
  return { token, forkOrg: process.env.SOURCE_FORK_ORG?.trim() || 'verevoir' };
}

/** Resolve the SourceEnv appropriate for the given URL. GitHub
 * sources require `GITHUB_TOKEN` (or the `gh` CLI's auth); Notion sources
 * require `NOTION_API_KEY`; filesystem sources need no token. */
export function resolveSourceEnv(sourceUrl: string): {
  token: string;
  forkOrg: string;
} {
  const kind = classifySourceUrl(sourceUrl);
  if (kind === 'github') return resolveGithubSourceEnv();
  if (kind === 'notion') {
    const token = process.env.NOTION_API_KEY;
    if (!token) throw Object.assign(new Error('NOTION_API_KEY not set'), { status: 401 });
    return { token, forkOrg: '' };
  }
  // Filesystem adapter ignores token + forkOrg.
  return { token: '', forkOrg: '' };
}

// ---------------------------------------------------------------------------
// Workflow adapter routing
// ---------------------------------------------------------------------------

/** Dynamically import and return the **cached** WorkflowAdapter for the given
 * board URL. `wrapWorkflowWithCache` (default ~10s TTL, shared in-process
 * store) gives the list/get reads read-through caching with cheap
 * `isCardFresh` revalidation — the workflow twin of the cached source
 * subpaths. Collapses correlated re-reads within a process; writes pass
 * through and invalidate. */
export async function pickWorkflowAdapter(boardUrl: string): Promise<WorkflowAdapter> {
  if (/^https:\/\/trello\.com\/b\/[^/]+/.test(boardUrl)) {
    const { trello } = await import('@verevoir/workflows/trello');
    return wrapWorkflowWithCache(trello);
  }
  if (/^https?:\/\/(www\.)?notion\.so\//.test(boardUrl)) {
    const { notion } = await import('@verevoir/workflows/notion');
    return wrapWorkflowWithCache(notion);
  }
  // Backlog before Obsidian: both take local paths, but a Backlog project is a
  // directory (parseBacklogBoardPath rejects a `.md` path) while an Obsidian
  // board is a `.md` file — so checking Backlog first leaves `.md` paths to
  // Obsidian and routes directories to Backlog.
  if (parseBacklogBoardPath(boardUrl) !== null) {
    const { backlog } = await import('@verevoir/workflows/backlog');
    return wrapWorkflowWithCache(backlog);
  }
  if (parseObsidianBoardPath(boardUrl) !== null) {
    const { obsidian } = await import('@verevoir/workflows/obsidian');
    return wrapWorkflowWithCache(obsidian);
  }
  // Future: Jira, Linear adapters would slot in here.
  throw new Error(
    `Unsupported board URL: ${boardUrl}. Expected https://trello.com/b/<id>, https://www.notion.so/<db-id>, an absolute path / file:// URL to an Obsidian Kanban board .md, or a path to a Backlog.md project directory.`
  );
}

/** Build WorkflowEnv for the given board URL. Trello requires
 * `TRELLO_API_KEY` + `TRELLO_API_TOKEN` + `TRELLO_REFERER`; Notion
 * requires `NOTION_API_KEY`. */
export function resolveWorkflowEnv(boardUrl: string): WorkflowEnv {
  if (/^https:\/\/trello\.com\/b\/[^/]+/.test(boardUrl)) {
    const env = envFromTrelloProcessEnv();
    if (!env) {
      const missing = !process.env.TRELLO_API_KEY
        ? 'TRELLO_API_KEY'
        : !process.env.TRELLO_API_TOKEN
          ? 'TRELLO_API_TOKEN'
          : 'TRELLO_API_KEY or TRELLO_API_TOKEN';
      throw new Error(`${missing} not set — required for Trello boards.`);
    }
    if (!env.referer && !process.env.TRELLO_REFERER) {
      throw new Error('TRELLO_REFERER not set — required for Trello Power-Up origin matching.');
    }
    return env;
  }
  if (/^https?:\/\/(www\.)?notion\.so\//.test(boardUrl)) {
    const env = envFromNotionProcessEnv();
    if (!env) throw new Error('NOTION_API_KEY not set — required for Notion databases.');
    return env;
  }
  // Backlog before Obsidian — see pickWorkflowAdapter for the directory-vs-.md split.
  if (parseBacklogBoardPath(boardUrl) !== null) {
    return envFromBacklogProcessEnv();
  }
  if (parseObsidianBoardPath(boardUrl) !== null) {
    return envFromObsidianProcessEnv();
  }
  throw new Error(
    `Unsupported board URL: ${boardUrl}. Expected https://trello.com/b/<id>, https://www.notion.so/<db-id>, an absolute path / file:// URL to an Obsidian Kanban board .md, or a path to a Backlog.md project directory.`
  );
}
