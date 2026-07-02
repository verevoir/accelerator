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
  const scope = { sources: [{ sourceId: sourceUrl, version }] };

  // 1. Full symbol set for this source → definedNames + location map.
  const allSymbols = findSymbols('', scope, { maxResults: 5000, store });
  const definedNames = new Set(allSymbols.map((h) => h.name));
  const locationsByName = new Map<string, SymbolLocation[]>();
  for (const hit of allSymbols) {
    const locs = locationsByName.get(hit.name) ?? [];
    locs.push({ file: hit.itemId, line: hit.startLine, kind: hit.kind });
    locationsByName.set(hit.name, locs);
  }

  // 2. Walk every indexed item to collect all edges.
  type RawCall = { from: string | null; to: string; itemId: string; line: number };
  type RawImport = { itemId: string; names: string[] };

  const allCalls: RawCall[] = [];
  const allImports: RawImport[] = [];

  for (const itemId of store.listIndexedItems(sourceUrl, version)) {
    const edges = edgesForItem(store, sourceUrl, version, itemId);
    if (!edges) continue;
    for (const call of edges.calls) {
      allCalls.push({ from: call.from, to: call.to, itemId, line: call.line });
    }
    for (const imp of edges.imports) {
      allImports.push({ itemId, names: imp.names });
    }
  }

  // 3. Definitions of the requested symbol.
  const definitions = locationsByName.get(symbol) ?? [];

  // 4. Callers — calls where `to === symbol` AND `from` is a defined symbol
  //    (or the top-level sentinel null, which we map to the file itself).
  const seenCallers = new Set<string>();
  const callers: CallerHit[] = [];
  for (const call of allCalls) {
    if (call.to !== symbol) continue;
    const fromName = call.from;
    // Accept top-level calls (from === null) and calls from defined symbols.
    if (fromName !== null && !definedNames.has(fromName)) continue;
    const callerLabel = fromName ?? `<top-level:${call.itemId}>`;
    const dedupeKey = `${callerLabel}|${call.itemId}|${call.line}`;
    if (seenCallers.has(dedupeKey)) continue;
    seenCallers.add(dedupeKey);
    callers.push({
      from: fromName ?? `<top-level>`,
      file: call.itemId,
      line: call.line,
    });
  }

  // 5. Callees — calls where `from === symbol`, resolved to defined names only.
  const seenCallees = new Set<string>();
  for (const call of allCalls) {
    if (call.from !== symbol) continue;
    if (!definedNames.has(call.to)) continue; // drop stdlib / method noise
    seenCallees.add(call.to);
  }
  const callees = [...seenCallees];

  // 6. ImportedBy — files that import `symbol` by name.
  const importedBySet = new Set<string>();
  for (const imp of allImports) {
    if (imp.names.includes(symbol)) {
      importedBySet.add(imp.itemId);
    }
  }
  const importedBy = [...importedBySet];

  return { symbol, definitions, callers, callees, importedBy };
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
