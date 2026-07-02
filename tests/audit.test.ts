import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveAuditConfig,
  resetAudit,
  openSpan,
  currentSessionId,
  childContext,
  deriveNote,
  truncateNote,
  resolveAuditPurpose,
  NOTE_MAX_CHARS,
  type AuditSpan,
} from '../src/audit.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(): string {
  const dir = join(tmpdir(), `audit-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readSpans(dir: string): AuditSpan[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const spans: AuditSpan[] = [];
  for (const f of files) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
    for (const l of lines) spans.push(JSON.parse(l) as AuditSpan);
  }
  return spans;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tmpAuditDir = '';

beforeEach(() => {
  tmpAuditDir = tmpDir();
  // Reset to a clean state before each test.
  resetAudit();
  delete process.env.AIGENCY_AUDIT;
  delete process.env.AIGENCY_AUDIT_DIR;
  delete process.env.AIGENCY_AUDIT_SESSION_GAP;
});

afterEach(() => {
  resetAudit();
  delete process.env.AIGENCY_AUDIT;
  delete process.env.AIGENCY_AUDIT_DIR;
  delete process.env.AIGENCY_AUDIT_SESSION_GAP;
  try {
    rmSync(tmpAuditDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── resolveAuditConfig ────────────────────────────────────────────────────────

describe('resolveAuditConfig', () => {
  it('defaults to off when AIGENCY_AUDIT is not set', () => {
    expect(resolveAuditConfig().mode).toBe('off');
  });

  it('resolves "on" from AIGENCY_AUDIT env', () => {
    process.env.AIGENCY_AUDIT = 'on';
    expect(resolveAuditConfig().mode).toBe('on');
  });

  it('resolves "verbose" from AIGENCY_AUDIT env', () => {
    process.env.AIGENCY_AUDIT = 'verbose';
    expect(resolveAuditConfig().mode).toBe('verbose');
  });

  it('falls back to "off" for an unrecognised AIGENCY_AUDIT value', () => {
    process.env.AIGENCY_AUDIT = 'loud';
    expect(resolveAuditConfig().mode).toBe('off');
  });

  it('uses ./aigency-audit as the default dir', () => {
    expect(resolveAuditConfig().dir).toBe('./aigency-audit');
  });

  it('respects AIGENCY_AUDIT_DIR override', () => {
    process.env.AIGENCY_AUDIT_DIR = '/custom/dir';
    expect(resolveAuditConfig().dir).toBe('/custom/dir');
  });

  it('defaults sessionGapMs to 120 000 ms', () => {
    expect(resolveAuditConfig().sessionGapMs).toBe(120_000);
  });

  it('respects AIGENCY_AUDIT_SESSION_GAP (seconds)', () => {
    process.env.AIGENCY_AUDIT_SESSION_GAP = '30';
    expect(resolveAuditConfig().sessionGapMs).toBe(30_000);
  });
});

// ── openSpan / appendSpan (mode=off) ─────────────────────────────────────────

describe('when audit mode is off (default)', () => {
  it('openSpan finish() writes nothing', () => {
    const { finish } = openSpan('test', 'tool');
    finish();
    // No file created — off mode produces no output.
    const files = readdirSync(tmpAuditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(0);
  });
});

// ── openSpan / appendSpan (mode=on) ──────────────────────────────────────────

describe('when audit mode is "on"', () => {
  beforeEach(() => {
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 120_000 });
  });

  it('finish() writes a JSONL span file', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const spans = readSpans(tmpAuditDir);
    expect(spans).toHaveLength(1);
  });

  it('written span has the required OTel fields', () => {
    const { finish } = openSpan('tool:dispatch', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s).toMatchObject({
      trace_id: expect.any(String),
      span_id: expect.any(String),
      name: 'tool:dispatch',
      kind: 'tool',
      start: expect.any(String),
      end: expect.any(String),
      duration_ms: expect.any(Number),
    });
  });

  it('duration_ms is non-negative', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does NOT include attributes in on mode even when supplied', () => {
    const { finish } = openSpan('dispatch:model:X', 'model');
    finish({ model: 'DeepSeek-V3.2', tokens_in: 100, tokens_out: 50 });
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes).toBeUndefined();
  });

  it('parent_span_id is set when parentId is supplied', () => {
    const parent = openSpan('tool:delegate', 'tool');
    const child = openSpan('delegate:model:X', 'model', {
      traceId: parent.traceId,
      parentId: parent.spanId,
    });
    child.finish();
    parent.finish();
    const spans = readSpans(tmpAuditDir);
    const childSpan = spans.find((s) => s.name === 'delegate:model:X')!;
    expect(childSpan.parent_span_id).toBe(parent.spanId);
    expect(childSpan.trace_id).toBe(parent.traceId);
  });

  it('multiple spans share a trace_id within a session', () => {
    const a = openSpan('a', 'tool');
    a.finish();
    const b = openSpan('b', 'capability');
    b.finish();
    const spans = readSpans(tmpAuditDir);
    expect(spans[0].trace_id).toBe(spans[1].trace_id);
  });

  it('currentSessionId() returns the trace_id after the first span', () => {
    const { traceId, finish } = openSpan('t', 'tool');
    finish();
    expect(currentSessionId()).toBe(traceId);
  });
});

// ── Verbose mode attributes ───────────────────────────────────────────────────

describe('when audit mode is "verbose"', () => {
  beforeEach(() => {
    resetAudit({ mode: 'verbose', dir: tmpAuditDir, sessionGapMs: 120_000 });
  });

  it('finish() includes attributes when supplied', () => {
    const { finish } = openSpan('dispatch:model:DeepSeek', 'model');
    finish({ model: 'DeepSeek-V3.2', tokens_in: 200, tokens_out: 80, cached: 50 });
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes).toMatchObject({
      model: 'DeepSeek-V3.2',
      tokens_in: 200,
      tokens_out: 80,
      cached: 50,
    });
  });

  it('finish() with no attributes omits the attributes key', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes).toBeUndefined();
  });

  it('cost_rollup on a capability span is captured', () => {
    const { finish } = openSpan('delegate', 'capability');
    finish({ cost_rollup: 0.0012 });
    const [s] = readSpans(tmpAuditDir);
    expect(s.attributes?.cost_rollup).toBeCloseTo(0.0012);
  });
});

// ── Session gap ───────────────────────────────────────────────────────────────

describe('session gap detection', () => {
  it('a gap wider than the threshold starts a new session file', async () => {
    // Use a 0ms gap so the second span always triggers a new session.
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 0 });
    const a = openSpan('a', 'tool');
    a.finish();
    // Wait a tick so the wall clock advances.
    await new Promise((r) => setTimeout(r, 2));
    const b = openSpan('b', 'tool');
    b.finish();
    const files = readdirSync(tmpAuditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('spans within the gap land in the same file', () => {
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 60_000 });
    const a = openSpan('a', 'tool');
    a.finish();
    const b = openSpan('b', 'tool');
    b.finish();
    const files = readdirSync(tmpAuditDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
  });
});

// ── childContext ──────────────────────────────────────────────────────────────

describe('childContext', () => {
  it('builds a SpanContext with the parent trace_id and span_id as parentId', () => {
    const ctx = childContext({ traceId: 'trace-1', spanId: 'span-1' });
    expect(ctx).toEqual({ traceId: 'trace-1', parentId: 'span-1' });
  });

  it('propagates purpose when parent carries one', () => {
    const ctx = childContext({ traceId: 'trace-1', spanId: 'span-1', purpose: 'STDIO-489' });
    expect(ctx).toEqual({ traceId: 'trace-1', parentId: 'span-1', purpose: 'STDIO-489' });
  });

  it('omits purpose when parent has none', () => {
    const ctx = childContext({ traceId: 'trace-1', spanId: 'span-1' });
    expect(ctx.purpose).toBeUndefined();
  });
});

// ── appendSpan write failure ──────────────────────────────────────────────────

describe('appendSpan write failure', () => {
  it('does not throw when the dir cannot be created (parent is a file)', () => {
    // Create a regular file at a path, then use a subpath as the audit dir.
    // mkdirSync will fail with ENOTDIR; appendSpan must swallow it.
    const blockingFile = join(tmpAuditDir, 'not-a-dir');
    writeFileSync(blockingFile, 'x');
    resetAudit({ mode: 'on', dir: join(blockingFile, 'subdir'), sessionGapMs: 120_000 });
    expect(() => {
      const { finish } = openSpan('t', 'tool');
      finish(); // triggers appendSpan, which tries mkdirSync and fails
    }).not.toThrow();
  });
});

// ── truncateNote (STDIO-489) ──────────────────────────────────────────────────

describe('truncateNote', () => {
  it('returns the string unchanged when it fits within the cap', () => {
    expect(truncateNote('hello world')).toBe('hello world');
  });

  it('truncates to NOTE_MAX_CHARS grapheme clusters', () => {
    const long = 'a'.repeat(NOTE_MAX_CHARS + 10);
    const result = truncateNote(long);
    expect(result.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
  });

  it('collapses newlines to a space', () => {
    expect(truncateNote('first\nsecond')).toBe('first second');
  });

  it('collapses carriage-return newlines to a space', () => {
    expect(truncateNote('first\r\nsecond')).toBe('first second');
  });

  it('trims surrounding whitespace after collapsing', () => {
    expect(truncateNote('  hello  ')).toBe('hello');
  });

  it('returns an empty string for a blank input', () => {
    expect(truncateNote('')).toBe('');
    expect(truncateNote('   ')).toBe('');
  });

  it('handles a multi-codepoint emoji correctly (grapheme safety)', () => {
    // The family emoji 👨‍👩‍👧‍👦 is multiple code points but one grapheme cluster.
    // We cannot assert it preserves exactly N clusters without Intl.Segmenter,
    // but we can assert it never throws and the result is a string.
    const emoji = '👨‍👩‍👧‍👦'.repeat(130);
    expect(() => truncateNote(emoji)).not.toThrow();
    expect(typeof truncateNote(emoji)).toBe('string');
  });

  it('respects a custom max length', () => {
    expect(truncateNote('abcdef', 3)).toHaveLength(3);
  });
});

// ── deriveNote (STDIO-489) ────────────────────────────────────────────────────

describe('deriveNote', () => {
  it('derives path from write_file args', () => {
    expect(deriveNote('write_file', { path: 'src/auth/login.ts' })).toBe('src/auth/login.ts');
  });

  it('derives path from read_file args', () => {
    expect(deriveNote('read_file', { path: 'src/index.ts' })).toBe('src/index.ts');
  });

  it('derives path from edit_file args', () => {
    expect(deriveNote('edit_file', { path: 'src/utils.ts', oldString: 'x', newString: 'y' })).toBe(
      'src/utils.ts'
    );
  });

  it('derives pattern from grep args', () => {
    expect(deriveNote('grep', { pattern: 'openSpan' })).toBe('openSpan');
  });

  it('derives name from find_symbol args', () => {
    expect(deriveNote('find_symbol', { name: 'AuditSpan' })).toBe('AuditSpan');
  });

  it('derives title from open_pull_request args', () => {
    expect(deriveNote('open_pull_request', { title: 'STDIO-489: add span notes' })).toBe(
      'STDIO-489: add span notes'
    );
  });

  it('derives first line of prompt from delegate args', () => {
    expect(deriveNote('delegate', { prompt: 'Write a test\nMore details here' })).toBe(
      'Write a test'
    );
  });

  it('derives first line of prompt from dispatch args', () => {
    expect(deriveNote('dispatch', { prompt: 'Review the codebase\nFor security issues' })).toBe(
      'Review the codebase'
    );
  });

  it('derives task from refine_start args', () => {
    expect(deriveNote('refine_start', { task: 'Summarise the following text' })).toBe(
      'Summarise the following text'
    );
  });

  it('derives task from search_start args', () => {
    expect(deriveNote('search_start', { task: 'Generate a haiku' })).toBe('Generate a haiku');
  });

  it('returns undefined for an unknown tool', () => {
    expect(deriveNote('unknown_tool', { path: '/some/path' })).toBeUndefined();
  });

  it('returns undefined when args is undefined', () => {
    expect(deriveNote('write_file', undefined)).toBeUndefined();
  });

  it('returns undefined when the relevant arg is missing', () => {
    expect(deriveNote('write_file', { content: 'hello' })).toBeUndefined();
  });

  it('returns undefined when the relevant arg is an empty string', () => {
    expect(deriveNote('write_file', { path: '   ' })).toBeUndefined();
  });

  it('never throws on an oddly-shaped args object', () => {
    expect(() => deriveNote('write_file', { path: null as unknown as string })).not.toThrow();
    expect(() => deriveNote('write_file', { path: 42 as unknown as string })).not.toThrow();
  });

  it('caps the note at NOTE_MAX_CHARS', () => {
    const long = 'x'.repeat(NOTE_MAX_CHARS + 50);
    const note = deriveNote('write_file', { path: long });
    expect(note).toBeDefined();
    expect(note!.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
  });
});

// ── note and purpose on spans (STDIO-489) ─────────────────────────────────────

describe('when audit mode is "on" — note field', () => {
  beforeEach(() => {
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 120_000 });
  });

  it('note is written when passed to openSpan', () => {
    const { finish } = openSpan('tool:write_file', 'tool', { note: 'src/auth/login.ts' });
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.note).toBe('src/auth/login.ts');
  });

  it('note is absent when not passed to openSpan', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.note).toBeUndefined();
  });
});

// ── purpose (STDIO-489) ───────────────────────────────────────────────────────

describe('resolveAuditPurpose', () => {
  afterEach(() => {
    delete process.env.AIGENCY_AUDIT_PURPOSE;
  });

  it('returns undefined when AIGENCY_AUDIT_PURPOSE is not set', () => {
    delete process.env.AIGENCY_AUDIT_PURPOSE;
    expect(resolveAuditPurpose()).toBeUndefined();
  });

  it('returns the trimmed value when AIGENCY_AUDIT_PURPOSE is set', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = '  STDIO-489  ';
    expect(resolveAuditPurpose()).toBe('STDIO-489');
  });

  it('returns undefined for a blank AIGENCY_AUDIT_PURPOSE', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = '   ';
    expect(resolveAuditPurpose()).toBeUndefined();
  });

  it('caps the purpose at NOTE_MAX_CHARS', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = 'x'.repeat(NOTE_MAX_CHARS + 20);
    const p = resolveAuditPurpose();
    expect(p).toBeDefined();
    expect(p!.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
  });
});

describe('when audit mode is "on" — purpose field', () => {
  beforeEach(() => {
    resetAudit({ mode: 'on', dir: tmpAuditDir, sessionGapMs: 120_000 });
    delete process.env.AIGENCY_AUDIT_PURPOSE;
  });

  afterEach(() => {
    delete process.env.AIGENCY_AUDIT_PURPOSE;
  });

  it('purpose is written when AIGENCY_AUDIT_PURPOSE env is set', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = 'STDIO-489';
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.purpose).toBe('STDIO-489');
  });

  it('purpose is absent when AIGENCY_AUDIT_PURPOSE is not set', () => {
    const { finish } = openSpan('tool:delegate', 'tool');
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.purpose).toBeUndefined();
  });

  it('purpose passed explicitly via opts overrides env', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = 'from-env';
    const { finish } = openSpan('tool:delegate', 'tool', { purpose: 'from-opts' });
    finish();
    const [s] = readSpans(tmpAuditDir);
    expect(s.purpose).toBe('from-opts');
  });

  it('purpose is propagated to child spans via childContext', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = 'STDIO-489';
    const parent = openSpan('tool:delegate', 'tool');
    const child = openSpan('delegate', 'capability', {
      ...childContext(parent),
    });
    child.finish();
    parent.finish();
    const spans = readSpans(tmpAuditDir);
    for (const s of spans) {
      expect(s.purpose).toBe('STDIO-489');
    }
  });

  it('openSpan returns purpose for use in childContext', () => {
    process.env.AIGENCY_AUDIT_PURPOSE = 'STDIO-489';
    const span = openSpan('tool:delegate', 'tool');
    expect(span.purpose).toBe('STDIO-489');
    span.finish();
  });
});
