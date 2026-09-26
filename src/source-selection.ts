export interface SourceSelection {
  sourceUrl?: string;
  sourceUrls?: string[];
}

/** Select sources in caller order, rejecting ambiguous or empty selections. */
export function resolveSourceUrls({ sourceUrl, sourceUrls }: SourceSelection): string[] {
  if ((sourceUrl === undefined) === (sourceUrls === undefined)) {
    throw new Error('Provide exactly one of sourceUrl or sourceUrls.');
  }
  const urls = sourceUrl === undefined ? sourceUrls : [sourceUrl];
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    urls.some((url) => typeof url !== 'string' || url.trim().length === 0)
  ) {
    throw new Error('Sources must be a nonempty list of nonblank source URLs.');
  }
  return [...new Set(urls)];
}
