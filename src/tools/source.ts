import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { grepSource, warmSource, wrapWithCache } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import { applyEdit } from '../edit.js';
import { invalidateWrittenFile } from '../cache.js';
import { queryCodeGraph } from '../graph.js';
import { jsonText } from '../result.js';
import { fileURLToPath } from 'node:url';

// A `file://` URL and the bare absolute path it denotes must resolve to the
// SAME cache key, or warm-then-query mismatches (find_symbol / code_graph warm
// under one form and query under the other → 0 hits). Normalise `file://` to
// the bare path so both halves agree. GitHub / Notion URLs pass through.
export function normalizeSourceUrl(sourceUrl: string): string {
  return sourceUrl.startsWith('file://') ? fileURLToPath(sourceUrl) : sourceUrl;
}

// `branch` + `commitMessage` are needed only for GitHub commits; filesystem and
// Notion writes ignore them. Validate that here so the tool schemas can mark
// them OPTIONAL (required-but-ignored was a smell), and coerce to strings for
// the adapter call. A GitHub source still gets a clear error if they're missing.
export function commitArgs(
  sourceUrl: string,
  branch?: string,
  commitMessage?: string
): { branch: string; commitMessage: string } {
  const isGitHub = /^https?:\/\/(www\.)?github\.com\//i.test(sourceUrl);
  if (isGitHub && (!branch || !commitMessage)) {
    throw new Error('branch and commitMessage are required when writing to a GitHub source.');
  }
  return { branch: branch ?? '', commitMessage: commitMessage ?? '' };
}

// The owner segment of a GitHub repo URL — used to build a cross-repo PR head
// (`<owner>:<branch>`) from the working fork's URL, so a caller never hand-builds
// the head string.
export function ghOwner(repoUrl: string): string {
  const m = repoUrl.replace(/\.git$/, '').match(/github\.com[/:]([^/]+)\/[^/]+/i);
  if (!m) throw new Error(`Not a GitHub repo URL: ${repoUrl}`);
  return m[1];
}

