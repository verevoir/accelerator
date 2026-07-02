import { roundUsage } from './metering.js';
import type { PerModelUsage } from '@verevoir/llm';

// Shared OpenAI-compatible chat-completions plumbing — the worker call
// (delegate) and the reasoning-tier reviewer (review) both speak this wire
// format, so the `usage`-block mapping lives here once rather than drifting in
// two places.

/** The OpenAI-compatible `usage` block, with the cache fields different
 * providers report. `prompt_tokens_details.cached_tokens` (OpenAI) and
 * `prompt_cache_hit_tokens` (DeepSeek) are a SUBSET of `prompt_tokens`. */
export interface WorkerUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
}

/** Map an OpenAI-compatible `usage` block to a per-model rollup. The cached
 * tokens are a subset of `prompt_tokens`, so they're SUBTRACTED from `in` and
 * reported as `cacheRead` — pricing the cached portion at the cache rate keeps
 * the prompt-cache saving visible instead of billing it at the full input rate.
 * Returns null when the worker reported no usable usage. */
export function usageFromResponse(
  model: string,
  usage: WorkerUsage | undefined
): PerModelUsage | null {
  if (!usage || (usage.prompt_tokens == null && usage.completion_tokens == null)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const promptTokens = usage.prompt_tokens ?? 0;
  const nonCachedInput = Math.max(0, promptTokens - cached);
  return roundUsage(model, nonCachedInput, usage.completion_tokens ?? 0, cached, 0);
}
