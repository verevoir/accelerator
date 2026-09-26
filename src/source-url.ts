import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Canonical cache identity for local sources; remote URLs remain unchanged.
 * Existing roots resolve symlinks. Missing roots retain their absolute lexical
 * path so write_file can create them; other filesystem errors propagate.
 * Kept synchronous for compatibility with the original tools/source export.
 */
export function normalizeSourceUrl(sourceUrl: string): string {
  let path: string;
  if (sourceUrl.startsWith('file://')) path = fileURLToPath(sourceUrl);
  else if (sourceUrl.startsWith('~/')) path = resolve(homedir(), sourceUrl.slice(2));
  else if (sourceUrl.startsWith('/') || sourceUrl.startsWith('./')) path = sourceUrl;
  else return sourceUrl;
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(path);
  }
}
