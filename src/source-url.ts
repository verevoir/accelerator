import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function localPath(sourceUrl: string): string | undefined {
  if (sourceUrl.startsWith('file://')) return fileURLToPath(sourceUrl);
  if (sourceUrl.startsWith('~/')) return resolve(homedir(), sourceUrl.slice(2));
  if (sourceUrl.startsWith('/') || sourceUrl.startsWith('./')) return sourceUrl;
  return undefined;
}

function missingPath(error: unknown, path: string): string {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  return resolve(path);
}

/** Synchronous compatibility API: local filesystem resolution can block indefinitely.
 * Async callers should use normalizeSourceUrlAsync.
 */
export function normalizeSourceUrl(sourceUrl: string): string {
  const path = localPath(sourceUrl);
  if (path === undefined) return sourceUrl;
  try {
    return realpathSync(path);
  } catch (error) {
    return missingPath(error, path);
  }
}

/** Resolve local aliases without blocking the server's event loop. Missing roots
 * retain their absolute lexical identity so writes can create them. No memoized
 * path mappings: retargeted symlinks are resolved again on the next operation.
 * The five-second timeout bounds this lookup promise, not the whole operation.
 * Node cannot cancel the underlying syscall: it may keep a shared threadpool
 * worker occupied after timeout. The event loop stays responsive, but other
 * filesystem work can still queue behind stalled workers.
 */
export async function normalizeSourceUrlAsync(sourceUrl: string): Promise<string> {
  const path = localPath(sourceUrl);
  if (path === undefined) return sourceUrl;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      realpath(path),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Source path resolution timed out after 5000ms')),
          5000
        );
      }),
    ]);
  } catch (error) {
    return missingPath(error, path);
  } finally {
    clearTimeout(timer);
  }
}
