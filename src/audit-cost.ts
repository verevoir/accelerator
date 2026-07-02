// Cost weighting for the audit-trace flame chart (STDIO-506).
//
// A flame chart needs a `ts`/`dur` per span. The default view uses the real
// timeline; this module powers the alternative `--by cost` view, which answers
// "where did the money go" by re-laying-out the cascade so each span's width is
// its rolled-up USD cost instead of its wall-clock duration.
//
// Pure transform, zero dependencies — text/spans in, numbers out — so it stays
// consistent with the rest of the zero-dep audit-trace pipeline and is trivially
// unit-testable. Costs here are a *visualisation weight*, not a billing figure:
// approximate per-token rates are fine, and a missing rate degrades to zero
// rather than throwing.

import type { AuditSpan } from './audit.js';

/** The weighting axis for the flame chart. `time` is the real timeline (the
 * default, unchanged behaviour); `cost` re-lays-out by USD cost. */
export type WeightBy = 'time' | 'cost';

// ── Per-token rate table ──────────────────────────────────────────────────────
// Keyed by a lower-cased substring of the model id/family. USD *per token*
// (i.e. published $/M-token ÷ 1e6). Rates are approximate, list-price
// snapshots gathered ~2026-06 from each provider's public pricing page; they
// exist only to *weight* the flame chart, so a stale or rounded figure changes
// a bar's width, never a bill. The MCP's own delegate/dispatch spans carry an
// exact `attributes.cost` (priced via @verevoir/llm's catalog at call time) and
// are used directly — this table is the fallback for spans that carry only
// token counts (notably Claude Code transcript spans, which have no cost), so
// reusing @verevoir/llm's catalog here (which needs the provider registry warmed
// — a network/key-bound step unsuitable for a pure, offline bin) buys nothing.
//
// rateIn       — input (prompt) tokens.
// rateOut      — output (completion) tokens.
// rateCacheRead — prompt-cache reads (~0.1× input, the established convention in
//                 src/metering.ts and @verevoir/llm).
// Cache-creation/write tokens (~1.25× input) are priced via `rateCacheWrite`.

interface ModelRates {
  rateIn: number;
  rateOut: number;
  rateCacheRead: number;
  rateCacheWrite: number;
}

/** Build a rate set from input/output $/M-token, deriving the cache rates from
 * the standard ratios (read ~0.1× input, write ~1.25× input). */
function rates(inPerM: number, outPerM: number): ModelRates {
  const rateIn = inPerM / 1e6;
  const rateOut = outPerM / 1e6;
  return {
    rateIn,
    rateOut,
    rateCacheRead: rateIn * 0.1,
    rateCacheWrite: rateIn * 1.25,
  };
}

/** Family-substring → rates. Matched longest-key-first against the lower-cased
 * model id so a more specific family (e.g. a future "gpt-4o") could be added
 * ahead of the generic "gpt". Figures are approximate list prices, $/M-token. */
const RATES: Array<{ family: string; rates: ModelRates }> = [
  { family: 'opus', rates: rates(15, 75) }, // Claude Opus
  { family: 'sonnet', rates: rates(3, 15) }, // Claude Sonnet
  { family: 'haiku', rates: rates(0.8, 4) }, // Claude Haiku
  { family: 'deepseek', rates: rates(0.27, 1.1) }, // DeepSeek V3 family
  { family: 'gemini', rates: rates(1.25, 5) }, // Google Gemini Pro tier
  { family: 'gpt', rates: rates(2.5, 10) }, // OpenAI GPT-4o tier
];

/** A sensible default for an unrecognised model — mid-range, so an unknown
 * model still contributes a visible (not zero, not dominating) width. */
const DEFAULT_RATES: ModelRates = rates(1, 3);

/** Resolve the rate set for a model id by family substring, defaulting when no
 * family matches. Case-insensitive. */
export function ratesForModel(model: string | undefined): ModelRates {
  if (!model) return DEFAULT_RATES;
  const lower = model.toLowerCase();
  let best: { family: string; rates: ModelRates } | undefined;
  for (const entry of RATES) {
    if (lower.includes(entry.family)) {
      if (!best || entry.family.length > best.family.length) best = entry;
    }
  }
  return best?.rates ?? DEFAULT_RATES;
}

/**
 * The USD cost attributed to a single span, for cost weighting.
 *
 *  - If `attributes.cost` is present (MCP delegate/dispatch model spans carry an
 *    exact figure), use it directly.
 *  - Else, if the span has token attributes, compute
 *    tokens_in×rateIn + tokens_out×rateOut + cached×rateCacheRead from the
 *    family rate table (cached tokens are treated as cache *reads*, the common
 *    case; cache-creation isn't separately recorded on a span).
 *  - Else 0 (e.g. a tool span with no model usage).
 *
 * Never throws: a malformed attribute set yields 0.
 */
