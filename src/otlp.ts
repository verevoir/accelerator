// OTLP mapping (STDIO-502) — AuditSpan → OTLP/JSON, shared by the two emitters:
//   - `audit-trace-bin.ts` (post-hoc: a session JSONL → an OTLP file), and
//   - `audit.ts` (live: each span POSTed to an OTLP collector as it finishes).
// One mapping, two consumers — so the live stream and the file export are
// byte-identical in shape. Zero dependencies: hand-rolled OTLP/JSON over the
// stdlib, no OpenTelemetry SDK (keeps the audit dependency-free).
//
// https://opentelemetry.io/docs/specs/otlp/ — ExportTraceServiceRequest →
// resourceSpans[] → scopeSpans[] → spans[].

import type { AuditSpan } from './audit.js';

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number; // SpanKind enum: 1=INTERNAL, 2=SERVER, 3=CLIENT
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  status: { code: number }; // 0=UNSET
}

const OTLP_KIND: Record<string, number> = { tool: 3, capability: 1, model: 3 };

/** Strip hyphens from a UUID for OTel hex ids. */
export function uuidToHex(uuid: string): string {
  return uuid.replace(/-/g, '');
}

/** Map one AuditSpan to an OTLP Span (nanosecond timestamps, hex ids). */
export function auditSpanToOtlp(s: AuditSpan, opts: { elideNotes?: boolean } = {}): OtlpSpan {
  const startNs = BigInt(Date.parse(s.start)) * BigInt(1_000_000);
  const endNs = startNs + BigInt(s.duration_ms) * BigInt(1_000_000);
  const attrs: OtlpSpan['attributes'] = [
    { key: 'span.kind.label', value: { stringValue: s.kind } },
  ];
  // note/purpose may carry truncated prompt content — suppress when elided
  // (see the sensitive-data note in audit-trace-bin.ts / audit.ts).
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
}

/** Wrap OTLP spans in an ExportTraceServiceRequest envelope — the body an OTLP
 * collector accepts at `POST <endpoint>/v1/traces`, and the shape the trace bin
 * writes to a file. */
export function otlpEnvelope(spans: OtlpSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'verevoir-mcp' } }] },
        scopeSpans: [{ scope: { name: 'verevoir-audit-trace', version: '1.0.0' }, spans }],
      },
    ],
  };
}

/** AuditSpans → a full OTLP ExportTraceServiceRequest (the post-hoc file path). */
export function auditSpansToOtlp(spans: AuditSpan[], opts: { elideNotes?: boolean } = {}): unknown {
  return otlpEnvelope(spans.map((s) => auditSpanToOtlp(s, opts)));
}
