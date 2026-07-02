// REFINE LOOP (STDIO-430) — the core iterate-with-eval primitive.
//
// "Ralph looping": produce an attempt, score it, and feed the score's feedback
// back into the next attempt so the work IMPROVES across iterations rather than
// just re-rolling. This module is PURE — no MCP, no server, no direct model
// import. The `step` and `evaluate` functions are injected, so the caller wires
// them to a model call (see ../tools/loop.ts) while the loop itself stays
// unit-testable with plain functions and no network.

import type { Evaluator } from './evals.js';

/** The feedback from the previous attempt, threaded into the next `step` so the
 * loop refines toward a higher score instead of re-rolling blind. Absent on the
 * first iteration. */
export interface RefinePrev<Output> {
  output: Output;
  score: number;
  /** The evaluator's prose feedback on `output`, if it gave any — the steer for
   * the next attempt. */
  feedback?: string;
}

/** Produce the next attempt. Iteration 1 receives no `prev`; later iterations
 * receive the previous output and its eval feedback so the step can improve on
 * it. */
export type RefineStep<Output> = (prev?: RefinePrev<Output>) => Promise<Output>;

/** When to stop. The loop stops as soon as ANY condition is met:
 *  - `maxLoops`        — a hard cap on iterations (always set; the backstop).
 *  - `targetScore`     — stop once an attempt scores at or above this.
 *  - `diminishingReturns` — stop once the best score's improvement over the last
 *    `window` iterations is below `epsilon` (the loop has plateaued). Needs at
 *    least `window` iterations before it can fire. */
export interface StopPolicy {
  maxLoops: number;
  targetScore?: number;
  diminishingReturns?: { epsilon: number; window: number };
}

/** Why the loop stopped — legible, so a caller can tell "hit the target" from
 * "ran out of road" from "stopped improving". */
export type StopReason = 'maxLoops' | 'target' | 'diminishing';

/** One iteration's record in the trace — the legible history of the run. */
export interface RefineTraceEntry {
  iteration: number;
  score: number;
  feedback?: string;
}

/** The best attempt the loop found, with the iteration it came from. */
export interface RefineBest<Output> {
  output: Output;
  score: number;
  iteration: number;
}

export interface RefineResult<Output> {
  best: RefineBest<Output>;
  trace: RefineTraceEntry[];
  stoppedBy: StopReason;
}

/** Whether the best-score improvement across the last `window` iterations has
 * fallen below `epsilon` — i.e. the loop has plateaued. The window is measured
 * over running-best scores (not raw per-iteration scores), so a single noisy dip
 * doesn't read as improvement; we need at least `window` iterations of history
 * before it can fire. */
function hasPlateaued(bestSoFar: number[], dr: { epsilon: number; window: number }): boolean {
  const { epsilon, window } = dr;
  if (window <= 0 || bestSoFar.length < window) return false;
  const recent = bestSoFar.slice(-window);
  const improvement = recent[recent.length - 1] - recent[0];
  return improvement < epsilon;
}

/**
 * Run the refine-with-eval loop. Each iteration calls `step` (given the previous
 * output + its feedback), scores the result with `evaluate`, records the
 * iteration in the trace, and checks the stop policy. Returns the BEST attempt
 * seen (not the last), the full trace, and why it stopped.
 *
 * Everything is injected, so this runs with no model: pass deterministic fakes
 * to test the loop's control flow on its own.
 */
export async function runRefineLoop<Output>(
  step: RefineStep<Output>,
  evaluate: Evaluator<Output>,
  stopPolicy: StopPolicy
): Promise<RefineResult<Output>> {
  const trace: RefineTraceEntry[] = [];
  const bestScoreHistory: number[] = [];
  let best: RefineBest<Output> | undefined;
  let prev: RefinePrev<Output> | undefined;
  let stoppedBy: StopReason = 'maxLoops';

  const maxLoops = Math.max(1, Math.floor(stopPolicy.maxLoops));

  for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
    const output = await step(prev);
    const { score, feedback } = await evaluate(output);
    trace.push({ iteration, score, feedback });

    if (!best || score > best.score) best = { output, score, iteration };
    bestScoreHistory.push(best.score);
    prev = { output, score, feedback };

    if (stopPolicy.targetScore !== undefined && score >= stopPolicy.targetScore) {
      stoppedBy = 'target';
      break;
    }
    if (
      stopPolicy.diminishingReturns &&
      hasPlateaued(bestScoreHistory, stopPolicy.diminishingReturns)
    ) {
      stoppedBy = 'diminishing';
      break;
    }
    // maxLoops is the loop bound itself; `stoppedBy` already defaults to it.
  }

  // `best` is always set: maxLoops >= 1 guarantees at least one iteration.
  return { best: best as RefineBest<Output>, trace, stoppedBy };
}
