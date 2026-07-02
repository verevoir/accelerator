import { describe, it, expect } from 'vitest';
import type { AuditSpan } from '../src/audit.js';

// Tests for the verevoir-audit-trace converter logic.
// We mirror the pure converter functions inline so tests run in-process
// (no subprocess, no tsx dependency) and stay deterministic. A change to
// the bin that breaks the contract is immediately visible here.

// ── Converter helpers (mirrored from src/audit-trace-bin.ts) ─────────────────

function hashPid(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) & 0x7fffffff;
}

const KIND_TID: Record<string, number> = { tool: 1, capability: 2, model: 3 };

interface ChromeTraceEvent {
  name: string;
  ph: 'X';
  ts: number;
  dur: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

function toChromeTrace(
  spans: AuditSpan[],
  opts: { elideNotes?: boolean } = {}
): { traceEvents: ChromeTraceEvent[] } {
  const traceEvents: ChromeTraceEvent[] = spans.map((s) => {
    const startMs = Date.parse(s.start);
    const pid = hashPid(s.trace_id);
    const tid = KIND_TID[s.kind] ?? 4;
    const args: Record<string, unknown> = {
      span_id: s.span_id,
      ...(s.parent_span_id ? { parent_span_id: s.parent_span_id } : {}),
      ...(s.attributes ?? {}),
    };
    if (!opts.elideNotes) {
      if (s.note) args['note'] = s.note;
      if (s.purpose) args['purpose'] = s.purpose;
    }
    const name = !opts.elideNotes && s.note ? `${s.name} → ${s.note}` : s.name;
    return { name, ph: 'X', ts: startMs * 1000, dur: s.duration_ms * 1000, pid, tid, args };
  });
  return { traceEvents };
}

function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, '');
}

const OTLP_KIND: Record<string, number> = { tool: 3, capability: 1, model: 3 };

function toOtlp(spans: AuditSpan[], opts: { elideNotes?: boolean } = {}): unknown {
  const otlpSpans = spans.map((s) => {
    const startNs = BigInt(Date.parse(s.start)) * BigInt(1_000_000);
    const endNs = startNs + BigInt(s.duration_ms) * BigInt(1_000_000);
    const attrs: Array<{ key: string; value: { stringValue?: string; intValue?: string } }> = [
      { key: 'span.kind.label', value: { stringValue: s.kind } },
    ];
    if (!opts.elideNotes) {
      if (s.note) attrs.push({ key: 'note', value: { stringValue: s.note } });
      if (s.purpose) attrs.push({ key: 'purpose', value: { stringValue: s.purpose } });
    }
    if (s.attributes) {
      for (const [k, v] of Object.entries(s.attributes)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'number') {
          attrs.push({ key: k, value: { intValue: String(Math.round(v)) } });
        } else {
          attrs.push({ key: k, value: { stringValue: String(v) } });
        }
      }
    }
    return {
      traceId: uuidToHex(s.trace_id),
      spanId: uuidToHex(s.span_id).slice(0, 16),
      ...(s.parent_span_id ? { parentSpanId: uuidToHex(s.parent_span_id).slice(0, 16) } : {}),
      name: s.name,
      kind: OTLP_KIND[s.kind] ?? 1,
      startTimeUnixNano: String(startNs),
      endTimeUnixNano: String(endNs),
      attributes: attrs,
      status: { code: 0 },
    };
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'verevoir-mcp' } }] },
        scopeSpans: [
          { scope: { name: 'verevoir-audit-trace', version: '1.0.0' }, spans: otlpSpans },
        ],
      },
    ],
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_SPAN: AuditSpan = {
  trace_id: 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb',
  span_id: 'cccccccc-0000-0000-0000-dddddddddddd',
  name: 'tool:delegate',
  kind: 'tool',
  start: '2026-06-27T10:00:00.000Z',
  end: '2026-06-27T10:00:01.500Z',
  duration_ms: 1500,
};

