import { describe, it, expect } from 'vitest';
import { runSearch, type MakeStep } from '../src/loop/search.js';
import { deterministicEval, type Evaluator } from '../src/loop/evals.js';
import type { StopPolicy } from '../src/loop/refine.js';

// Search is pure orchestration over the refine loop. Each seed's step produces a
// fixed-score output derived from the seed, so the global best is predictable and
// the test needs no model.

/** Each seed is a target score; its step always emits that score. So seed 0.9
 * is the global best across [0.3, 0.9, 0.5]. */
const makeStepFromSeed: MakeStep<number, { score: number }> = (seed) => async () => ({
  score: seed,
});

const scoreFromOutput: Evaluator<{ score: number }> = deterministicEval((o) => o.score);

const ONE_SHOT: StopPolicy = { maxLoops: 1 };

describe('runSearch', () => {
  it('runs every seed and selects the global best by score', async () => {
    const result = await runSearch([0.3, 0.9, 0.5], makeStepFromSeed, scoreFromOutput, ONE_SHOT);
    expect(result.best.seed).toBe(0.9);
    expect(result.best.index).toBe(1);
    expect(result.best.result.best.score).toBeCloseTo(0.9);
  });

  it('returns a run for every seed, in input order, so the search is legible', async () => {
    const result = await runSearch([0.3, 0.9, 0.5], makeStepFromSeed, scoreFromOutput, ONE_SHOT);
    expect(result.seedRuns.map((r) => r.seed)).toEqual([0.3, 0.9, 0.5]);
    expect(result.seedRuns.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(result.seedRuns.map((r) => r.result.best.score)).toEqual([0.3, 0.9, 0.5]);
  });

  it('resolves a tie to the earliest seed in input order', async () => {
    const result = await runSearch([0.7, 0.7], makeStepFromSeed, scoreFromOutput, ONE_SHOT);
    expect(result.best.index).toBe(0);
  });

  it('respects the concurrency bound — never more than `concurrency` seeds running at once', async () => {
    let active = 0;
    let peak = 0;
    const trackingStep: MakeStep<number, { score: number }> = (seed) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { score: seed };
    };
    await runSearch([0.1, 0.2, 0.3, 0.4, 0.5], trackingStep, scoreFromOutput, ONE_SHOT, {
      concurrency: 2,
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('rejects an empty seed list rather than returning a best of nothing', async () => {
    await expect(runSearch([], makeStepFromSeed, scoreFromOutput, ONE_SHOT)).rejects.toThrow(
      /at least one seed/
    );
  });
});
