// Claude Code transcript → audit spans (STDIO-502, "Route 1").
//
// OTel (Route 0) gives Claude Code's cost *metrics*, but not a span *timeline*.
// This converter fills that gap: it turns a Claude Code session transcript
// (the JSONL Claude Code writes per session) into the same AuditSpan shape the
// MCP's own cascade emits, so a Claude-Code-native run renders as a flame chart
// through the existing verevoir-audit-trace pipeline — and it works
// retroactively on any past session transcript.
//
// Pure transform, zero dependencies: text in, spans out. The whole downstream
// (Chrome trace / OTLP / --elide-notes / -o) is reused unchanged once the spans
// exist.
//
// Transcript schema (JSONL, one entry per line):
//   - Assistant turn: type === 'assistant', with top-level uuid, parentUuid
//     (absent on the root), timestamp (ISO 8601), sessionId, isSidechain
//     (subagent turns), and message: { model, usage, content }. usage =
//     { input_tokens, output_tokens, cache_read_input_tokens,
//       cache_creation_input_tokens }. content is an array of blocks.
//   - Blocks: { type: 'tool_use', id, name, input } (in assistant turns) and
//     { type: 'tool_result', tool_use_id, content, is_error } (in user entries).

import type { AuditSpan } from './audit.js';
import { truncateNote } from './audit.js';

const TRACE_FALLBACK = 'claude-session';

/** A single parsed transcript entry. Only the fields this converter reads are
 * typed; everything else on the line is ignored. All fields are optional so a
 * malformed or partial line never trips a type assertion at use sites. */
interface TranscriptEntry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    content?: unknown;
  };
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

/** The tool-arg keys that yield a salient note, in preference order. Claude's
 * tool names map onto these: Bash → command, Read/Write/Edit → file_path,
 * Task → description, Grep → pattern. Anything else falls back to the first
 * string-valued input. */
const NOTE_PREFERRED_KEYS = ['command', 'file_path', 'description', 'pattern'];

/** Parse the transcript text into entries, skipping any line that is blank or
 * not valid JSON. Never throws — an odd line is dropped, mirroring loadSpans'
 * skip-malformed behaviour in audit-trace-bin.ts. */
function parseEntries(transcript: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of transcript.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      const parsed = JSON.parse(l);
      if (parsed && typeof parsed === 'object') entries.push(parsed as TranscriptEntry);
    } catch {
      // Drop malformed lines silently — the converter must never throw on an
      // odd line (a partial flush, a non-JSON marker, etc.).
    }
  }
  return entries;
}

/** The content blocks of an entry, or an empty array when absent / malformed. */
function contentBlocks(entry: TranscriptEntry): Array<Record<string, unknown>> {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object');
}

/** Build a map from tool_use_id → the timestamp of the entry carrying its
 * matching tool_result block, so a tool span can be closed at the moment its
 * result arrived. Scans every entry's content (tool_result blocks live on
 * `user` entries). */
function buildToolResultTimestamps(entries: TranscriptEntry[]): Map<string, number> {
  const resultAt = new Map<string, number>();
  for (const entry of entries) {
    const ts = Date.parse(entry.timestamp ?? '');
    if (Number.isNaN(ts)) continue;
    for (const block of contentBlocks(entry)) {
      if (block['type'] === 'tool_result') {
        const id = block['tool_use_id'];
        if (typeof id === 'string' && !resultAt.has(id)) resultAt.set(id, ts);
      }
    }
  }
  return resultAt;
}

/** Derive a short, one-line note from a tool_use block's input. Prefers the
 * tool-specific key (command / file_path / description / pattern), else the
 * first string-valued input. Returns undefined when nothing useful is present.
 * Never throws. */
function noteFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of NOTE_PREFERRED_KEYS) {
    const raw = input[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return truncateNote(raw);
  }
  for (const raw of Object.values(input)) {
    if (typeof raw === 'string' && raw.trim().length > 0) return truncateNote(raw);
  }
  return undefined;
}

/**
 * Convert a Claude Code session transcript (JSONL text) into audit spans.
 *
 * Each assistant turn that carries usage becomes a `model` span; each
 * `tool_use` block within that turn becomes a `tool` span parented to the turn.
 * A turn's `parentUuid` threads the cascade — including subagent (`isSidechain`)
 * turns, which need no special handling because their parentUuid already points
 * back into the main thread.
 *
 * Durations are reconstructed from timestamps: a turn's duration is the gap
 * since the previous entry (the think + generate window), floored at 1ms; a
 * tool's duration runs from its turn's timestamp to its matching tool_result's
 * timestamp.
 *
 * Pure: the same transcript always yields the same spans. Entries without a
 * parseable timestamp, or assistant turns without usage, are skipped gracefully.
 */
export function claudeTranscriptToSpans(transcript: string): AuditSpan[] {
  const entries = parseEntries(transcript);
  const toolResultAt = buildToolResultTimestamps(entries);
  const spans: AuditSpan[] = [];

  let prevTs: number | null = null;

  for (const entry of entries) {
    const thisTs = Date.parse(entry.timestamp ?? '');
    if (Number.isNaN(thisTs)) continue;

    const isAssistantTurn = entry.type === 'assistant' && !!entry.message?.usage;
    if (!isAssistantTurn) {
      // Non-assistant (or usage-less) entries still advance the clock so the
      // next turn's gap is measured from the right point.
      prevTs = thisTs;
      continue;
    }

    const uuid = entry.uuid;
    if (typeof uuid !== 'string' || uuid.length === 0) {
      prevTs = thisTs;
      continue;
    }

    const traceId = entry.sessionId || TRACE_FALLBACK;
    const usage = entry.message!.usage!;
    const model = entry.message?.model ?? 'unknown';

    // The think + generate window: the gap since the previous entry. The first
    // turn (no previous entry) gets a nominal 1ms so it still renders.
    const turnDuration = prevTs === null ? 1 : Math.max(1, thisTs - prevTs);
    const turnStartMs = thisTs - turnDuration;

    spans.push({
      trace_id: traceId,
      span_id: uuid,
      ...(typeof entry.parentUuid === 'string' && entry.parentUuid.length > 0
        ? { parent_span_id: entry.parentUuid }
        : {}),
      name: model,
      kind: 'model',
      start: new Date(turnStartMs).toISOString(),
      end: new Date(thisTs).toISOString(),
      duration_ms: turnDuration,
      attributes: {
        ...(model ? { model } : {}),
        ...(typeof usage.input_tokens === 'number' ? { tokens_in: usage.input_tokens } : {}),
        ...(typeof usage.output_tokens === 'number' ? { tokens_out: usage.output_tokens } : {}),
        ...(typeof usage.cache_read_input_tokens === 'number'
          ? { cached: usage.cache_read_input_tokens }
          : {}),
      },
    });

    for (const block of contentBlocks(entry)) {
      if (block['type'] !== 'tool_use') continue;
      const toolUse = block as unknown as ToolUseBlock;
      if (typeof toolUse.id !== 'string' || typeof toolUse.name !== 'string') continue;

      const endMs = toolResultAt.get(toolUse.id) ?? thisTs;
      const toolDuration = Math.max(1, endMs - thisTs);
      const note = noteFromInput(toolUse.input);

      spans.push({
        trace_id: traceId,
        span_id: toolUse.id,
        parent_span_id: uuid,
        name: toolUse.name,
        kind: 'tool',
        ...(note ? { note } : {}),
        start: new Date(thisTs).toISOString(),
        end: new Date(thisTs + toolDuration).toISOString(),
        duration_ms: toolDuration,
      });
    }

    prevTs = thisTs;
  }

  return spans;
}
