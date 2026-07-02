import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { otlpEnvelope, auditSpanToOtlp } from './otlp.js';

// AUDIT LOG (STDIO-486) — per-session JSONL file, OpenTelemetry-shaped spans.
//
// Three modes, set via AIGENCY_AUDIT:
//   'off'     — nothing written (default).
//   'on'      — span fields only: trace_id, span_id, parent_span_id, name,
//               kind, start, end, duration_ms, note (when derivable).
//   'verbose' — the above plus an `attributes` object: model, tokens_in,
//               tokens_out, cached, cost per span, and a capability-level
//               cost rollup on the root span.
//
// Session: a burst of activity within AIGENCY_AUDIT_SESSION_GAP seconds of
// the previous entry (default 120s). A gap wider than that starts a new file
// named by the session-start ISO timestamp. One prompt's whole cascade lands
// in one file so the parent_span_id chain is reconstructable.
//
// Zero dependencies: timestamps, append, gap-detection — pure Node stdlib.
// The verbose attributes record only usage the provider already returned;
// no tokens are spent to produce them.
//
// STDIO-489 additions:
//   note — optional per-span context (derived from tool args, zero-token).
//   purpose — root-span label read from AIGENCY_AUDIT_PURPOSE env and
//             inherited by child spans via SpanContext (set once, read-only).

export type AuditMode = 'off' | 'on' | 'verbose';
const AUDIT_MODES: AuditMode[] = ['off', 'on', 'verbose'];

/** Span kinds in the cascade. */
export type SpanKind = 'capability' | 'tool' | 'model';

// ── Note derivation (STDIO-489) ───────────────────────────────────────────────
// A small, zero-token arg-extractor: derives a single salient string (the
// `note`) from a tool call's arguments. Turns `tool:write_file` into a line
// that reads `write_file → src/auth/login.ts`. Applied at `on` mode so it is
// always visible, never gated to `verbose`.
//
// Guard rails — all applied in `deriveNote`:
//   - Never throws: an absent/oddly-shaped arg yields no note.
//   - Length-capped at NOTE_MAX_CHARS grapheme clusters.
//   - Single-line: newlines collapsed to a space before the cap.
//   - Pure scripting: no model calls, no async, no external deps.
//
// OTLP / sensitive-data note (telemetry-excludes-sensitive-data):
//   Notes derived from file paths are structural identifiers (safe).
//   Notes derived from task/prompt text (delegate / dispatch / refine /
//   search) are truncated excerpts of LLM prompt content, which MAY contain
//   user-supplied data. The local JSONL is fine for all notes. However, when
//   OTLP export is enabled (verevoir-audit-trace --otlp) the note is emitted
//   as a span attribute and shipped to the configured backend (Datadog /
//   Jaeger / Grafana Tempo). Operators who consider prompt content sensitive
//   should either (a) redact the note at export time with the
//   `--elide-notes` flag (see audit-trace-bin.ts) or (b) avoid OTLP export
//   of session files that include prompt-derived notes.

/** Maximum grapheme-cluster length for a derived note. */
export const NOTE_MAX_CHARS = 120;

/** A static map from tool name → the argument key(s) that yield the note.
 * `path` tools use path; `task` tools use prompt/task text (first line,
 * truncated). Extend here as new tools are instrumented. */
const NOTE_ARG_KEYS: Record<string, string[]> = {
  write_file: ['path'],
  edit_file: ['path'],
  read_file: ['path'],
  grep: ['pattern', 'path'],
  find_symbol: ['name', 'path'],
  open_pull_request: ['title'],
  delegate: ['prompt'],
  dispatch: ['prompt'],
  refine: ['task'],
  search: ['task'],
  refine_start: ['task'],
  search_start: ['task'],
};

/**
 * Safely truncate `s` to at most `max` grapheme clusters, collapsing all
 * newlines to a single space first. Grapheme-safe in V8 via Intl.Segmenter
 * (Node ≥ 16); falls back to a simple slice if Segmenter is absent (no older
 * runtime support is promised but the fallback never throws).
 */
