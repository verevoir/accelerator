import { describe, it, expect } from 'vitest';
import { claudeTranscriptToSpans } from '../src/claude-transcript.js';
import type { AuditSpan } from '../src/audit.js';

// Tests for the Claude Code transcript → audit-spans converter (STDIO-502).
// Driven entirely through the public claudeTranscriptToSpans(text) interface:
// a synthetic transcript in, the spans out. No internals are reached into, so a
// refactor that preserves the mapping keeps these green.

// ── Fixture: a small but representative transcript ────────────────────────────
// Two assistant turns (each with model + usage), the first carrying a Bash
// tool_use; a following user entry with the matching tool_result; and a
// subagent (isSidechain) assistant turn whose parentUuid points at the first
// turn. Built as objects then serialised so the shape stays readable.

const SESSION = 'sess-1234';

const TURN_ONE = {
  type: 'assistant',
  uuid: 'turn-1',
  timestamp: '2026-06-30T10:00:01.000Z',
  sessionId: SESSION,
  isSidechain: false,
  message: {
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100,
    },
    content: [
      { type: 'text', text: 'Running the build.' },
      { type: 'tool_use', id: 'tool-bash-1', name: 'Bash', input: { command: 'npm run build' } },
    ],
  },
};

const TOOL_RESULT = {
  type: 'user',
  uuid: 'user-1',
  parentUuid: 'turn-1',
  timestamp: '2026-06-30T10:00:03.500Z',
  sessionId: SESSION,
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'tool-bash-1', content: 'ok', is_error: false }],
  },
};

const TURN_TWO = {
  type: 'assistant',
  uuid: 'turn-2',
  parentUuid: 'user-1',
  timestamp: '2026-06-30T10:00:05.000Z',
  sessionId: SESSION,
  isSidechain: false,
  message: {
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 400, output_tokens: 150, cache_read_input_tokens: 0 },
    content: [{ type: 'text', text: 'Done.' }],
  },
};

const SIDECHAIN_TURN = {
  type: 'assistant',
  uuid: 'sidechain-1',
  parentUuid: 'turn-1',
  timestamp: '2026-06-30T10:00:06.000Z',
  sessionId: SESSION,
  isSidechain: true,
  message: {
    model: 'claude-sonnet-4-5',
    usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 0 },
    content: [{ type: 'text', text: 'Subagent reporting.' }],
  },
};

function transcriptOf(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

const FULL_TRANSCRIPT = transcriptOf(TURN_ONE, TOOL_RESULT, TURN_TWO, SIDECHAIN_TURN);

function spanById(spans: AuditSpan[], id: string): AuditSpan | undefined {
  return spans.find((s) => s.span_id === id);
}

describe('claudeTranscriptToSpans', () => {
  it('emits a model span for each assistant turn with usage', () => {
    const spans = claudeTranscriptToSpans(FULL_TRANSCRIPT);
    const modelSpans = spans.filter((s) => s.kind === 'model');
    expect(modelSpans.map((s) => s.span_id).sort()).toEqual(
      ['sidechain-1', 'turn-1', 'turn-2'].sort()
    );
  });

  it('carries the turn model and token usage as span attributes', () => {
    const turn = spanById(claudeTranscriptToSpans(FULL_TRANSCRIPT), 'turn-1');
    expect(turn).toMatchObject({
      kind: 'model',
      name: 'claude-opus-4-8',
      attributes: { model: 'claude-opus-4-8', tokens_in: 1200, tokens_out: 300, cached: 800 },
    });
  });

  it('emits a tool span parented to the turn that issued the tool_use', () => {
    const tool = spanById(claudeTranscriptToSpans(FULL_TRANSCRIPT), 'tool-bash-1');
    expect(tool).toMatchObject({ kind: 'tool', name: 'Bash', parent_span_id: 'turn-1' });
  });

  it("derives the tool note from a Bash tool_use's command", () => {
    const tool = spanById(claudeTranscriptToSpans(FULL_TRANSCRIPT), 'tool-bash-1');
    expect(tool?.note).toBe('npm run build');
  });

  it('closes a tool span at its matching tool_result timestamp', () => {
    const tool = spanById(claudeTranscriptToSpans(FULL_TRANSCRIPT), 'tool-bash-1');
    // turn at 10:00:01, result at 10:00:03.5 → 2500ms.
    expect(tool?.duration_ms).toBe(2500);
  });

  it('gives every span a positive duration', () => {
    const spans = claudeTranscriptToSpans(FULL_TRANSCRIPT);
    expect(spans.every((s) => s.duration_ms > 0)).toBe(true);
  });

  it('uses the sessionId as the trace_id for every span', () => {
    const spans = claudeTranscriptToSpans(FULL_TRANSCRIPT);
    expect(spans.every((s) => s.trace_id === SESSION)).toBe(true);
  });

  it('threads a sidechain turn into the cascade via its parentUuid', () => {
    const sidechain = spanById(claudeTranscriptToSpans(FULL_TRANSCRIPT), 'sidechain-1');
    expect(sidechain?.parent_span_id).toBe('turn-1');
  });

  it('omits parent_span_id on a root turn with no parentUuid', () => {
    const turn = spanById(claudeTranscriptToSpans(FULL_TRANSCRIPT), 'turn-1');
    expect(turn?.parent_span_id).toBeUndefined();
  });

  it('skips malformed and odd lines without throwing', () => {
    const messy = ['{ not json', '', '   ', 'null', '"a string"', JSON.stringify(TURN_ONE)].join(
      '\n'
    );
    const spans = claudeTranscriptToSpans(messy);
    expect(spans.map((s) => s.span_id)).toContain('turn-1');
  });

  it('skips an assistant turn that carries no usage', () => {
    const noUsage = { ...TURN_TWO, uuid: 'turn-no-usage', message: { model: 'm', content: [] } };
    const spans = claudeTranscriptToSpans(transcriptOf(TURN_ONE, noUsage));
    expect(spanById(spans, 'turn-no-usage')).toBeUndefined();
  });

  it('falls back to the claude-session trace_id when sessionId is absent', () => {
    const noSession = { ...TURN_ONE, sessionId: undefined };
    const spans = claudeTranscriptToSpans(transcriptOf(noSession));
    expect(spans[0]?.trace_id).toBe('claude-session');
  });

  it('falls back to the turn timestamp when no tool_result matches', () => {
    const orphanTool = {
      ...TURN_ONE,
      uuid: 'turn-orphan',
      message: {
        ...TURN_ONE.message,
        content: [
          { type: 'tool_use', id: 'tool-orphan', name: 'Read', input: { file_path: '/a/b.ts' } },
        ],
      },
    };
    const spans = claudeTranscriptToSpans(transcriptOf(orphanTool));
    const tool = spanById(spans, 'tool-orphan');
    expect(tool?.duration_ms).toBe(1);
    expect(tool?.note).toBe('/a/b.ts');
  });
});
