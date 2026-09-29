import { normalizeSourceUrl } from './source-url.js';
import { contextStore } from '@verevoir/context';
import { detectLanguage, edgesForItem, parseSymbols } from '@verevoir/context/code';
import type { ContextStore, SymbolEntry } from '@verevoir/context';

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

/** Read one item's symbols without constructing source-wide search hits. */
function symbolsForItem(store: ContextStore, sourceId: string, version: string, itemId: string) {
  const key = { sourceId, version, itemId };
  const cached = store.getSymbols(key);
  if (cached) return cached;
  const content = store.getContent(key);
  // Absence is temporary: leave it uncached so later content can be indexed.
  if (content === undefined) return [];
  const language = detectLanguage(itemId);
  let symbols: SymbolEntry[] = [];
  if (language) {
    try {
      symbols = parseSymbols(language, content);
    } catch {
      // Match the context search contract: one unparseable file is not fatal.
    }
  }
  store.setSymbols(key, symbols);
  return symbols;
}

/** Resolve a complete neighbourhood without copying the whole symbol/edge index.
 * Three linear passes retain only relevant counterpart names and query results.
 * Auxiliary memory scales with indexed file IDs and this neighbourhood; the
 * shared cache and complete result arrays still naturally scale with input size.
 * Name resolution is case-sensitive and drops counterparts absent from the source. */
export function buildNeighbourhood(
  store: ContextStore,
  sourceUrl: string,
  version: string,
  symbol: string
): Neighbourhood {
  const items = store.listIndexedItems(sourceUrl, version);
  const candidates = new Set<string>();
  for (const itemId of items) {
    const edges = edgesForItem(store, sourceUrl, version, itemId);
    if (!edges) continue;
    for (const call of edges.calls) {
      if (call.to === symbol && call.from !== null) candidates.add(call.from);
      if (call.from === symbol) candidates.add(call.to);
    }
  }

  const definitions: SymbolLocation[] = [];
  const definedNames = new Set<string>();
  for (const itemId of items) {
    for (const entry of symbolsForItem(store, sourceUrl, version, itemId)) {
      if (entry.name === symbol) {
        definitions.push({ file: itemId, line: entry.startLine, kind: entry.kind });
      }
      if (candidates.has(entry.name)) definedNames.add(entry.name);
    }
  }

  const callers: CallerHit[] = [];
  const seenCallers = new Set<string>();
  const seenCallees = new Set<string>();
  const importedBySet = new Set<string>();
  for (const itemId of items) {
    const edges = edgesForItem(store, sourceUrl, version, itemId);
    if (!edges) continue;
    for (const call of edges.calls) {
      if (call.to === symbol && (call.from === null || definedNames.has(call.from))) {
        const label = call.from ?? `<top-level:${itemId}>`;
        const key = `${label}|${itemId}|${call.line}`;
        if (!seenCallers.has(key)) {
          seenCallers.add(key);
          callers.push({ from: call.from ?? '<top-level>', file: itemId, line: call.line });
        }
      }
      if (call.from === symbol && definedNames.has(call.to)) seenCallees.add(call.to);
    }
    for (const imp of edges.imports) {
      if (imp.names.includes(symbol)) importedBySet.add(itemId);
    }
  }
  return {
    symbol,
    definitions,
    callers,
    callees: [...seenCallees],
    importedBy: [...importedBySet],
  };
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
// Synchronous library wrapper over the singleton store. Local alias resolution
// can block indefinitely; MCP handlers resolve asynchronously before build/render.
// ---------------------------------------------------------------------------

export function queryCodeGraph(sourceUrl: string, version: string, symbol: string): string {
  sourceUrl = normalizeSourceUrl(sourceUrl);
  const nb = buildNeighbourhood(contextStore, sourceUrl, version, symbol);
  return renderNeighbourhood(nb, sourceUrl);
}
