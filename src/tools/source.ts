import { z } from 'zod';
import type { ToolHost } from '../permissions.js';
import { grepSource, warmSource, wrapWithCache } from '@verevoir/context';
import { findSymbols } from '@verevoir/context/code';
import { pickSourceAdapter, resolveSourceEnv } from '../router.js';
import {
  writeSourceFile,
  editSourceFile,
  multiEditSourceFile,
  insertSourceFile,
  deleteBlockSourceFile,
  commitFilesSource,
} from '../mutate.js';
import { queryCodeGraph, queryMultiSourceCodeGraph } from '../graph.js';
import { resolveSourceUrls, type SourceSelection } from '../source-selection.js';
import { jsonText } from '../result.js';
import { fileURLToPath } from 'node:url';
import { isGitlabUrl, parseGitlabProjectUrl } from '@verevoir/sources/gitlab';

// A `file://` URL and the bare absolute path it denotes must resolve to the
// SAME cache key, or warm-then-query mismatches (find_symbol / code_graph warm
// under one form and query under the other → 0 hits). Normalise `file://` to
// the bare path so both halves agree. GitHub / Notion URLs pass through.
export function normalizeSourceUrl(sourceUrl: string): string {
  return sourceUrl.startsWith('file://') ? fileURLToPath(sourceUrl) : sourceUrl;
}

