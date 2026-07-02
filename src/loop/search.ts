// SEARCH (STDIO-430) — multi-seed search + select over the refine loop.
//
// Where `runRefineLoop` improves a single line of attempts, `runSearch` runs K
// diverse seeds — each its own refine loop, from its own starting `step` — and
// picks the global best across all of them. Diverse starts diverge, so a search
// escapes a local optimum a single refine line would get stuck in. PURE: no MCP,
// no model import; `makeStep` and `evaluate` are injected.

import { runRefineLoop, type RefineResult, type RefineStep, type StopPolicy } from './refine.js';
import type { Evaluator } from './evals.js';

/** Builds the `step` for one seed. Each seed gets its own step so diverse starts
 * actually diverge — e.g. a different temperature, a different seed prompt. */
export type MakeStep<Seed, Output> = (seed: Seed) => RefineStep<Output>;

/** One seed's outcome: which seed it was, its index in the input order, and the
 * full refine result for that seed (so the search stays legible — every seed's
 * trace is returned, not just the winner's). */
export interface SeedRun<Seed, Output> {
  seed: Seed;
  index: number;
  result: RefineResult<Output>;
}

export interface SearchResult<Seed, Output> {
  /** The winning seed's refine result — the global best across all seeds. */
  best: SeedRun<Seed, Output>;
  /** Every seed's run, in input order — legible, not a black box. */
  seedRuns: SeedRun<Seed, Output>[];
}

export interface SearchOptions {
  /** Max seeds refining at once. Defaults to running all seeds concurrently.
   * Bound it to cap pressure on the worker (cost / rate limits). */
  concurrency?: number;
}

/**
 * Run a bounded-concurrency map over `items`, preserving input order in the
 * results. A small worker-pool: at most `limit` tasks run at once, and each
 * worker pulls the next index off a shared cursor as it frees up. Kept local —
 * it's the only place the family needs bounded concurrency, so it doesn't earn
 * a shared abstraction.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const bound = Math.max(1, Math.floor(limit));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(bound, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Run each seed through its own refine loop (concurrently, bounded by
 * `concurrency`) and select the seed whose best attempt scored highest. Ties
 * resolve to the earliest seed in input order, so the result is deterministic
 * given deterministic inputs. Returns the winning run plus every seed's run.
 *
 * Throws if `seeds` is empty — there is no "best of nothing" to return, and a
 * silent empty result would hide a caller bug (failure legibility).
 */
export async function runSearch<Seed, Output>(
  seeds: Seed[],
  makeStep: MakeStep<Seed, Output>,
  evaluate: Evaluator<Output>,
  stopPolicy: StopPolicy,
  options: SearchOptions = {}
): Promise<SearchResult<Seed, Output>> {
  if (seeds.length === 0) {
    throw new Error('runSearch requires at least one seed');
  }

  const seedRuns = await mapWithConcurrency(
    seeds,
    options.concurrency ?? seeds.length,
    async (seed, index) => ({
      seed,
      index,
      result: await runRefineLoop(makeStep(seed), evaluate, stopPolicy),
    })
  );

  // Highest best-score wins; ties keep the earliest seed (stable reduce over the
  // input-ordered runs).
  const best = seedRuns.reduce((winner, run) =>
    run.result.best.score > winner.result.best.score ? run : winner
  );

  return { best, seedRuns };
}
