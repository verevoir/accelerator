import { describe, it, expect, afterEach, vi } from 'vitest';
import { openSpan, resetAudit, type AuditConfig } from '../src/audit.js';

// Live OTLP export (STDIO-502): finishing a span POSTs it to the configured
// collector, in addition to the local JSONL. Fire-and-forget + fail-soft.

const cfg = (over: Partial<AuditConfig> = {}): AuditConfig => ({
  mode: 'verbose',
  dir: '/tmp/aigency-audit-otlp-test',
  sessionGapMs: 120_000,
  ...over,
});

afterEach(() => {
  resetAudit();
  vi.unstubAllGlobals();
});

describe('live OTLP export', () => {
  it('POSTs the span to <endpoint>/v1/traces when an endpoint is configured', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    resetAudit(cfg({ otlpEndpoint: 'http://localhost:4318' }));

    openSpan('delegate:model:haiku', 'model').finish({
      model: 'haiku',
      tokens_in: 100,
      tokens_out: 20,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4318/v1/traces');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('delegate:model:haiku');
  });

  it('does not POST when no endpoint is configured (JSONL-only default)', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    resetAudit(cfg()); // no otlpEndpoint

    openSpan('tool:read_file', 'tool').finish();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not POST when audit mode is off', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    resetAudit(cfg({ mode: 'off', otlpEndpoint: 'http://localhost:4318' }));

    openSpan('tool:read_file', 'tool').finish();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is fail-soft — a rejecting fetch never throws from finish()', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('collector down')))
    );
    resetAudit(cfg({ otlpEndpoint: 'http://localhost:4318' }));
    expect(() => openSpan('tool:x', 'tool').finish()).not.toThrow();
  });

  it('strips a trailing slash from the endpoint', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    resetAudit(cfg({ otlpEndpoint: 'http://localhost:4318/' }));

    openSpan('tool:x', 'tool').finish();
    expect((fetchMock.mock.calls[0] as [string, unknown])[0]).toBe(
      'http://localhost:4318/v1/traces'
    );
  });
});