// `branch` + `commitMessage` are needed only for GitHub / GitLab commits;
// filesystem and Notion writes ignore them. Validate that here so the tool
// schemas can mark them OPTIONAL (required-but-ignored was a smell), and coerce
// to strings for the adapter call. A git-host source still gets a clear error if
// they're missing.
export function commitArgs(
  sourceUrl: string,
  branch?: string,
  commitMessage?: string
): { branch: string; commitMessage: string } {
  const isGitHub = /^https?:\/\/(www\.)?github\.com\//i.test(sourceUrl);
  if (isGitHub && (!branch || !commitMessage)) {
    throw new Error('branch and commitMessage are required when writing to a GitHub source.');
  }
  if (isGitlabUrl(sourceUrl) && (!branch || !commitMessage)) {
    throw new Error('branch and commitMessage are required when writing to a GitLab source.');
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

// The cross-repo head for a PR/MR from a fork. GitHub wants `<owner>:<branch>`;
// GitLab needs the fork's full project path (namespaces nest, so the owner alone
// cannot identify it) — the adapter splits `<project path>:<branch>` back apart.
// A GitLab MR is resolved against the target's instance, so a fork on another
// instance (or a GitHub fork of a GitLab project) is refused, not mis-resolved.
export function forkHead(sourceUrl: string, workingUrl: string, branch: string): string {
  if (isGitlabUrl(sourceUrl) || isGitlabUrl(workingUrl)) {
    const source = isGitlabUrl(sourceUrl) ? parseGitlabProjectUrl(sourceUrl).apiBase : sourceUrl;
    const working = isGitlabUrl(workingUrl) ? parseGitlabProjectUrl(workingUrl) : undefined;
    if (!working || working.apiBase !== source) {
      throw new Error(
        `The working URL (${workingUrl}) must be a fork on the same GitLab instance as the source (${sourceUrl}).`
      );
    }
    return `${working.projectPath}:${branch}`;
  }
  return `${ghOwner(workingUrl)}:${branch}`;
}

const sourceSelectionSchema = {
  sourceUrl: z
    .string()
    .min(1)
    .optional()
    .describe(
      'One local path, file URL, GitHub/GitLab repo, or Notion source. Provide this or sourceUrls.'
    ),
  sourceUrls: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Sources to search together, in order. Each retains its own cache and tree budget. Provide this or sourceUrl.'
    ),
};

async function inSource<T>(sourceUrl: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    throw new Error(
      `Source ${sourceUrl} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}

async function selectedSources(selection: SourceSelection): Promise<string[]> {
  const sources: string[] = [];
  for (const sourceUrl of resolveSourceUrls(selection)) {
    sources.push(await inSource(sourceUrl, async () => normalizeSourceUrl(sourceUrl)));
  }
  return [...new Set(sources)];
}

async function warmSelectedSources(sources: string[], ref?: string): Promise<void> {
  for (const sourceUrl of sources) {
    await inSource(sourceUrl, async () => {
      const adapter = await pickSourceAdapter(sourceUrl);
      await warmSource(adapter, resolveSourceEnv(sourceUrl), sourceUrl, { ref });
    });
  }
}

export function registerSourceTools(server: ToolHost): void {
  // -------------------------------------------------------------------------
  // read_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'read_file',
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "Read a file's full contents from any source — a local repo (absolute path), a GitHub repo, a GitLab project, or Notion. Prefer this over the built-in file Read for project/repo files: reads are cached per (sourceUrl, ref, path) and the cache is shared with grep/find_symbol, so reading also warms the index for later search. Returns { content, sha }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
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
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'List directory entries at a path prefix within a source (local path, GitHub repo, GitLab project, or Notion page tree). Use it to orient before reading; prefer over shell ls/find for project files. Returns DirEntry[] (name, type, path, sha).',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
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
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Fetch the full file tree for a source (local path, GitHub repo, GitLab project, or Notion page tree) in one call — the fastest way to orient in an unfamiliar repo. May be large for big repos; use list_files for narrower scopes. Returns RepoTree with entries[] and a truncated flag.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
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
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Search file contents for a pattern across one or more sources on demand. Results include sourceId. Scans the whole tree (skipping vendored / build dirs), pulling files into the shared cache as it goes — no need to read files first. Prefer over shell grep for project files. Returns GrepHit[] with line + context.',
      inputSchema: {
        ...sourceSelectionSchema,
        pattern: z.string().describe('Plain-text substring to search for.'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
        ignoreCase: z.boolean().optional().describe('Case-insensitive match. Defaults to false.'),
        maxResults: z
          .number()
          .optional()
          .describe('Maximum total hits across sources, in source order. Defaults to 50.'),
      },
    },
    async ({ sourceUrl, sourceUrls, pattern, ref, ignoreCase, maxResults }) => {
      const sources = await selectedSources({ sourceUrl, sourceUrls });
      const limit = maxResults ?? 50;
      const result: Awaited<ReturnType<typeof grepSource>> = [];
      for (const src of sources) {
        if (result.length >= limit) break;
        const hits = await inSource(src, async () => {
          const adapter = await pickSourceAdapter(src);
          return grepSource(adapter, resolveSourceEnv(src), src, pattern, {
            ref,
            ignoreCase,
            maxResults: limit - result.length,
          });
        });
        for (const hit of hits) result.push(hit);
      }
      return { content: [{ type: 'text', text: jsonText(result) }] };
    }
  );

  // -------------------------------------------------------------------------
  // find_symbol
  // -------------------------------------------------------------------------
  server.registerTool(
    'find_symbol',
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Find where a named function, class, method, interface, type, or enum is defined — scans each selected source on demand; results include sourceId, tree-sitter-parsing files into the shared cache as it goes (no need to read files first). Prefer over guessing or shell-grepping for definitions. Returns SymbolHit[] with file path and line range.',
      inputSchema: {
        ...sourceSelectionSchema,
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
    async ({ sourceUrl, sourceUrls, name, ref, kind }) => {
      const sources = await selectedSources({ sourceUrl, sourceUrls });
      await warmSelectedSources(sources, ref);
      const hits = findSymbols(name, {
        sources: sources.map((sourceId) => ({ sourceId, version: ref ?? '' })),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      description:
        "Write a file's full contents to a source. Always prefer this (and edit_file) over the built-in Write or shell redirection for a covered path: it commits the change AND drops the file from the shared read cache so the next grep/find_symbol re-fetches — a write that bypasses the MCP leaves that cache stale and wrong for the rest of the session. GitHub + GitLab sources commit to the given branch (branch + commitMessage required there); filesystem + Notion sources write directly with no git staging, so omit branch + commitMessage. Returns { ok: true }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        content: z.string().describe('Full file content to write.'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub + GitLab sources; omit for filesystem + Notion (ignored).'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub + GitLab sources; omit for filesystem + Notion (ignored).'
          ),
      },
    },
    async ({ sourceUrl, path, content, branch, commitMessage }) => {
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      await writeSourceFile(sourceUrl, path, content, commit.branch, commit.commitMessage);
      return { content: [{ type: 'text', text: jsonText({ ok: true }) }] };
    }
  );

  // -------------------------------------------------------------------------
  // edit_file
  // -------------------------------------------------------------------------
  server.registerTool(
    'edit_file',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        'Surgically edit a file in any source: replace an exact `oldString` with `newString`. Prefer this over the built-in Edit for a covered path — like write_file it invalidates the shared read cache after writing (a bypassing edit leaves grep/find_symbol serving stale, pre-edit content), and it keeps the whole read->edit->write cycle in-toolchain across local, GitHub, GitLab, and Notion sources. `oldString` must match exactly once unless `replaceAll` is set — include enough surrounding context to make it unique. GitHub + GitLab commit to `branch` (branch + commitMessage required there); filesystem + Notion write directly, so omit branch + commitMessage. Returns { ok: true, replacements }.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
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
            'Branch to commit to. Required for GitHub + GitLab sources; omit for filesystem + Notion (ignored).'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub + GitLab sources; omit for filesystem + Notion (ignored).'
          ),
        replaceAll: z
          .boolean()
          .optional()
          .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
      },
    },
    async ({ sourceUrl, path, oldString, newString, branch, commitMessage, replaceAll }) => {
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      const result = await editSourceFile(
        sourceUrl,
        path,
        oldString,
        newString,
        replaceAll ?? false,
        commit.branch,
        commit.commitMessage
      );
      return {
        content: [
          { type: 'text', text: jsonText({ ok: true, replacements: result.replacements }) },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // multi_edit
  // -------------------------------------------------------------------------
  server.registerTool(
    'multi_edit',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        'Apply a LIST of exact-string edits to one file ATOMICALLY: all land or none do (if any oldString is absent or non-unique, the whole call throws and nothing is written). Prefer this over several edit_file calls when a file needs multiple changes — one read/write, no half-applied state. Each edit is an { oldString, newString, replaceAll? } (oldString unique unless replaceAll). GitHub + GitLab commit to `branch` (branch + commitMessage required there); filesystem + Notion write directly. Returns { ok: true, replacements } — the total across all edits.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        edits: z
          .array(
            z.object({
              oldString: z
                .string()
                .describe('Exact text to replace. Unique unless replaceAll is true.'),
              newString: z.string().describe('Replacement text.'),
              replaceAll: z
                .boolean()
                .optional()
                .describe('Replace every occurrence of this edit (default false).'),
            })
          )
          .min(1, 'multi_edit requires at least one edit')
          .describe('The edits to apply in order, atomically.'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub + GitLab sources; omit for filesystem + Notion (ignored).'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub + GitLab sources; omit for filesystem + Notion (ignored).'
          ),
      },
    },
    async ({ sourceUrl, path, edits, branch, commitMessage }) => {
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      const result = await multiEditSourceFile(
        sourceUrl,
        path,
        edits,
        commit.branch,
        commit.commitMessage
      );
      return {
        content: [
          { type: 'text', text: jsonText({ ok: true, replacements: result.replacements }) },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // insert
  // -------------------------------------------------------------------------
  server.registerTool(
    'insert',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        'Insert `text` immediately before or after the UNIQUE occurrence of `anchor` in a file — an anchored insert with no surrounding rewrite. Throws if `anchor` or `text` is empty, or `anchor` is absent or matches more than once (add context to make it unique). GitHub + GitLab commit to `branch` (branch + commitMessage required there); filesystem + Notion write directly. Returns { ok: true, replacements }.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        anchor: z.string().describe('Unique text to anchor the insert to.'),
        text: z.string().describe('Text to insert.'),
        position: z.enum(['before', 'after']).describe('Insert before or after the anchor.'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub + GitLab sources; omit for filesystem + Notion.'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub + GitLab sources; omit for filesystem + Notion.'
          ),
      },
    },
    async ({ sourceUrl, path, anchor, text, position, branch, commitMessage }) => {
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      const result = await insertSourceFile(
        sourceUrl,
        path,
        anchor,
        text,
        position,
        commit.branch,
        commit.commitMessage
      );
      return {
        content: [
          { type: 'text', text: jsonText({ ok: true, replacements: result.replacements }) },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // delete_block
  // -------------------------------------------------------------------------
  server.registerTool(
    'delete_block',
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        'Remove the UNIQUE occurrence of `block` from a file. Throws if `block` is empty, absent, or matches more than once (add surrounding context to make it unique). GitHub + GitLab commit to `branch` (branch + commitMessage required there); filesystem + Notion write directly. Returns { ok: true, replacements }.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
          ),
        path: z.string().describe('File path within the source.'),
        block: z.string().describe('The exact block to remove (must be unique in the file).'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub + GitLab sources; omit for filesystem + Notion.'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub + GitLab sources; omit for filesystem + Notion.'
          ),
      },
    },
    async ({ sourceUrl, path, block, branch, commitMessage }) => {
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      const result = await deleteBlockSourceFile(
        sourceUrl,
        path,
        block,
        commit.branch,
        commit.commitMessage
      );
      return {
        content: [
          { type: 'text', text: jsonText({ ok: true, replacements: result.replacements }) },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // commit_files
  // -------------------------------------------------------------------------
  server.registerTool(
    'commit_files',
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
      description:
        'Commit MULTIPLE files together on `branch` in ONE operation — the multi-file twin of write_file. Prefer this over several write_file calls when a change spans files: on GitHub it is a single ATOMIC commit (blobs → tree → commit → ref move; the ref advances only after every step succeeds, so a failure leaves no partial state) instead of N separate commits; on GitLab it is likewise ONE atomic commit (the commits API applies every file action or none); on a local git repo it writes the files then stages + commits them (best-effort — a git failure throws but the already-written files are NOT rolled back, so inspect the working tree on error); on Notion it degrades to sequential writes. Like the other writers it drops each written file from the shared read cache. `files` must be non-empty. GitHub + GitLab require `branch` + `commitMessage`; a local git repo uses `branch` to create/advance; a non-git path or Notion writes directly. Returns { ok: true, files } — the count committed.',
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'Source, auto-routed by form: local path (/abs/path or file://...), GitHub repo (https://github.com/owner/repo), GitLab project (https://gitlab.com/group/project, or a self-hosted host), or Notion (https://www.notion.so/<id>).'
          ),
        files: z
          .array(
            z.object({
              path: z.string().describe('File path within the source.'),
              content: z.string().describe('Full file content to write.'),
            })
          )
          .min(1, 'commit_files requires at least one file')
          .describe('The files to commit together, atomically.'),
        branch: z
          .string()
          .optional()
          .describe(
            'Branch to commit to. Required for GitHub + GitLab sources; used by a local git repo to create/advance the branch; ignored for Notion + non-git paths.'
          ),
        commitMessage: z
          .string()
          .optional()
          .describe(
            'Commit message. Required for GitHub + GitLab sources; used by a local git repo; ignored for Notion + non-git paths.'
          ),
      },
    },
    async ({ sourceUrl, files, branch, commitMessage }) => {
      const commit = commitArgs(sourceUrl, branch, commitMessage);
      await commitFilesSource(sourceUrl, commit.branch, files, commit.commitMessage);
      return {
        content: [{ type: 'text', text: jsonText({ ok: true, files: files.length }) }],
      };
    }
  );

  // -------------------------------------------------------------------------
  // ensure_fork / ensure_branch / open_pull_request — the fork-isolated write
  // flow. A repo is addressed by its **source URL** (its identity, and the PR
  // target). Once forked, the fork is the **working URL** — the workspace we
  // actually read, write, branch, and commit on. The source repo is never
  // written directly; it only ever receives a pull request from the fork. So an
  // agent can change a repo it does NOT own hermetically. GitHub (forks /
  // PRs) and GitLab (forks / merge requests).
  // -------------------------------------------------------------------------
  server.registerTool(
    'ensure_fork',
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Fork a GitHub repo or GitLab project into the configured fork org / namespace and return the **working URL** — the fork that becomes your workspace for this repo. Idempotent: returns the existing fork if one is already there. The repo's source URL stays its identity and the eventual pull-request target; everything you actually do — read, write, branch, commit — happens on the working URL, so a repo you do NOT own is never written directly. GitHub forks into SOURCE_FORK_ORG; GitLab into GITLAB_FORK_NAMESPACE (or your personal namespace) and waits for the fork import to finish. Returns { workingUrl }.",
      inputSchema: {
        sourceUrl: z
          .string()
          .describe(
            'The GitHub repo / GitLab project URL to fork — the source/identity of the repo.'
          ),
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        'Ensure a branch exists on a GitHub repo or GitLab project — created off the default branch if missing, a no-op if it already exists. Pass the **working URL** (the fork from ensure_fork) — that is what you branch and commit on. Returns { ok: true, branch }.',
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
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description:
        "Open a pull request on a GitHub repo (or a merge request on a GitLab project) and return its URL. Addressed by the repo's **source URL** (the PR target); the change lives on a `branch` on the **working URL** (the fork). The cross-repo head is built for you from the working URL, so you never hand-build it. For a same-repo change (you own the repo), pass the same URL for both source and working. On GitLab the fork must be on the same instance, and an already-open MR from the same fork + branch is returned rather than duplicated. Returns { prUrl }.",
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
      // branch); a real fork → a cross-repo head built by `forkHead`.
      const head = workingUrl === sourceUrl ? branch : forkHead(sourceUrl, workingUrl, branch);
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
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "Return a symbol's neighbourhood in the code graph: where it's defined, what calls it, what it calls (resolved across all selected sources; multi-source locations are source-labelled), and which files import it — the relationships you can't get by reading a single file. Use it for 'who uses X' / 'what does X depend on' / 'what would changing X affect' without reading the tree. Approximate: edges are name-based (no type resolution), so a common name may have several definitions.",
      inputSchema: {
        ...sourceSelectionSchema,
        symbol: z.string().describe('Symbol name to look up in the code graph.'),
        ref: z
          .string()
          .optional()
          .describe(
            'Git ref / branch / sha that scopes the cache lookup. Omit for default branch.'
          ),
      },
    },
    async ({ sourceUrl, sourceUrls, symbol, ref }) => {
      const sources = await selectedSources({ sourceUrl, sourceUrls });
      await warmSelectedSources(sources, ref);
      const text =
        sourceUrls === undefined
          ? queryCodeGraph(sources[0], ref ?? '', symbol)
          : queryMultiSourceCodeGraph(
              sources.map((sourceId) => ({ sourceId, version: ref ?? '' })),
              symbol
            );
      return { content: [{ type: 'text', text }] };
    }
  );
}
