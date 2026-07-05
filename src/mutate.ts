import { pickSourceAdapter, resolveSourceEnv } from './router.js';
import {
  applyEdit,
  applyMultiEdit,
  applyInsert,
  applyDeleteBlock,
  type EditResult,
} from './edit.js';
import { invalidateWrittenFile } from './cache.js';
import { contextStore, type ContextStore } from '@verevoir/context';

/**
 * Write a file's full contents to a source, then invalidate the read cache
 * (dual-scope, via `invalidateWrittenFile`). `branch`/`commitMessage` are the
 * already-resolved `commitArgs` — empty for filesystem + Notion, required for
 * GitHub — so callers keep the "GitHub requires a branch" invariant at the tool
 * boundary. `store` is the cache to invalidate; it defaults to the shared
 * singleton and is injectable for tests.
 */
export async function writeSourceFile(
  sourceUrl: string,
  path: string,
  content: string,
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<void> {
  const adapter = await pickSourceAdapter(sourceUrl);
  const env = resolveSourceEnv(sourceUrl);
  await adapter.writeFile(env, sourceUrl, path, content, branch, commitMessage);
  invalidateWrittenFile(sourceUrl, path, branch, store);
}

/**
 * The multi-file twin of `writeSourceFile`: commit `files` together via the
 * adapter's `commitFiles`, then invalidate the read cache for each written file
 * (dual-scope, via `invalidateWrittenFile`). `files` is the already-built set,
 * so it skips the read→apply→write cycle the string-edit ops use. The
 * invalidation runs only after a successful commit — so a failed (possibly
 * partial) commit leaves the cache untouched, as the sibling ops do.
 * Per-backend atomicity is the adapter's contract (see the `commit_files` tool
 * description). `store` is injectable for tests.
 */
export async function commitFilesSource(
  sourceUrl: string,
  branch: string,
  files: { path: string; content: string }[],
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<void> {
  const adapter = await pickSourceAdapter(sourceUrl);
  const env = resolveSourceEnv(sourceUrl);
  await adapter.commitFiles(env, sourceUrl, branch, files, commitMessage);
  for (const { path } of files) {
    invalidateWrittenFile(sourceUrl, path, branch, store);
  }
}

/**
 * The shared mutation cycle: read the file, apply a pure edit op to its content,
 * write it back, and invalidate the read cache. Every string-edit tool is this
 * cycle with a different pure op; all the ops return an `EditResult`, so one
 * wrapper drives them. `store` is injectable for tests.
 */
async function mutateSourceFile(
  sourceUrl: string,
  path: string,
  apply: (content: string) => EditResult,
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<{ replacements: number }> {
  const adapter = await pickSourceAdapter(sourceUrl);
  const env = resolveSourceEnv(sourceUrl);
  const { content } = await adapter.readFile(env, sourceUrl, path, branch || undefined);
  const result = apply(content);
  await adapter.writeFile(env, sourceUrl, path, result.content, branch, commitMessage);
  invalidateWrittenFile(sourceUrl, path, branch, store);
  return { replacements: result.replacements };
}

/** Read → exact-string edit (unique unless replaceAll) → write → invalidate. */
export function editSourceFile(
  sourceUrl: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<{ replacements: number }> {
  return mutateSourceFile(
    sourceUrl,
    path,
    (content) => applyEdit(content, oldString, newString, replaceAll),
    branch,
    commitMessage,
    store
  );
}

/** Read → atomic list of edits (all-or-nothing) → write → invalidate. */
export function multiEditSourceFile(
  sourceUrl: string,
  path: string,
  edits: { oldString: string; newString: string; replaceAll?: boolean }[],
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<{ replacements: number }> {
  return mutateSourceFile(
    sourceUrl,
    path,
    (content) => applyMultiEdit(content, edits),
    branch,
    commitMessage,
    store
  );
}

/** Read → insert text before/after a unique anchor → write → invalidate. */
export function insertSourceFile(
  sourceUrl: string,
  path: string,
  anchor: string,
  text: string,
  position: 'before' | 'after',
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<{ replacements: number }> {
  return mutateSourceFile(
    sourceUrl,
    path,
    (content) => applyInsert(content, anchor, text, position),
    branch,
    commitMessage,
    store
  );
}

/** Read → remove a unique block → write → invalidate. */
export function deleteBlockSourceFile(
  sourceUrl: string,
  path: string,
  block: string,
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<{ replacements: number }> {
  return mutateSourceFile(
    sourceUrl,
    path,
    (content) => applyDeleteBlock(content, block),
    branch,
    commitMessage,
    store
  );
}
