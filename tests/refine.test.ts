import { describe, it, expect } from 'vitest';
import { runRefineLoop, type RefineStep, type StopPolicy } from '../src/loop/refine.js';
import { deterministicEval, type Evaluator } from '../src/loop/evals.js';

// The refine loop is pure: every test drives it with an injected fake step + a
// deterministic eval, so there is no model and no network. Each test pins one
// behaviour of the loop's control flow.

/** A step that returns the next score in a fixed list (as a `{ score }` output),
 * recording the `prev` it was handed so feedback-threading can be asserted. */
function scriptedStep(scores: number[]): {
  step: RefineStep<{ score: number }>;
  prevs: Array<{ output: { score: number }; score: number; feedback?: string } | undefined>;
} {
  const prevs: Array<{ output: { score: number }; score: number; feedback?: string } | undefined> =
    [];
  let i = 0;
  const step: RefineStep<{ score: number }> = async (prev) => {
    prevs.push(prev);
    const score = scores[Math.min(i, scores.length - 1)];
    i += 1;
    return { score };
  };
  return { step, prevs };
}

/** Evaluator that reads the score straight off the output and echoes it as
 * feedback, so we can assert the loop threads feedback forward. */
const scoreFromOutput: Evaluator<{ score: number }> = deterministicEval((o) => ({
  score: o.score,
  feedback: `was ${o.score}`,
}));

describe('runRefineLoop — stopping', () => {
  it('stops at maxLoops when no other condition fires', async () => {
    const { step } = scriptedStep([0.1, 0.1, 0.1]);
    const policy: StopPolicy = { maxLoops: 3 };
    const result = await runRefineLoop(step, scoreFromOutput, policy);
    expect(result.trace).toHaveLength(3);
    expect(result.stoppedBy).toBe('maxLoops');
  });

  it('stops as soon as an attempt reaches the target score', async () => {
    const { step } = scriptedStep([0.2, 0.9, 0.95]);
    const policy: StopPolicy = { maxLoops: 10, targetScore: 0.8 };
    const result = await runRefineLoop(step, scoreFromOutput, policy);
    expect(result.stoppedBy).toBe('target');
    expect(result.trace).toHaveLength(2); // stopped on the second, which hit 0.9
  });

  it('stops on diminishing returns once the best score plateaus within epsilon over the window', async () => {
    // Best climbs 0.5 → 0.55 then flattens; over a window of 3 the improvement
    // (0.56 - 0.55 = 0.01) is below epsilon 0.05, so it stops.
    const { step } = scriptedStep([0.5, 0.55, 0.555, 0.56, 0.99]);
    const policy: StopPolicy = {
      maxLoops: 10,
      diminishingReturns: { epsilon: 0.05, window: 3 },
    };
    const result = await runRefineLoop(step, scoreFromOutput, policy);
    expect(result.stoppedBy).toBe('diminishing');
    // It must NOT have run to the 0.99 attempt that would have changed the answer.
    expect(result.trace.length).toBeLessThan(5);
    expect(result.best.score).toBeCloseTo(0.56);
  });

  it('does not fire diminishing returns before the window has enough history', async () => {
    // Only 2 iterations of history for a window of 3 — can't plateau yet, so it
    // runs to maxLoops.
    const { step } = scriptedStep([0.3, 0.3]);
    const policy: StopPolicy = {
      maxLoops: 2,
      diminishingReturns: { epsilon: 0.05, window: 3 },
    };
    const result = await runRefineLoop(step, scoreFromOutput, policy);
    expect(result.stoppedBy).toBe('maxLoops');
  });
});

describe('runRefineLoop — result', () => {
  it('returns the best iteration, not the last', async () => {
    // Peak in the middle; the last attempt is worse.
    const { step } = scriptedStep([0.4, 0.9, 0.6]);
    const result = await runRefineLoop(step, scoreFromOutput, { maxLoops: 3 });
    expect(result.best.score).toBeCloseTo(0.9);
    expect(result.best.iteration).toBe(2);
    expect(result.best.output).toEqual({ score: 0.9 });
  });

  it('threads the previous output and its feedback into the next step', async () => {
    const { step, prevs } = scriptedStep([0.3, 0.7]);
    await runRefineLoop(step, scoreFromOutput, { maxLoops: 2 });
    expect(prevs[0]).toBeUndefined(); // iteration 1 gets no prev
    expect(prevs[1]).toEqual({ output: { score: 0.3 }, score: 0.3, feedback: 'was 0.3' });
  });

  it('records every iteration in the trace with its score and feedback', async () => {
    const { step } = scriptedStep([0.2, 0.5]);
    const result = await runRefineLoop(step, scoreFromOutput, { maxLoops: 2 });
    expect(result.trace).toEqual([
      { iteration: 1, score: 0.2, feedback: 'was 0.2' },
      { iteration: 2, score: 0.5, feedback: 'was 0.5' },
    ]);
  });

  it('always runs at least one iteration even if maxLoops is below 1', async () => {
    const { step } = scriptedStep([0.42]);
    const result = await runRefineLoop(step, scoreFromOutput, { maxLoops: 0 });
    expect(result.trace).toHaveLength(1);
    expect(result.best.score).toBeCloseTo(0.42);
  });
});