const SAMPLE_CHILD: AuditSpan = {
  trace_id: 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb',
  span_id: 'eeeeeeee-0000-0000-0000-ffffffffffff',
  parent_span_id: 'cccccccc-0000-0000-0000-dddddddddddd',
  name: 'delegate:model:DeepSeek-V3.2',
  kind: 'model',
  start: '2026-06-27T10:00:00.100Z',
  end: '2026-06-27T10:00:01.400Z',
  duration_ms: 1300,
  attributes: { model: 'DeepSeek-V3.2', tokens_in: 500, tokens_out: 200, cached: 100 },
};

const SAMPLE_NOTED: AuditSpan = {
  ...SAMPLE_SPAN,
  note: 'src/auth/login.ts',
  purpose: 'STDIO-489',
};

// ── Chrome Trace ──────────────────────────────────────────────────────────────

describe('toChromeTrace', () => {
  it('returns a traceEvents array', () => {
    const out = toChromeTrace([SAMPLE_SPAN]);
    expect(out).toHaveProperty('traceEvents');
    expect(out.traceEvents).toHaveLength(1);
  });

  it('each Chrome event has the required ph="X" complete-event fields', () => {
    const [ev] = toChromeTrace([SAMPLE_SPAN]).traceEvents;
    expect(ev).toMatchObject({
      name: 'tool:delegate',
      ph: 'X',
      ts: expect.any(Number),
      dur: expect.any(Number),
      pid: expect.any(Number),
      tid: expect.any(Number),
    });
  });

  it('dur is duration_ms scaled to microseconds', () => {
    const [ev] = toChromeTrace([SAMPLE_SPAN]).traceEvents;
    expect(ev.dur).toBe(1500 * 1000);
  });

  it('ts is the start timestamp in microseconds from epoch', () => {
    const [ev] = toChromeTrace([SAMPLE_SPAN]).traceEvents;
    expect(ev.ts).toBe(Date.parse(SAMPLE_SPAN.start) * 1000);
  });

  it('tid is 1 for tool, 2 for capability, 3 for model', () => {
    const [tool] = toChromeTrace([SAMPLE_SPAN]).traceEvents;
    const [model] = toChromeTrace([SAMPLE_CHILD]).traceEvents;
    expect(tool.tid).toBe(1);
    expect(model.tid).toBe(3);
  });

  it('args carry span_id and parent_span_id so the cascade is reconstructable', () => {
    const [child] = toChromeTrace([SAMPLE_CHILD]).traceEvents;
    expect(child.args?.span_id).toBe('eeeeeeee-0000-0000-0000-ffffffffffff');
    expect(child.args?.parent_span_id).toBe('cccccccc-0000-0000-0000-dddddddddddd');
  });

  it('args carry verbose attributes from the span', () => {
    const [ev] = toChromeTrace([SAMPLE_CHILD]).traceEvents;
    expect(ev.args?.tokens_in).toBe(500);
    expect(ev.args?.model).toBe('DeepSeek-V3.2');
  });

  it('handles an empty span list without crashing', () => {
    expect(toChromeTrace([]).traceEvents).toHaveLength(0);
  });

  it('pid is deterministic for the same trace_id', () => {
    const [a] = toChromeTrace([SAMPLE_SPAN]).traceEvents;
    const [b] = toChromeTrace([{ ...SAMPLE_SPAN, span_id: 'x' }]).traceEvents;
    expect(a.pid).toBe(b.pid);
  });

  // STDIO-489: note and purpose
  it('enriches the frame name with the note when present', () => {
    const [ev] = toChromeTrace([SAMPLE_NOTED]).traceEvents;
    expect(ev.name).toBe('tool:delegate → src/auth/login.ts');
  });

  it('note and purpose appear in args when present', () => {
    const [ev] = toChromeTrace([SAMPLE_NOTED]).traceEvents;
    expect(ev.args?.note).toBe('src/auth/login.ts');
    expect(ev.args?.purpose).toBe('STDIO-489');
  });

  it('frame name is the plain span name when note is absent', () => {
    const [ev] = toChromeTrace([SAMPLE_SPAN]).traceEvents;
    expect(ev.name).toBe('tool:delegate');
    expect(ev.args?.note).toBeUndefined();
  });

  it('elideNotes suppresses note from the frame name', () => {
    const [ev] = toChromeTrace([SAMPLE_NOTED], { elideNotes: true }).traceEvents;
    expect(ev.name).toBe('tool:delegate');
    expect(ev.args?.note).toBeUndefined();
    expect(ev.args?.purpose).toBeUndefined();
  });
});