export function truncateNote(s: string, max: number = NOTE_MAX_CHARS): string {
  // Collapse all newline variants to a space and trim runs of whitespace.
  const oneLine = s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  if (oneLine.length === 0) return '';
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const clusters = [...seg.segment(oneLine)];
    if (clusters.length <= max) return oneLine;
    return clusters
      .slice(0, max)
      .map((g) => g.segment)
      .join('')
      .trimEnd();
  } catch {
    // Intl.Segmenter absent or threw — plain character-slice as fallback.
    return oneLine.length <= max ? oneLine : oneLine.slice(0, max).trimEnd();
  }
}

/**
 * Derive a salient one-line note from a tool name + its call arguments.
 * Returns `undefined` (no note) when nothing useful can be derived.
 * Never throws — any odd shape or missing key yields `undefined`.
 *
 * @param toolName  The short tool name (e.g. `write_file`, `delegate`).
 * @param args      The raw arguments object from the tool call.
 */
export function deriveNote(
  toolName: string,
  args: Record<string, unknown> | undefined
): string | undefined {
  try {
    if (!args) return undefined;
    const keys = NOTE_ARG_KEYS[toolName];
    if (!keys || keys.length === 0) return undefined;
    for (const key of keys) {
      const raw = args[key];
      if (raw === undefined || raw === null) continue;
      const s = String(raw);
      if (s.trim().length === 0) continue;
      // For task/prompt fields: take only the first non-empty line so a
      // multi-paragraph prompt doesn't dominate the note.
      const firstLine = s.split(/[\r\n]+/)[0] ?? s;
      const note = truncateNote(firstLine.trim());
      if (note.length > 0) return note;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The shape of one JSONL entry (OTel-shaped). `attributes` is present only
 * in verbose mode and only when the span has usage to report. `note` is an
 * optional one-line context string present in `on` and `verbose` modes when
 * a salient arg can be derived from the tool call. */
export interface AuditSpan {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  name: string;
  kind: SpanKind;
  /** Optional one-line context derived from the tool call's salient argument
   * (e.g. a file path, a PR title, or the first line of a task). Never
   * present when nothing useful can be derived. Set at `on` mode (not gated
   * to `verbose`). See the OTLP/sensitive-data note at the top of this file
   * for export guidance. */
  note?: string;
  /** The run's ambient purpose, propagated from AIGENCY_AUDIT_PURPOSE env
   * (or explicitly via SpanContext). Absent when not set. */
  purpose?: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  duration_ms: number;
  attributes?: {
    model?: string;
    tokens_in?: number;
    tokens_out?: number;
    cached?: number;
    cost?: number;
    cost_rollup?: number; // capability-level total cost
  };
}

/** Resolved audit configuration, derived from env at startup. */
export interface AuditConfig {
  mode: AuditMode;
  dir: string;
  sessionGapMs: number;
  /** OTLP collector endpoint (OTEL_EXPORTER_OTLP_ENDPOINT). When set and mode
   * is not 'off', each span is ALSO POSTed live to `<endpoint>/v1/traces`
   * (STDIO-502) — the unified-trace path, alongside the local JSONL. Null =
   * JSONL only. */
  otlpEndpoint?: string | null;
}

/** Resolve audit config from env. Safe to call at module load — reads process.env
 * lazily, so tests can set vars before the first call. */
export function resolveAuditConfig(): AuditConfig {
  const raw = process.env.AIGENCY_AUDIT?.trim() as AuditMode | undefined;
  const mode: AuditMode = raw && AUDIT_MODES.includes(raw) ? raw : 'off';
  const dir = process.env.AIGENCY_AUDIT_DIR?.trim() || './aigency-audit';
  const gapRaw = Number(process.env.AIGENCY_AUDIT_SESSION_GAP ?? '');
  const sessionGapMs = Number.isFinite(gapRaw) && gapRaw > 0 ? gapRaw * 1000 : 120_000;
  // The standard OTel env, so the MCP, Claude Code, and the executor can all be
  // pointed at one collector with a single variable (STDIO-502).
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || null;
  return { mode, dir, sessionGapMs, otlpEndpoint };
}

// ── Session state ─────────────────────────────────────────────────────────────
// In-process: one MCP server process = one audit writer. State is intentionally
// module-level so the session file accumulates across tool calls in a single
// session and resets only when the gap-detection fires.

let _config: AuditConfig | null = null;
let _sessionFile: string | null = null;
let _sessionId: string | null = null;
let _lastEntryAt = 0;

/** The config, resolved once and cached. Injectable for tests via resetAudit(). */
function config(): AuditConfig {
  if (!_config) _config = resolveAuditConfig();
  return _config;
}

/** Ensure the session is current, starting a new one if the gap has expired.
 * Returns the current session file path, or null when mode is off. On a new
 * session the `_sessionId` and `_sessionFile` are refreshed; the directory is
 * NOT created here — that happens lazily in `appendSpan`, so a bad dir can't
 * surface as a mkdirSync error from inside `openSpan`.
 *
 * Gap check: a span is "within the session" if we've seen an entry recently —
 * either an appended span (`_lastEntryAt` set by appendSpan) OR an opened-but-
 * not-yet-finished span (`_sessionActive` is true). This covers the window
 * between openSpan and its corresponding finish() call. */
let _sessionActive = false; // true while at least one span is open

function sessionFile(): string | null {
  const cfg = config();
  if (cfg.mode === 'off') return null;
  const now = Date.now();
  const withinGap =
    _sessionFile && _sessionId && (now - _lastEntryAt < cfg.sessionGapMs || _sessionActive);
  if (withinGap) {
    return _sessionFile;
  }
  // New session: a gap wider than the threshold, or first call ever.
  _sessionId = randomUUID();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(cfg.dir);
  _sessionFile = join(dir, `session-${ts}.jsonl`);
  // Seed _lastEntryAt so the gap check stays within this session from the
  // first openSpan to the first appendSpan (which would otherwise see an
  // epoch-relative gap of billions of ms and start a NEW session on write).
  _lastEntryAt = Date.now();
  return _sessionFile;
}

/** The current session trace_id (= session id). Null when audit is off or
 * before the first span of a session. */
export function currentSessionId(): string | null {
  return _sessionId;
}

/** Test seam: reset all session state and optionally override the config. */
export function resetAudit(cfg?: AuditConfig): void {
  _config = cfg ?? null;
  _sessionFile = null;
  _sessionId = null;
  _lastEntryAt = 0;
  _sessionActive = false;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Append one span to the current session file. No-op when mode is 'off' or
 * the write fails (best-effort: audit must never interfere with tool results).
 * The directory is created lazily here, not in sessionFile(), so a bad dir
 * is caught and silently dropped rather than surfaced as an error mid-tool. */
/** Live OTLP export (STDIO-502) — when OTEL_EXPORTER_OTLP_ENDPOINT is set, POST
 * the span to the collector at `<endpoint>/v1/traces`. Fire-and-forget +
 * fail-soft: a slow/unreachable collector must never block a tool or throw into
 * its result path (the same best-effort contract as the JSONL write). */
function exportSpanOtlp(span: AuditSpan): void {
  const endpoint = config().otlpEndpoint;
  if (!endpoint) return;
  try {
    const body = JSON.stringify(otlpEnvelope([auditSpanToOtlp(span)]));
    void fetch(`${endpoint.replace(/\/+$/, '')}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }).catch(() => {
      // collector down / unreachable → drop silently
    });
  } catch {
    // best-effort: never let export break the tool path
  }
}

export function appendSpan(span: AuditSpan): void {
  const file = sessionFile();
  if (!file) return;
  _lastEntryAt = Date.now();
  try {
    mkdirSync(resolve(config().dir), { recursive: true });
    appendFileSync(file, JSON.stringify(span) + '\n');
  } catch {
    // Silently drop: a permissions issue or a full disk must not surface as a
    // tool error — the audit log is observability, not the main path.
  }
  // Live OTLP stream (STDIO-502): additive to the JSONL, fires only when an
  // OTLP endpoint is configured. Fire-and-forget; never blocks the tool path.
  exportSpanOtlp(span);
}

// ── Span builder ──────────────────────────────────────────────────────────────

/** Millisecond-precision ISO timestamp. */
function nowIso(): string {
  return new Date().toISOString();
}

// ── Purpose resolution (STDIO-489) ───────────────────────────────────────────
// A run's ambient purpose labels the ROOT span (and is propagated to children
// via SpanContext). The cheapest consistent source is an env var set before
// the MCP server starts; the context propagation carries it from there.

/** Read the ambient audit purpose from the environment. Returns undefined when
 * the var is absent or blank — callers should treat absence as "no purpose". */
export function resolveAuditPurpose(): string | undefined {
  const raw = process.env.AIGENCY_AUDIT_PURPOSE?.trim();
  return raw && raw.length > 0 ? truncateNote(raw, NOTE_MAX_CHARS) : undefined;
}

/** Open a span, returning a `finish` function that writes it. Usage is
 * optional; when supplied and the mode is verbose it lands in `attributes`.
 * `traceId` defaults to the current session id; `parentId` threads the
 * cascade so the flame chart reconstructs from parent refs.
 *
 * STDIO-489 additions:
 *   `note`    — an optional one-line context string (e.g. a file path or
 *               truncated task). Written at `on` mode; skip for spans where
 *               nothing useful is known at open time.
 *   `purpose` — inherited from `SpanContext` or resolved from env. Set on
 *               root spans; propagated to children via `childContext`. */
export function openSpan(
  name: string,
  kind: SpanKind,
  opts: {
    traceId?: string;
    parentId?: string;
    /** One-line context derived from the tool call's salient arg. */
    note?: string;
    /** Ambient run purpose (from SpanContext or AIGENCY_AUDIT_PURPOSE env). */
    purpose?: string;
  } = {}
): {
  spanId: string;
  traceId: string;
  /** Purpose carried by this span (for propagation via childContext). */
  purpose?: string;
  finish: (attrs?: AuditSpan['attributes']) => void;
} {
  const startMs = Date.now();
  const startIso = nowIso();
  const spanId = randomUUID();
  // Ensure the session is initialised BEFORE reading _sessionId, so that the
  // first call of a new session has _sessionId set before we capture traceId.
  sessionFile();
  // Mark a span as open so the session gap check knows the session is active
  // even before finish() triggers appendSpan (which updates _lastEntryAt).
  _sessionActive = true;
  const traceId = opts.traceId ?? _sessionId ?? randomUUID();
  // Purpose: explicit opt wins; else fall back to the env var (root spans).
  // Children should pass it via SpanContext / childContext, not re-read env.
  const purpose = opts.purpose ?? resolveAuditPurpose();

  return {
    spanId,
    traceId,
    purpose,
    finish: (attrs?: AuditSpan['attributes']) => {
      _sessionActive = false;
      const endMs = Date.now();
      const endIso = new Date(endMs).toISOString();
      const span: AuditSpan = {
        trace_id: traceId,
        span_id: spanId,
        ...(opts.parentId ? { parent_span_id: opts.parentId } : {}),
        name,
        kind,
        ...(opts.note ? { note: opts.note } : {}),
        ...(purpose ? { purpose } : {}),
        start: startIso,
        end: endIso,
        duration_ms: endMs - startMs,
      };
      if (attrs && Object.keys(attrs).length > 0) {
        const cfg = config();
        if (cfg.mode === 'verbose') {
          span.attributes = attrs;
        }
      }
      appendSpan(span);
    },
  };
}

// ── Context propagation helpers ───────────────────────────────────────────────
// Thread trace_id + parent_span_id + purpose from the capability root through
// every nested span, so the parent_span_id chain reconstructs the cascade and
// the run's ambient purpose appears on every span without repeated env reads.

export interface SpanContext {
  traceId: string;
  parentId?: string;
  /** Propagated ambient purpose (from AIGENCY_AUDIT_PURPOSE or explicit). */
  purpose?: string;
}

/** Build a child context from a parent span, for threading into nested calls.
 * Purpose is inherited: if the parent carried one it flows to every child. */
export function childContext(parent: {
  traceId: string;
  spanId: string;
  purpose?: string;
}): SpanContext {
  return {
    traceId: parent.traceId,
    parentId: parent.spanId,
    ...(parent.purpose ? { purpose: parent.purpose } : {}),
  };
}
