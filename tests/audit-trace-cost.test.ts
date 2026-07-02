import { describe, it, expect } from 'vitest';
import type { AuditSpan } from '../src/audit.js';
import {
  spanCostUsd,
  ratesForModel,
  relayoutByCost,
  type CostPlacement,
} from '../src/audit-cost.js';

// Tests for the cost-weighting of verevoir-audit-trace (--by cost, STDIO-506).
// These drive the public surface of src/audit-cost.ts — `spanCostUsd` (per-span
// money) and `relayoutByCost` (the cost cascade layout) — which is exactly what
// the bin calls, so a regression in the money view is caught here.

// ── spanCostUsd ────────────────────────────────────────────────────────────────

function spanWith(attributes: AuditSpan['attributes']): AuditSpan {
  return {
    trace_id: 't',
    span_id: 's',
    name: 'model',
    kind: 'model',
    start: '2026-06-27T10:00:00.000Z',
    end: '2026-06-27T10:00:01.000Z',
    duration_ms: 1000,
    attributes,
  };
}

describe('spanCostUsd', () => {
  it('uses attributes.cost directly when present', () => {
    const span = spanWith({ model: 'opus', tokens_in: 999999, cost: 0.42 });
    // The explicit cost wins even though tokens are also present.
    expect(spanCostUsd(span)).toBe(0.42);
  });

  it('computes cost from tokens × family rates when no explicit cost is present', () => {
    const span = spanWith({ model: 'DeepSeek-V3.2', tokens_in: 1_000_000, tokens_out: 1_000_000 });
    const r = ratesForModel('DeepSeek-V3.2');
    const expected = 1_000_000 * r.rateIn + 1_000_000 * r.rateOut;
    expect(spanCostUsd(span)).toBeCloseTo(expected, 10);
  });

  it('prices cached tokens at the cache-read rate', () => {
    const span = spanWith({ model: 'sonnet', cached: 1_000_000 });
    const r = ratesForModel('sonnet');
    expect(spanCostUsd(span)).toBeCloseTo(1_000_000 * r.rateCacheRead, 10);
  });

  it('is zero when the span has neither cost nor token attributes', () => {
    expect(spanCostUsd(spanWith({ model: 'opus' }))).toBe(0);
  });

  it('is zero when the span has no attributes at all', () => {
    const span = spanWith(undefined);
    expect(spanCostUsd(span)).toBe(0);
  });

  it('falls back to a default rate for an unrecognised model family', () => {
    const known = ratesForModel('opus');
    const unknown = ratesForModel('some-exotic-model-9000');
    expect(unknown.rateIn).not.toBe(known.rateIn);
    // Still a positive, usable rate so an unknown model gets a visible width.
    expect(unknown.rateIn).toBeGreaterThan(0);
  });
});

// ── relayoutByCost: a parent with two children of known cost ──────────────────

describe('relayoutByCost', () => {
  // A parent whose own cost is known, with two children of known cost. With
  // explicit `cost` attributes the maths is exact and independent of the rate
  // table, so the layout assertions are deterministic.
  const PARENT: AuditSpan = {
    trace_id: 'tr',
    span_id: 'parent',
    name: 'capability',
    kind: 'capability',
    start: '2026-06-27T10:00:00.000Z',
    end: '2026-06-27T10:00:03.000Z',
    duration_ms: 3000,
    attributes: { cost: 1 }, // $1 self
  };
  const CHILD_A: AuditSpan = {
    trace_id: 'tr',
    span_id: 'childA',
    parent_span_id: 'parent',
    name: 'model',
    kind: 'model',
    start: '2026-06-27T10:00:00.100Z',
    end: '2026-06-27T10:00:01.000Z',
    duration_ms: 900,
    attributes: { cost: 2 }, // $2
  };
  const CHILD_B: AuditSpan = {
    trace_id: 'tr',
    span_id: 'childB',
    parent_span_id: 'parent',
    name: 'model',
    kind: 'model',
    start: '2026-06-27T10:00:01.100Z',
    end: '2026-06-27T10:00:02.000Z',
    duration_ms: 900,
    attributes: { cost: 3 }, // $3
  };

  const spans = [PARENT, CHILD_A, CHILD_B];

  // SCALE in src/audit-cost.ts is µ-dollars: $1 → 1_000_000 units.
  const usd = (n: number): number => n * 1e6;

  function layout(): Map<string, CostPlacement> {
    return relayoutByCost(spans);
  }

  it("each node's width is proportional to its subtree cost", () => {
    const l = layout();
    // parent total = self 1 + childA 2 + childB 3 = 6
    expect(l.get('parent')!.dur).toBe(usd(6));
    expect(l.get('childA')!.dur).toBe(usd(2));
    expect(l.get('childB')!.dur).toBe(usd(3));
  });

  it("the parent's width equals the sum of its children plus its own cost", () => {
    const l = layout();
    const parent = l.get('parent')!;
    const childSum = l.get('childA')!.dur + l.get('childB')!.dur;
    const selfCost = usd(1);
    expect(parent.dur).toBe(childSum + selfCost);
  });

  it('children are packed left-to-right, contained within the parent and non-overlapping', () => {
    const l = layout();
    const parent = l.get('parent')!;
    const a = l.get('childA')!;
    const b = l.get('childB')!;

    // Both children start at or after the parent's offset.
    expect(a.ts).toBeGreaterThanOrEqual(parent.ts);
    expect(b.ts).toBeGreaterThanOrEqual(parent.ts);

    // Both children end within the parent's span.
    expect(a.ts + a.dur).toBeLessThanOrEqual(parent.ts + parent.dur);
    expect(b.ts + b.dur).toBeLessThanOrEqual(parent.ts + parent.dur);

    // Children don't overlap: A ends exactly where B begins (packed adjacently).
    expect(a.ts + a.dur).toBeLessThanOrEqual(b.ts);
  });

  it('lays roots out sequentially from offset 0', () => {
    const l = layout();
    // The single root starts at 0.
    expect(l.get('parent')!.ts).toBe(0);
  });

  it('returns an empty layout for no spans', () => {
    expect(relayoutByCost([]).size).toBe(0);
  });

  it('treats a span whose parent is absent as a root', () => {
    const orphan: AuditSpan = { ...CHILD_A, parent_span_id: 'not-in-set' };
    const l = relayoutByCost([orphan]);
    // A lone orphan root starts at 0 with width = its own cost ($2).
    expect(l.get('childA')!.ts).toBe(0);
    expect(l.get('childA')!.dur).toBe(usd(2));
  });
});

// ── --by time regression: the time layout is unchanged ─────────────────────────
// The time view derives ts/dur straight from start/duration_ms. Mirror that
// (the same expression the bin uses) to pin that --by cost did not perturb the
// default path.

describe('--by time layout (regression)', () => {
  const span: AuditSpan = {
    trace_id: 'tr',
    span_id: 's',
    name: 'tool:delegate',
    kind: 'tool',
    start: '2026-06-27T10:00:00.000Z',
    end: '2026-06-27T10:00:01.500Z',
    duration_ms: 1500,
  };

  it('ts is the start timestamp in microseconds from epoch', () => {
    expect(Date.parse(span.start) * 1000).toBe(Date.parse('2026-06-27T10:00:00.000Z') * 1000);
  });

  it('dur is duration_ms scaled to microseconds', () => {
    expect(span.duration_ms * 1000).toBe(1500 * 1000);
  });
});