export function registerSourceTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'read_file',
    {
      description:
        "Read a file's full contents from any source — a local repo (absolute path), a GitHub repo, or Notion. Prefer this over the built-in file Read for project/repo files: reads are cached per (sourceUrl, ref, path) and the cache is shared with grep/find_symbol, so reading also warms the index for later search. Returns { content, sha }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        ref: z.string().optional().describe('Git ref / branch / sha. Omit for default branch.'),
      },
    },
    async ({ sourceUrl, path, ref }) => {
      const adapter = wrapWithCache(await pickSourceAdapter(sourceUrl));
      const env = resolveSourceEnv(sourceUrl);
      const result = await adapter.readFile(env, sourceUrl, path, ref);
      return { content: [{ type: 'text', text: jsonText(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // list_files
  // -------------------------------------------------------------------------
  server.registerTool(
    'list_files',
    {
      description:
        'List directory entries at a path prefix within a source (local path, GitHub repo, or Notion page tree). Use it to orient before reading; prefer over shell ls/find for project files. Returns DirEntry[] (name, type, path, sha).',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        prefix: z.string().optional().describe("Directory prefix to list. Defaults to root ('')."),
        ref: z.string().optional().describe('Git ref / branch / sha. Omit for default branch.'),
      },
    },
    async ({ sourceUrl, prefix, ref }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await adapter.listFiles(env, sourceUrl, prefix ?? '', ref);
      return { content: [{ type: 'text', text: jsonText(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // get_repo_tree
  // -------------------------------------------------------------------------
  server.registerTool(
    'get_repo_tree',
    {
      description:
        'Fetch the full file tree for a source (local path, GitHub repo, or Notion page tree) in one call — the fastest way to orient in an unfamiliar repo. May be large for big repos; use list_files for narrower scopes. Returns RepoTree with entries[] and a truncated flag.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        ref: z.string().optional().describe('Git ref / branch / sha. Omit for default branch.'),
      },
    },
    async ({ sourceUrl, ref }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await adapter.getRepoTree(env, sourceUrl, ref);
      return { content: [{ type: 'text', text: jsonText(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // grep
  // -------------------------------------------------------------------------
  server.registerTool(
    'grep',
    {
      description:
        'Search file contents for a pattern across an entire source on demand. Scans the whole tree (skipping vendored / build dirs), pulling files into the shared cache as it goes — no need to read files first. Prefer over shell grep for project files. Returns GrepHit[] with line + context.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        pattern: z.string().describe('Plain-text substring to search for.'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
        ignoreCase: z.boolean().optional().describe('Case-insensitive match. Defaults to false.'),
        maxResults: z.number().optional().describe('Maximum hits to return. Defaults to 50.'),
      },
    },
    async ({ sourceUrl, pattern, ref, ignoreCase, maxResults }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const result = await grepSource(adapter, env, sourceUrl, pattern, {
        ref,
        ignoreCase,
        maxResults,
      });
      return { content: [{ type: 'text', text: jsonText(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // find_symbol
  // -------------------------------------------------------------------------
  server.registerTool(
    'find_symbol',
    {
      description:
        'Find where a named function, class, method, interface, type, or enum is defined — scans the whole source on demand, tree-sitter-parsing files into the shared cache as it goes (no need to read files first). Prefer over guessing or shell-grepping for definitions. Returns SymbolHit[] with file path and line range.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        name: z.string().describe('Symbol name to search (substring match, case-insensitive).'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
        kind: z
          .enum(['function', 'class', 'method', 'interface', 'type', 'enum'])
          .optional()
          .describe('Restrict results to a specific symbol kind.'),
      },
    },
    async ({ sourceUrl, name, ref, kind }) => {
      const src = normalizeSourceUrl(sourceUrl);
      const adapter = await pickSourceAdapter(src);
      const env = resolveSourceEnv(src);
      await warmSource(adapter, env, src, { ref });
      const hits = findSymbols(name, {
        sources: [{ sourceId: src, version: ref ?? '' }],
      });
      const filtered = kind ? hits.filter((h) => h.kind === kind) : hits;
      return {
        content: [{ type: 'text', text: jsonText(filtered) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // write_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'write_file',
    {
      description:
        "Write a file's full contents to a source. Always prefer this (and edit_file) over the built-in Write or shell redirection for a covered path: it commits the change AND drops the file from the shared read cache so the next grep/find_symbol re-fetches — a write that bypasses the MCP leaves that cache stale and wrong for the rest of the session. GitHub sources commit to the given branch via the contents API (branch + commitMessage required there); filesystem + Notion sources write directly with no git staging, so omit branch + commitMessage. Returns { ok: true }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        content: z.string().describe('Full file content to write.'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub sources; omit for filesystem + Notion (ignored).'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub sources; omit for filesystem + Notion (ignored).'
          ),
      },
    },
    async ({ sourceUrl, path, content, branch, commitMessage }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      await adapter.writeFile(env, sourceUrl, path, content, commit.branch, commit.commitMessage);
      invalidateWrittenFile(sourceUrl, path, commit.branch);
      return { content: [{ type: 'text', text: jsonText({ ok: true }) }] };
    }
  );

  // -------------------------------------------------------------------------
  // edit_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'edit_file',
    {
      description:
        'Surgically edit a file in any source: replace an exact `oldString` with `newString`. Prefer this over the built-in Edit for a covered path — like write_file it invalidates the shared read cache after writing (a bypassing edit leaves grep/find_symbol serving stale, pre-edit content), and it keeps the whole read->edit->write cycle in-toolchain across local, GitHub, and Notion sources. `oldString` must match exactly once unless `replaceAll` is set — include enough surrounding context to make it unique. GitHub commits to `branch` (branch + commitMessage required there); filesystem + Notion write directly, so omit branch + commitMessage. Returns { ok: true, replacements }.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        oldString: z
          .string()
          .describe('Exact text to replace. Must match exactly once unless replaceAll is true.'),
        newString: z.string().describe('Replacement text.'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub sources; omit for filesystem + Notion (ignored).'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub sources; omit for filesystem + Notion (ignored).'
          ),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
      },
    },
    async ({ sourceUrl, path, oldString, newString, branch, commitMessage, replaceAll }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      const { content } = await adapter.readFile(env, sourceUrl, path, commit.branch || undefined);
      const result = applyEdit(content, oldString, newString, replaceAll ?? false);
      await adapter.writeFile(
        env,
        sourceUrl,
        path,
        result.content,
        commit.branch,
        commit.commitMessage
      );
      invalidateWrittenFile(sourceUrl, path, commit.branch);
      return {
        content: [
          { type: 'text', text: jsonText({ ok: true, replacements: result.replacements }) },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // ensure_fork / ensure_branch / open_pull_request — the fork-isolated write
  // flow. A repo is addressed by its **source URL** (its identity, and the PR
  // target). Once forked, the fork is the **working URL** — the workspace we
  // actually read, write, branch, and commit on. The source repo is never
  // written directly; it only ever receives a pull request from the fork. So an
  // agent can change a repo it does NOT own hermetically. GitHub only (forks /
  // PRs are a GitHub concept).
  // -------------------------------------------------------------------------
  server.registerTool(
    'ensure_fork',
    {
      description:
        "Fork a GitHub repo into the configured fork org and return the **working URL** — the fork that becomes your workspace for this repo. Idempotent: returns the existing fork if one is already there. The repo's source URL stays its identity and the eventual pull-request target; everything you actually do — read, write, branch, commit — happens on the working URL, so a repo you do NOT own is never written directly. GitHub only. Returns { workingUrl }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('The GitHub repo URL to fork — the source/identity of the repo.'),
      },
    },
    async ({ sourceUrl }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      const workingUrl = await adapter.ensureFork(env, sourceUrl);
      return { content: [{ type: 'text', text: jsonText({ workingUrl }) }] };
    }
  );

  server.registerTool(
    'ensure_branch',
    {
      description:
        'Ensure a branch exists on a GitHub repo — created off the default branch if missing, a no-op if it already exists. Pass the **working URL** (the fork from ensure_fork) — that is what you branch and commit on. GitHub only. Returns { ok: true, branch }.',
      inputSchema: {
        workingUrl: z
          .string()
          .describe('The working URL (the fork) to create the branch on — from ensure_fork.'),
        branch: z.string().describe('Branch name to ensure exists.'),
      },
    },
    async ({ workingUrl, branch }) => {
      const adapter = await pickSourceAdapter(workingUrl);
      const env = resolveSourceEnv(workingUrl);
      await adapter.ensureBranch(env, workingUrl, branch);
      return { content: [{ type: 'text', text: jsonText({ ok: true, branch }) }] };
    }
  );

  server.registerTool(
    'open_pull_request',
    {
      description:
        "Open a pull request on a GitHub repo and return its URL. Addressed by the repo's **source URL** (the PR target); the change lives on a `branch` on the **working URL** (the fork). The cross-repo head (`<fork-owner>:<branch>`) is built for you from the working URL, so you never hand-build it. For a same-repo change (you own the repo), pass the same URL for both source and working. GitHub only. Returns { prUrl }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe('The repo the PR is opened against — its source URL (the target).'),
        workingUrl: z
          .string()
          .describe('The working URL (the fork) the branch lives on — from ensure_fork.'),
        branch: z.string().describe('The branch on the working URL that carries the change.'),
        base: z.string().describe('The branch on the target to merge into (e.g. main).'),
        title: z.string().describe('PR title.'),
        body: z.string().describe('PR description (Markdown).'),
      },
    },
    async ({ sourceUrl, workingUrl, branch, base, title, body }) => {
      const adapter = await pickSourceAdapter(sourceUrl);
      const env = resolveSourceEnv(sourceUrl);
      // Same repo for source + working → a same-repo PR (head is just the
      // branch); a real fork → a cross-repo head `<fork-owner>:<branch>`.
      const head = workingUrl === sourceUrl ? branch : `${ghOwner(workingUrl)}:${branch}`;
      const prUrl = await adapter.openPullRequest(env, sourceUrl, head, base, title, body);
      return { content: [{ type: 'text', text: jsonText({ prUrl }) }] };
    }
  );

  // -------------------------------------------------------------------------
  // code_graph
  // -------------------------------------------------------------------------
  server.registerTool(
    'code_graph',
    {
      description:
        "Return a symbol's neighbourhood in the code graph: where it's defined, what calls it, what it calls (resolved to symbols defined in this source), and which files import it — the relationships you can't get by reading a single file. Use it for 'who uses X' / 'what does X depend on' / 'what would changing X affect' without reading the tree. Approximate: edges are name-based (no type resolution), so a common name may have several definitions.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), or Notion (https://www.notion.so/<id>).'
          ),
        symbol: z.string().describe('Symbol name to look up in the code graph.'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
      },
    },
    async ({ sourceUrl, symbol, ref }) => {
      const src = normalizeSourceUrl(sourceUrl);
      const adapter = await pickSourceAdapter(src);
      const env = resolveSourceEnv(src);
      await warmSource(adapter, env, src, { ref });
      const text = queryCodeGraph(src, ref ?? '', symbol);
      return { content: [{ type: 'text', text }] };
    }
  );
}