export function spanCostUsd(span: AuditSpan): number {
  const a = span.attributes;
  if (!a) return 0;
  if (typeof a.cost === 'number' && Number.isFinite(a.cost)) return Math.max(0, a.cost);
  const hasTokens =
    typeof a.tokens_in === 'number' ||
    typeof a.tokens_out === 'number' ||
    typeof a.cached === 'number';
  if (!hasTokens) return 0;
  const r = ratesForModel(a.model);
  const tokensIn = typeof a.tokens_in === 'number' ? a.tokens_in : 0;
  const tokensOut = typeof a.tokens_out === 'number' ? a.tokens_out : 0;
  const cached = typeof a.cached === 'number' ? a.cached : 0;
  const cost = tokensIn * r.rateIn + tokensOut * r.rateOut + cached * r.rateCacheRead;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

// ── Cost-weighted layout ──────────────────────────────────────────────────────
// Cost isn't a timeline, so we synthesise one. Build the span tree by
// parent_span_id, roll each subtree's total cost up, then place every node at a
// horizontal offset proportional to cost with its children packed left-to-right
// *inside* it. The result feeds the same Chrome-trace `ts`/`dur` slots, so the
// existing flame-chart viewers render it unchanged — only the axis means money.

/** µ-dollars per USD: the layout scale. $0.01 → 10000 units, keeping the
 * numbers integer and visible — self-consistent within the cost view, the way
 * the time view scales ms → µs by 1000. */
const SCALE = 1e6;

/** The cost-derived placement of one span: `ts` (offset) and `dur` (width),
 * both in µ-dollars. */
export interface CostPlacement {
  ts: number;
  dur: number;
}

interface CostNode {
  span: AuditSpan;
  children: CostNode[];
  /** Self cost (this span only), USD. */
  selfCost: number;
  /** Subtree cost (self + all descendants), USD — memoised. */
  totalCost: number;
}

/**
 * Re-lay-out a set of spans by cost, returning a map from span_id to its
 * µ-dollar `{ ts, dur }`.
 *
 * Roots (spans whose parent isn't in the set) are laid out sequentially from
 * offset 0. Each node is placed at its offset with width = its subtree's total
 * cost; its children are packed left-to-right starting at the same offset, each
 * consuming its own subtree width. So a child is always contained within its
 * parent's span and siblings never overlap.
 */
export function relayoutByCost(spans: AuditSpan[]): Map<string, CostPlacement> {
  const placement = new Map<string, CostPlacement>();
  if (spans.length === 0) return placement;

  // Build nodes and index by span_id. A duplicate span_id keeps the first.
  const byId = new Map<string, CostNode>();
  for (const span of spans) {
    if (!byId.has(span.span_id)) {
      byId.set(span.span_id, { span, children: [], selfCost: spanCostUsd(span), totalCost: 0 });
    }
  }

  // Wire children to parents; a span whose parent isn't present is a root.
  const roots: CostNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parent_span_id;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  // Roll subtree costs up (post-order). Iterative to avoid deep-recursion limits
  // on a very deep cascade.
  const computeTotal = (root: CostNode): void => {
    const stack: Array<{ node: CostNode; phase: number }> = [{ node: root, phase: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.phase === 0) {
        frame.phase = 1;
        for (const child of frame.node.children) stack.push({ node: child, phase: 0 });
      } else {
        stack.pop();
        let total = frame.node.selfCost;
        for (const child of frame.node.children) total += child.totalCost;
        frame.node.totalCost = total;
      }
    }
  };
  for (const root of roots) computeTotal(root);

  // Place each node: ts = offset (scaled), dur = totalCost (scaled); children
  // packed left-to-right from the same offset. Iterative pre-order walk.
  const place = (root: CostNode, rootOffset: number): void => {
    const stack: Array<{ node: CostNode; offset: number }> = [{ node: root, offset: rootOffset }];
    while (stack.length > 0) {
      const { node, offset } = stack.pop()!;
      placement.set(node.span.span_id, {
        ts: Math.round(offset * SCALE),
        dur: Math.round(node.totalCost * SCALE),
      });
      // Pack children left-to-right. Push in reverse so the first child is
      // processed first (LIFO stack) — cosmetic, keeps placement deterministic.
      let childOffset = offset;
      const layouts: Array<{ node: CostNode; offset: number }> = [];
      for (const child of node.children) {
        layouts.push({ node: child, offset: childOffset });
        childOffset += child.totalCost;
      }
      for (let i = layouts.length - 1; i >= 0; i--) stack.push(layouts[i]);
    }
  };

  let offset = 0;
  for (const root of roots) {
    place(root, offset);
    offset += root.totalCost;
  }

  return placement;
}