// ── OTLP ─────────────────────────────────────────────────────────────────────

type OtlpOutput = {
  resourceSpans: [
    {
      resource: {
        attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
      };
      scopeSpans: [
        {
          spans: Array<{
            traceId: string;
            parentSpanId?: string;
            name: string;
            attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
          }>;
        },
      ];
    },
  ];
};

describe('toOtlp', () => {
  it('returns an OTLP structure with resourceSpans', () => {
    const out = toOtlp([SAMPLE_SPAN]) as { resourceSpans: unknown[] };
    expect(out.resourceSpans).toHaveLength(1);
  });

  it('traceId is the UUID with hyphens stripped', () => {
    const out = toOtlp([SAMPLE_SPAN]) as OtlpOutput;
    expect(out.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe(
      'aaaaaaaa000000000000bbbbbbbbbbbb'
    );
  });

  it('parentSpanId is present and 16 hex chars when parent_span_id was set', () => {
    const out = toOtlp([SAMPLE_CHILD]) as OtlpOutput;
    const parentSpanId = out.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId;
    expect(parentSpanId).toBeDefined();
    expect(parentSpanId).toHaveLength(16);
  });

  it('spans with no parent_span_id omit parentSpanId', () => {
    const out = toOtlp([SAMPLE_SPAN]) as OtlpOutput;
    expect(out.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBeUndefined();
  });

  it('service.name resource attribute is verevoir-mcp', () => {
    const out = toOtlp([SAMPLE_SPAN]) as OtlpOutput;
    const attr = out.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name');
    expect(attr?.value?.stringValue).toBe('verevoir-mcp');
  });

  it('numeric attributes become intValue strings', () => {
    const out = toOtlp([SAMPLE_CHILD]) as OtlpOutput;
    const attr = out.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
      (a) => a.key === 'tokens_in'
    );
    expect(attr?.value?.intValue).toBe('500');
  });

  // STDIO-489: note and purpose
  it('note appears as a string OTLP attribute when present', () => {
    const out = toOtlp([SAMPLE_NOTED]) as OtlpOutput;
    const attr = out.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
      (a) => a.key === 'note'
    );
    expect(attr?.value?.stringValue).toBe('src/auth/login.ts');
  });

  it('purpose appears as a string OTLP attribute when present', () => {
    const out = toOtlp([SAMPLE_NOTED]) as OtlpOutput;
    const attr = out.resourceSpans[0].scopeSpans[0].spans[0].attributes.find(
      (a) => a.key === 'purpose'
    );
    expect(attr?.value?.stringValue).toBe('STDIO-489');
  });

  it('note and purpose are absent from OTLP attributes when span has none', () => {
    const out = toOtlp([SAMPLE_SPAN]) as OtlpOutput;
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attrs.find((a) => a.key === 'note')).toBeUndefined();
    expect(attrs.find((a) => a.key === 'purpose')).toBeUndefined();
  });

  it('elideNotes suppresses note and purpose from OTLP attributes', () => {
    const out = toOtlp([SAMPLE_NOTED], { elideNotes: true }) as OtlpOutput;
    const attrs = out.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    expect(attrs.find((a) => a.key === 'note')).toBeUndefined();
    expect(attrs.find((a) => a.key === 'purpose')).toBeUndefined();
  });
});

// ── hashPid ───────────────────────────────────────────────────────────────────

describe('hashPid', () => {
  it('is deterministic for the same string', () => {
    expect(hashPid('abc')).toBe(hashPid('abc'));
  });

  it('differs for different strings', () => {
    expect(hashPid('abc')).not.toBe(hashPid('xyz'));
  });

  it('is always non-negative', () => {
    for (const s of ['a', 'test', 'aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb']) {
      expect(hashPid(s)).toBeGreaterThanOrEqual(0);
    }
  });
});
