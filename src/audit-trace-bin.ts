#!/usr/bin/env node
// verevoir-audit-trace (STDIO-486/STDIO-489/STDIO-506) — convert a session JSONL
// audit file into a format suitable for interactive flame-chart inspection.
//
// Usage:
//   verevoir-audit-trace <session.jsonl>              # → Chrome Trace JSON (stdout)
//   verevoir-audit-trace <session.jsonl> --otlp       # → OTLP JSON (stdout)
//   verevoir-audit-trace <session.jsonl> -o out.json  # write to file instead of stdout
//   verevoir-audit-trace <session.jsonl> --elide-notes  # suppress note/purpose in output
//   verevoir-audit-trace <session.jsonl> --by cost    # weight the flame by USD cost,
//                                                     # not wall-clock time ("where did
//                                                     # the money go") — STDIO-506
//   verevoir-audit-trace <transcript.jsonl> --from-claude-transcript
//                                                     # treat the input as a Claude Code
//                                                     # session transcript and convert it
//                                                     # to spans before tracing (STDIO-502)
//
// Open the Chrome Trace output at:
//   speedscope.app  (drop the file)
//   Perfetto        (ui.perfetto.dev → Open Trace File)
//   chrome://tracing → Load
//
// Open the OTLP output in Datadog / Jaeger / Grafana Tempo after importing.
//
// Weighting (--by, STDIO-506):
//   time (default) — the real timeline: ts from `start`, dur from `duration_ms`.
//   cost           — re-lay-out the cascade by money. Cost isn't a timeline, so
//                    each span's width becomes its rolled-up USD cost and the
//                    children are packed left-to-right inside the parent. The
//                    Chrome-trace view is the priority; for --otlp the same
//                    re-laid-out start/duration is emitted so a backend that
//                    reads OTLP still sees the money weighting.
//
// Pure transform, no deps beyond stdlib.
//
// Sensitive-data note (STDIO-489 / telemetry-excludes-sensitive-data):
//   The `note` field on spans derived from task/prompt args may contain
//   excerpts of LLM prompt content (truncated to 120 chars, first line only).
//   Path-derived notes are structural identifiers and are safe.
//   When exporting to an OTLP backend (Datadog / Jaeger / Tempo), prompt
//   excerpts travel outside the local machine. Operators who treat prompt
//   content as sensitive should pass `--elide-notes` to suppress note and
//   purpose fields from the OTLP export. The local JSONL is unaffected.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AuditSpan } from './audit.js';
import { auditSpansToOtlp } from './otlp.js';
import { claudeTranscriptToSpans } from './claude-transcript.js';
import { spanCostUsd, relayoutByCost, type WeightBy } from './audit-cost.js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function usage(): void {
  process.stderr.write(
    'Usage: verevoir-audit-trace <session.jsonl> [--otlp] [--elide-notes] [--by time|cost] [--from-claude-transcript] [-o <output.json>]\n' +
      '\n' +
      'Converts a session audit JSONL file to a flame-chart format.\n' +
      '\n' +
      'Options:\n' +
      '  --otlp                    Emit OTLP JSON instead of Chrome Trace format.\n' +
      '  --elide-notes             Omit note and purpose fields from output (for OTLP\n' +
      '                            export when prompt content is considered sensitive).\n' +
      '  --by time|cost            Weight the flame by wall-clock TIME (default) or by\n' +
      '                            USD COST. Cost re-lays-out the cascade so each span\n' +
      '                            is as wide as its rolled-up cost — "where did the\n' +
      '                            money go\". Cost is read from a span attribute when\n' +
      '                            present, else computed from token attributes.\n' +
      '  --from-claude-transcript  Treat the input as a Claude Code session transcript\n' +
      '                            (JSONL) and convert it to audit spans before tracing,\n' +
      '                            so a Claude-Code-native run renders as a flame chart.\n' +
      '  -o <file>                 Write output to <file> instead of stdout.\n' +
      '\n' +
      'View Chrome Trace output at speedscope.app, Perfetto (ui.perfetto.dev),\n' +
      'or chrome://tracing.\n' +
      'View OTLP JSON in Datadog, Jaeger, or Grafana Tempo.\n'
  );
}

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(args.length === 0 ? 1 : 0);
}

