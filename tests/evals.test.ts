import { describe, it, expect, vi } from 'vitest';
import {
  deterministicEval,
  modelJudgeEval,
  practicesAsBarEval,
  parseJudgeScore,
  clampScore,
} from '../src/loop/evals.js';

describe('clampScore', () => {
  it('clamps out-of-range scores into 0..1 and maps non-finite to 0', () => {
    expect(clampScore(0.5)).toBe(0.5);
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(2)).toBe(1);
    expect(clampScore(NaN)).toBe(0);
  });
});

describe('deterministicEval', () => {
  it('scores via its function and clamps the result', async () => {
    const ev = deterministicEval<string>((o) => (o === 'good' ? 5 : 0));
    expect(await ev('good')).toEqual({ score: 1 }); // 5 clamped to 1
    expect(await ev('bad')).toEqual({ score: 0 });
  });

  it('passes through feedback when the function returns a result object', async () => {
    const ev = deterministicEval<string>(() => ({ score: 0.4, feedback: 'too short' }));
    expect(await ev('x')).toEqual({ score: 0.4, feedback: 'too short' });
  });

  it('hands the context through to the scoring function', async () => {
    const ev = deterministicEval<string>((o, ctx) => (ctx === 'wanted' && o === 'wanted' ? 1 : 0));
    expect(await ev('wanted', 'wanted')).toEqual({ score: 1 });
  });
});

describe('parseJudgeScore', () => {
  it('reads a labelled SCORE line and a FEEDBACK line', () => {
    expect(parseJudgeScore('SCORE: 0.7\nFEEDBACK: tighten the intro')).toEqual({
      score: 0.7,
      feedback: 'tighten the intro',
    });
  });

  it('normalises an n/m fraction to 0..1', () => {
    expect(parseJudgeScore('I rate this 7/10').score).toBeCloseTo(0.7);
  });

  it('falls back to the first bare number when unlabelled', () => {
    expect(parseJudgeScore('0.42 looks right').score).toBeCloseTo(0.42);
  });

  it('scores 0 with the raw text as feedback when no number is present', () => {
    const r = parseJudgeScore('this is great!');
    expect(r.score).toBe(0);
    expect(r.feedback).toContain('no readable score');
  });

  it('clamps a judge that overshoots the range', () => {
    expect(parseJudgeScore('SCORE: 5').score).toBe(1);
  });
});

describe('modelJudgeEval', () => {
  it('parses a faked worker reply into a normalised score + feedback', async () => {
    const call = vi.fn(async () => 'SCORE: 0.8\nFEEDBACK: add an example');
    const ev = modelJudgeEval<string>({ rubric: 'be clear', call });
    expect(await ev('some output')).toEqual({ score: 0.8, feedback: 'add an example' });
  });

  it('sends the rubric, the output, and the context to the judge', async () => {
    const call = vi.fn(async () => 'SCORE: 0.5');
    const ev = modelJudgeEval<string>({ rubric: 'RUBRIC-TEXT', model: 'judge-model', call });
    await ev('CANDIDATE-TEXT', 'TASK-TEXT');
    const arg = call.mock.calls[0][0];
    expect(arg.model).toBe('judge-model');
    expect(arg.prompt).toContain('RUBRIC-TEXT');
    expect(arg.prompt).toContain('CANDIDATE-TEXT');
    expect(arg.prompt).toContain('TASK-TEXT');
  });

  it('serialises a non-string output before judging', async () => {
    const call = vi.fn(async () => 'SCORE: 0.6');
    const ev = modelJudgeEval<{ a: number }>({ rubric: 'r', call });
    await ev({ a: 1 });
    expect(call.mock.calls[0][0].prompt).toContain('"a": 1');
  });
});

describe('practicesAsBarEval', () => {
  it('provisions the bar for the work and uses it as the judge rubric', async () => {
    const provision = vi.fn(async () => 'THE PROVISIONED BAR');
    const call = vi.fn(async () => 'SCORE: 0.9\nFEEDBACK: good');
    const ev = practicesAsBarEval<string>({
      workDescription: 'add a refine loop',
      provision,
      call,
    });

    const result = await ev('candidate output');

    expect(provision).toHaveBeenCalledWith('add a refine loop');
    expect(call.mock.calls[0][0].prompt).toContain('THE PROVISIONED BAR');
    expect(result).toEqual({ score: 0.9, feedback: 'good' });
  });
});
