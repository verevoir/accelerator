// Shared provider-registry warming. Importing an `@verevoir/llm/<provider>`
// subpath registers that provider's model catalog + connection (the data
// `resolveModelByTerm` / `modelConnection` read). Consumers that resolve a model
// by name (dispatch, the per-tier model slots) must warm the registry first so
// the catalog is populated. The SDKs are bundled (STDIO-377), so all six import.

const IMPORTERS: Record<string, () => Promise<unknown>> = {
  openai: () => import('@verevoir/llm/openai'),
  deepseek: () => import('@verevoir/llm/deepseek'),
  samba: () => import('@verevoir/llm/samba'),
  mistral: () => import('@verevoir/llm/mistral'),
  anthropic: () => import('@verevoir/llm/anthropic'),
  google: () => import('@verevoir/llm/google'),
};

/** Import a single provider's adapter module (registering its catalog +
 * connection), or `undefined` for an unknown provider. */
export function importProviderAdapter(provider: string): Promise<unknown> | undefined {
  return IMPORTERS[provider]?.();
}

let warmed = false;

/** Import every provider adapter once so the llm catalog + connection registry
 * is fully populated. Best-effort — an unimportable adapter is skipped. */
export async function warmRegistry(): Promise<void> {
  if (warmed) return;
  await Promise.all(
    Object.values(IMPORTERS).map(async (load) => {
      try {
        await load();
      } catch {
        // skip an adapter whose SDK can't load
      }
    })
  );
  warmed = true;
}

/** Test seam: reset the warm-once latch. */
export function resetRegistryWarm(): void {
  warmed = false;
}