const otlpMode = args.includes('--otlp');
const elideNotes = args.includes('--elide-notes');
const fromClaudeTranscript = args.includes('--from-claude-transcript');
const outIdx = args.indexOf('-o');
const outputFile = outIdx >= 0 ? args[outIdx + 1] : null;

// --by <time|cost> (default time). An unrecognised value is rejected loudly
// rather than silently treated as time, so a typo can't quietly mislead.
const byIdx = args.indexOf('--by');
const byRaw = byIdx >= 0 ? args[byIdx + 1] : 'time';
if (byRaw !== 'time' && byRaw !== 'cost') {
  process.stderr.write(`Error: --by must be 'time' or 'cost', got '${byRaw ?? ''}'.\n`);
  usage();
  process.exit(1);
}
const weightBy: WeightBy = byRaw;

// Positional input: the first arg that isn't a flag and isn't the value of a
// flag that takes one (-o / --by).
const flagValues = new Set<string>();
if (outputFile) flagValues.add(outputFile);
if (byIdx >= 0 && args[byIdx + 1]) flagValues.add(args[byIdx + 1]);
const inputFile = args.find((a) => !a.startsWith('-') && !flagValues.has(a));

if (!inputFile) {
  process.stderr.write('Error: no input file specified.\n');
  usage();
  process.exit(1);
}

// ── Load spans ────────────────────────────────────────────────────────────────

function loadSpans(path: string): AuditSpan[] {
  const text = readFileSync(resolve(path), 'utf8');
  const spans: AuditSpan[] = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      spans.push(JSON.parse(l) as AuditSpan);
    } catch {
      process.stderr.write(`warn: skipping malformed JSONL line: ${l.slice(0, 80)}\n`);
    }
  }
  return spans;
}

// ── Chrome Trace Event format ─────────────────────────────────────────────────
// https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
// "X" = complete events (start + duration). Each span → one "X" event.
// `pid`/`tid` are used by chrome://tracing / speedscope for swim-lane grouping:
//   pid = the trace_id hash (one process per session)
//   tid = a stable integer per span kind (tool=1, capability=2, model=3)
// This puts the cascade in one swim lane per kind, with the duration bar showing
// parent-child nesting via the `id`/`pid_for_stack` fields (not standard but
// speedscope handles it gracefully).
//
// Cost weighting (--by cost, STDIO-506): the ts/dur a span carries are no longer
// the timeline — they come from `relayoutByCost`, which sets ts = µ-dollar
// offset and dur = µ-dollars of rolled-up cost. The unit is µ-dollars (round(usd
// × 1e6), so $0.01 → 10000) — self-consistent within the cost view, mirroring
// how the time view multiplies ms → µs by 1000.

interface ChromeTraceEvent {
  name: string;
  ph: 'X';
  ts: number; // microseconds from epoch (time) | µ-dollar offset (cost)
  dur: number; // microseconds (time) | µ-dollars (cost)
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
}

const KIND_TID: Record<string, number> = { tool: 1, capability: 2, model: 3 };

