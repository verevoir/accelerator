import { pickSourceAdapter, resolveSourceEnv } from './router.js';
import { applyEdit } from './edit.js';
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
 * Read the file, apply a unique-anchor string edit, write it back, and invalidate
 * the read cache. Returns the replacement count. `store` is injectable for tests
 * (defaults to the shared singleton).
 */
export async function editSourceFile(
  sourceUrl: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  branch: string,
  commitMessage: string,
  store: ContextStore = contextStore
): Promise<{ replacements: number }> {
  const adapter = await pickSourceAdapter(sourceUrl);
  const env = resolveSourceEnv(sourceUrl);
  const { content } = await adapter.readFile(env, sourceUrl, path, branch || undefined);
  const result = applyEdit(content, oldString, newString, replaceAll);
  await adapter.writeFile(env, sourceUrl, path, result.content, branch, commitMessage);
  invalidateWrittenFile(sourceUrl, path, branch, store);
  return { replacements: result.replacements };
}
