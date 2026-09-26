import { contextStore } from '@verevoir/context';
import { edgesForItem, findSymbols } from '@verevoir/context/code';
import type { ContextStore } from '@verevoir/context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolLocation {
  file: string;
  line: number;
  kind: string;
}

export interface CallerHit {
  from: string;
  file: string;
  line: number;
}

export interface Neighbourhood {
  symbol: string;
  definitions: SymbolLocation[];
  callers: CallerHit[];
  callees: string[];
  importedBy: string[];
}

// ---------------------------------------------------------------------------
// Core pure helper — testable without an MCP server
// ---------------------------------------------------------------------------

/** Build the neighbourhood of `symbol` from the store's cached edges.
 *
 * Stdlib / method noise is dropped by resolving every `from` and `to`
 * against `definedNames` — the full set of symbols declared inside
 * the source.  A call whose counterpart isn't in that set is not a
 * project-internal edge and is silently discarded.
 *
 * Returns a `Neighbourhood` (always defined — empty lists when nothing
 * is found) so the caller decides how to render "no results". */
export function buildNeighbourhood(
  store: ContextStore,
  sourceUrl: string,
  version: string,
  symbol: string
): Neighbourhood {
  const nb = buildMultiSourceNeighbourhood(store, [{ sourceId: sourceUrl, version }], symbol);
  return {
    symbol,
    definitions: nb.definitions.map(({ sourceId: _, ...location }) => location),
    callers: nb.callers.map(({ sourceId: _, ...caller }) => caller),
    callees: nb.callees.map(({ name }) => name),
    importedBy: nb.importedBy.map(({ file }) => file),
  };
}

export interface GraphSource {
  sourceId: string;
  version: string;
}

export interface MultiSourceNeighbourhood {
  symbol: string;
  definitions: Array<SymbolLocation & { sourceId: string }>;
  callers: Array<CallerHit & { sourceId: string }>;
  callees: Array<{ name: string; sourceId: string }>;
  importedBy: Array<{ file: string; sourceId: string }>;
}

/** Resolve name-based edges against definitions across all selected sources.
 * Source identities remain attached even when relative file paths coincide. */
export function buildMultiSourceNeighbourhood(
  store: ContextStore,
  sources: GraphSource[],
  symbol: string
): MultiSourceNeighbourhood {
  const allSymbols = findSymbols('', { sources }, { maxResults: Infinity, store });
  const namesBySource = new Map<string, Set<string>>();
  const locationsByName = new Map<string, MultiSourceNeighbourhood['definitions']>();
  for (const hit of allSymbols) {
    const names = namesBySource.get(hit.sourceId) ?? new Set<string>();
    names.add(hit.name);
    namesBySource.set(hit.sourceId, names);
    const locations = locationsByName.get(hit.name) ?? [];
    locations.push({
      sourceId: hit.sourceId,
      file: hit.itemId,
      line: hit.startLine,
      kind: hit.kind,
    });
    locationsByName.set(hit.name, locations);
  }

  const callers: MultiSourceNeighbourhood['callers'] = [];
  const callees: MultiSourceNeighbourhood['callees'] = [];
  const importedBy: MultiSourceNeighbourhood['importedBy'] = [];
  const seenCallers = new Set<string>();
  const seenCallees = new Set<string>();
  const seenImports = new Set<string>();
  for (const { sourceId, version } of sources) {
    for (const file of store.listIndexedItems(sourceId, version)) {
      const edges = edgesForItem(store, sourceId, version, file);
      if (!edges) continue;
      for (const call of edges.calls) {
        if (
          call.to === symbol &&
          (call.from === null || namesBySource.get(sourceId)?.has(call.from))
        ) {
          const key = JSON.stringify([sourceId, call.from, file, call.line]);
          if (!seenCallers.has(key)) {
            seenCallers.add(key);
            callers.push({ sourceId, from: call.from ?? '<top-level>', file, line: call.line });
          }
        }
        if (call.from === symbol) {
          for (const target of locationsByName.get(call.to) ?? []) {
            const key = JSON.stringify([target.sourceId, call.to]);
            if (!seenCallees.has(key)) {
              seenCallees.add(key);
              callees.push({ sourceId: target.sourceId, name: call.to });
            }
          }
        }
      }
      if (edges.imports.some((imp) => imp.names.includes(symbol))) {
        const key = JSON.stringify([sourceId, file]);
        if (!seenImports.has(key)) {
          seenImports.add(key);
          importedBy.push({ sourceId, file });
        }
      }
    }
  }
  return { symbol, definitions: locationsByName.get(symbol) ?? [], callers, callees, importedBy };
}

// ---------------------------------------------------------------------------
// Text renderer (LLM-facing output)
// ---------------------------------------------------------------------------

const CAP = 50;

function cap<T>(items: T[], label: (i: T) => string): string {
  if (items.length === 0) return 'none';
  const shown = items.slice(0, CAP).map(label);
  const extra = items.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
}

export function renderNeighbourhood(nb: Neighbourhood, sourceUrl: string): string {
  const { symbol, definitions, callers, callees, importedBy } = nb;

  if (
    definitions.length === 0 &&
    callers.length === 0 &&
    callees.length === 0 &&
    importedBy.length === 0
  ) {
    return `no symbol '${symbol}' found in ${sourceUrl} — try find_symbol or read the area.`;
  }

  const lines: string[] = [];

  // Defined-at line(s)
  if (definitions.length === 0) {
    lines.push(
      `\`${symbol}\` — not found as a definition (referenced but not declared in this source)`
    );
  } else if (definitions.length === 1) {
    const d = definitions[0];
    lines.push(`\`${symbol}\` — defined at ${d.file}:${d.line} (${d.kind})`);
  } else {
    const defs = definitions
      .slice(0, CAP)
      .map((d) => `${d.file}:${d.line} (${d.kind})`)
      .join(', ');
    const extra = definitions.length - Math.min(definitions.length, CAP);
    lines.push(
      `\`${symbol}\` — ${definitions.length} definitions: ${defs}${extra > 0 ? ` (+${extra} more)` : ''}`
    );
  }

  lines.push(`called by: ${cap(callers, (c) => `${c.from} (${c.file}:${c.line})`)}`);
  lines.push(`calls: ${cap(callees, (c) => c)}`);
  lines.push(`imported by: ${cap(importedBy, (f) => f)}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Convenience wrapper used by the MCP tool (uses the singleton store)
// ---------------------------------------------------------------------------

export function queryCodeGraph(sourceUrl: string, version: string, symbol: string): string {
  const nb = buildNeighbourhood(contextStore, sourceUrl, version, symbol);
  return renderNeighbourhood(nb, sourceUrl);
}

export function queryMultiSourceCodeGraph(sources: GraphSource[], symbol: string): string {
  const nb = buildMultiSourceNeighbourhood(contextStore, sources, symbol);
  const labelled: Neighbourhood = {
    symbol,
    definitions: nb.definitions.map((d) => ({ ...d, file: `[${d.sourceId}] ${d.file}` })),
    callers: nb.callers.map((c) => ({ ...c, file: `[${c.sourceId}] ${c.file}` })),
    callees: nb.callees.map((c) => `[${c.sourceId}] ${c.name}`),
    importedBy: nb.importedBy.map((i) => `[${i.sourceId}] ${i.file}`),
  };
  return renderNeighbourhood(labelled, sources.map((source) => source.sourceId).join(', '));
}