function toChromeTrace(
  spans: AuditSpan[],
  opts: { elideNotes?: boolean; by?: WeightBy } = {}
): { traceEvents: ChromeTraceEvent[] } {
  const by = opts.by ?? 'time';
  // In cost mode the timeline is re-derived from cost; `layout` holds the
  // ts/dur (µ-dollars) per span_id, and each span carries its own USD cost.
  const layout = by === 'cost' ? relayoutByCost(spans) : null;
  const traceEvents: ChromeTraceEvent[] = spans.map((s) => {
    const pid = hashPid(s.trace_id);
    const tid = KIND_TID[s.kind] ?? 4;
    const args: Record<string, unknown> = {
      span_id: s.span_id,
      ...(s.parent_span_id ? { parent_span_id: s.parent_span_id } : {}),
      ...(s.attributes ?? {}),
    };
    // Include note and purpose in Chrome Trace args so speedscope / Perfetto
    // display them in the detail panel when a frame is selected.
    if (!opts.elideNotes) {
      if (s.note) args['note'] = s.note;
      if (s.purpose) args['purpose'] = s.purpose;
    }
    let ts: number;
    let dur: number;
    if (layout) {
      // Cost view: ts/dur are the cost-derived µ-dollar layout. Surface the
      // span's own USD cost in the detail panel so a selected frame reads as
      // money, not microseconds.
      const placed = layout.get(s.span_id);
      ts = placed ? placed.ts : 0;
      dur = placed ? placed.dur : 0;
      args['cost_usd'] = spanCostUsd(s);
    } else {
      // Time view (default): the real timeline, ms → µs.
      ts = Date.parse(s.start) * 1000;
      dur = s.duration_ms * 1000;
    }
    // Enrich the displayed frame name with the note so it is visible in the
    // timeline without opening the detail panel (e.g. "write_file → src/a.ts").
    const name = !opts.elideNotes && s.note ? `${s.name} → ${s.note}` : s.name;
    return { name, ph: 'X', ts, dur, pid, tid, args };
  });
  return { traceEvents };
}

/** Stable 31-bit hash of a string — used as Chrome Trace `pid` so sessions
 * have distinct swim lanes. Not cryptographic; collision is cosmetic only. */
function hashPid(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) & 0x7fffffff;
}

// OTLP mapping now lives in ./otlp.ts (shared with the live exporter in
// audit.ts — STDIO-502). See `auditSpansToOtlp`, imported above. For --by cost
// the spans are re-laid-out by cost first (see `costRelaidSpans`), so the OTLP
// timestamps carry the same money weighting as the Chrome-trace view.

/** Rewrite each span's start/end/duration_ms from the cost layout, so the OTLP
 * path (which reads those fields) carries the money weighting. The unit is
 * µ-dollars expressed as ms (a span's dur in ms == its µ-dollars), keeping the
 * cost in `attributes.cost` for the detail view. */
function costRelaidSpans(spans: AuditSpan[]): AuditSpan[] {
  const layout = relayoutByCost(spans);
  return spans.map((s) => {
    const placed = layout.get(s.span_id);
    const startMs = placed ? placed.ts : 0;
    const durMs = placed ? placed.dur : 0;
    return {
      ...s,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + durMs).toISOString(),
      duration_ms: durMs,
      attributes: { ...(s.attributes ?? {}), cost: spanCostUsd(s) },
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

// --from-claude-transcript swaps the *source* of spans (a Claude Code session
// transcript converted to spans) for the native JSONL audit log; everything
// downstream (Chrome trace / OTLP / --elide-notes / -o / --by) is unchanged.
const spans = fromClaudeTranscript
  ? claudeTranscriptToSpans(readFileSync(resolve(inputFile), 'utf8'))
  : loadSpans(inputFile);
if (spans.length === 0) {
  process.stderr.write('warn: no spans found in the input file.\n');
}

const converterOpts = { elideNotes };
let output: unknown;
if (otlpMode) {
  // OTLP: in cost mode, re-lay-out the spans first so the emitted timestamps
  // reflect money, not time (Chrome trace is the priority view, but the cost
  // weighting still travels through OTLP).
  output = auditSpansToOtlp(weightBy === 'cost' ? costRelaidSpans(spans) : spans, converterOpts);
} else {
  output = toChromeTrace(spans, { ...converterOpts, by: weightBy });
}
const json = JSON.stringify(output, null, 2);

if (outputFile) {
  writeFileSync(resolve(outputFile), json, 'utf8');
  process.stderr.write(`wrote ${spans.length} span(s) to ${outputFile}\n`);
} else {
  process.stdout.write(json + '\n');
}
