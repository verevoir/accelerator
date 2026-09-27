import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveManifest, type ManifestResolution } from './manifest.js';

/** Cap the count of independent per-source walk budgets at 100. */
export const MAX_SOURCES = 100;

export interface SourceSelection {
  sourceUrl?: string;
  sourceUrls?: string[];
  sourceSet?: string;
}

/** Select sources in caller order, rejecting ambiguous or empty selections. */
export function resolveSourceUrls(
  { sourceUrl, sourceUrls, sourceSet }: SourceSelection,
  manifest?: ManifestResolution | null
): string[] {
  if ([sourceUrl, sourceUrls, sourceSet].filter((value) => value !== undefined).length !== 1) {
    throw new Error('Provide exactly one of sourceUrl, sourceUrls, or sourceSet.');
  }
  const urls =
    sourceSet !== undefined
      ? resolveSourceSet(sourceSet, manifest === undefined ? resolveManifest() : manifest)
      : sourceUrl === undefined
        ? sourceUrls
        : [sourceUrl];
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    urls.some((url) => typeof url !== 'string' || url.trim().length === 0)
  ) {
    throw new Error('Sources must be a nonempty list of nonblank source URLs.');
  }
  if (urls.length > MAX_SOURCES) {
    throw new Error(`Select at most ${MAX_SOURCES} sources per call.`);
  }
  return [...new Set(urls)];
}

/** Local patterns intentionally support only a final /*: each matched directory
 * is an independent source with its own cache and walk budget. */
function expandSetEntry(entry: string, base: string): string[] {
  if (/^https?:\/\//i.test(entry)) {
    if (entry.includes('*')) throw new Error('Remote source globs are not supported.');
    return [entry];
  }
  const localEntry = entry.startsWith('file://') ? fileURLToPath(entry) : entry;
  const hasGlob = /[?*\[\]{}]/.test(localEntry);
  if (hasGlob) {
    if (!localEntry.endsWith('/*') || /[?*\[\]{}]/.test(localEntry.slice(0, -2))) {
      throw new Error('Only a final /* directory glob is supported in source sets.');
    }
  }
  const path = resolve(base, localEntry);
  if (hasGlob) {
    const directory = path.slice(0, -2) || '/';
    const matches = readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.isSymbolicLink() && statSync(join(directory, entry.name)).isDirectory())
      )
      .map((entry) => join(directory, entry.name))
      .sort();
    if (matches.length === 0) throw new Error(`Pattern ${entry} matched no directories.`);
    return matches;
  }
  if (!statSync(path).isDirectory()) throw new Error(`Source ${entry} must be a directory.`);
  return [path];
}

function resolveSourceSet(name: string, resolution: ManifestResolution | null): string[] {
  if (typeof name !== 'string' || !name.trim())
    throw new Error('sourceSet must be a nonblank name.');
  if (!resolution) throw new Error(`Unknown source set: ${name}.`);
  const sets = resolution.manifest.sourceSets;
  if (!sets || typeof sets !== 'object' || Array.isArray(sets) || !Object.hasOwn(sets, name)) {
    throw new Error(`Unknown source set: ${name}.`);
  }
  const configured = sets[name];
  const entries = typeof configured === 'string' ? [configured] : configured;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Source set ${name} must contain a nonempty list of sources.`);
  }
  if (entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Error(`Source set ${name} entries must be nonblank strings.`);
  }
  try {
    return entries.flatMap((entry) => expandSetEntry(entry, dirname(resolution.sourcePath)));
  } catch (cause) {
    throw new Error(
      `Cannot resolve source set ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
}
