import { describe, it, expect } from 'vitest';
import { auditSpanToOtlp, auditSpansToOtlp, uuidToHex } from '../src/otlp.js';
import type { AuditSpan } from '../src/audit.js';

const span = (over: Partial<AuditSpan> = {}): AuditSpan => ({
  trace_id: '11111111-1111-1111-1111-111111111111',
  span_id: '22222222-2222-2222-2222-222222222222',
  name: 'delegate:model:haiku',
  kind: 'model',
  start: '2026-06-30T00:00:00.000Z',
  end: '2026-06-30T00:00:01.000Z',
  duration_ms: 1000,
  attributes: { model: 'haiku', tokens_in: 100, tokens_out: 20, cached: 5 },
  ...over,
});

describe('otlp mapping', () => {
  it('maps an AuditSpan to an OTLP span with hex ids and ns timestamps', () => {
    const o = auditSpanToOtlp(span());
    expect(o.traceId).toBe(uuidToHex('11111111-1111-1111-1111-111111111111'));
    expect(o.spanId).toBe('2222222222222222'); // 16 hex chars
    expect(o.name).toBe('delegate:model:haiku');
    expect(o.kind).toBe(3); // model → CLIENT
    const startNs = String(Date.parse('2026-06-30T00:00:00.000Z') * 1_000_000);
    expect(o.startTimeUnixNano).toBe(startNs);
    expect(BigInt(o.endTimeUnixNano) - BigInt(o.startTimeUnixNano)).toBe(
      BigInt(1000) * BigInt(1_000_000)
    );
  });

  it('carries attributes (model/tokens) as OTLP key/value pairs', () => {
    const byKey = Object.fromEntries(
      auditSpanToOtlp(span()).attributes.map((a) => [a.key, a.value])
    );
    expect(byKey['model']).toEqual({ stringValue: 'haiku' });
    expect(byKey['tokens_in']).toEqual({ intValue: '100' });
    expect(byKey['cached']).toEqual({ intValue: '5' });
  });

  it('includes note/purpose by default, omits them with elideNotes', () => {
    const s = span({ note: 'a prompt excerpt', purpose: 'recruit-ee' });
    const keys = (opts?: { elideNotes?: boolean }) =>
      auditSpanToOtlp(s, opts).attributes.map((a) => a.key);
    expect(keys()).toContain('note');
    expect(keys()).toContain('purpose');
    expect(keys({ elideNotes: true })).not.toContain('note');
    expect(keys({ elideNotes: true })).not.toContain('purpose');
  });

  it('sets parentSpanId only when a parent is present', () => {
    expect(auditSpanToOtlp(span()).parentSpanId).toBeUndefined();
    const child = auditSpanToOtlp(span({ parent_span_id: '33333333-3333-3333-3333-333333333333' }));
    expect(child.parentSpanId).toBe('3333333333333333');
  });

  it('wraps spans in an ExportTraceServiceRequest envelope', () => {
    const env = auditSpansToOtlp([span(), span()]) as {
      resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
    };
    expect(env.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });
});
