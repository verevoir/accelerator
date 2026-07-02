import {
  sumUsages,
  estimateCostUSD,
  formatTokensCompact,
  catalogEntryFor,
  modelLabel,
  type PerModelUsage,
  type RatesTable,
  type RateTuple,
} from '@verevoir/llm';

// Metering (STDIO-385, enriched STDIO-436) — token + cost + time accounting for
// delegate / dispatch / loop worker calls, over the same @verevoir/llm primitives
// aigency-web uses (PerModelUsage → estimateCostUSD over the catalog rate table).
//
// The footer reports the STDIO-436 dimensions: wall-clock TIME, tokens PER MODEL,
// in/out DIRECTION, CACHE state (read/write tokens, priced separately so a cache
// hit reads as the saving it is rather than full-rate input), and TOTAL cost.
// Three modes, set per call:
//   'none'        — nothing appended (default).
//   'totals-only' — one table at the end: per-model in/out (+cache) tokens and
//                   price, then the total cost and elapsed time.
//   'verbose'     — that table, plus a line per stage (each worker round / loop
//                   iteration) with the stage's tokens, price, and time.
// The CONCRETE model id is what's metered/priced (version matters here even
// though config names the family — STDIO-378).

export type MeterMode = 'none' | 'totals-only' | 'verbose';

const METER_MODES: MeterMode[] = ['none', 'totals-only', 'verbose'];

/**
 * The effective meter mode (STDIO-387). An explicit per-call value wins;
 * otherwise the `AIGENCY_METER` env default (config-set, e.g. in the MCP server
 * env) applies; otherwise `none`. An unrecognised value — explicit or env —
 * falls through to `none` so a typo can't silently mean something unintended.
 */
export function resolveMeterMode(explicit?: MeterMode): MeterMode {
  if (explicit && METER_MODES.includes(explicit)) return explicit;
  const env = process.env.AIGENCY_METER?.trim() as MeterMode | undefined;
  if (env && METER_MODES.includes(env)) return env;
  return 'none';
}

/**
 * A single round's usage: model id → input/output (+ optional cache) tokens.
 * Cache tokens are kept SEPARATE from `in` so {@link estimateCostUSD} prices them
 * at the cache rate (read ~0.1×, write ~1.25× of input) — which keeps the
 * prompt-cache saving visible instead of buried at the full input rate.
 */
export function roundUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): PerModelUsage {
  return {
    [model]: {
      in: inputTokens,
      out: outputTokens,
      ...(cacheReadTokens ? { cacheRead: cacheReadTokens } : {}),
      ...(cacheWriteTokens ? { cacheWrite: cacheWriteTokens } : {}),
    },
  };
}

/** Per-stage timing for the footer: each round's elapsed ms (rendered in
 * `verbose`) and the whole operation's wall-clock (always rendered when set). */
export interface MeterTiming {
  /** Elapsed ms per round/iteration, index-aligned with the `rounds` passed to
   * {@link meterFooter}. */
  roundMs?: number[];
  /** Wall-clock ms for the whole metered operation. */
  totalMs?: number;
}

/** Human-readable elapsed time: `820ms`, `1.2s`, `1m04s`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m${String(rem).padStart(2, '0')}s`;
}

/** The rates for the models in a usage rollup, read from the catalog. */
function ratesFor(usage: PerModelUsage): RatesTable {
  const r: Record<string, RateTuple> = {};
  for (const id of Object.keys(usage)) {
    const rates = catalogEntryFor(id)?.rates;
    if (rates) r[id] = rates as RateTuple;
  }
  return r;
}

function priceUSD(usage: PerModelUsage): number {
  return estimateCostUSD(usage, ratesFor(usage));
}

/** One line per model in a rollup: "Label (class) — in / out (+cache) — $price".
 * Cache tokens are shown only when nonzero, so the common no-cache worker line
 * stays uncluttered. */
function usageLines(usage: PerModelUsage): string[] {
  return Object.entries(usage).map(([id, u]) => {
    const cls = catalogEntryFor(id)?.modelClass ?? 'unclassified';
    const cost = priceUSD({ [id]: u });
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    const cache =
      cacheRead || cacheWrite
        ? ` (cache ${formatTokensCompact(cacheRead)} read / ${formatTokensCompact(cacheWrite)} write)`
        : '';
    return `${modelLabel(id)} (${cls}) — ${formatTokensCompact(u.in)} in / ${formatTokensCompact(u.out)} out${cache} — $${cost.toFixed(4)}`;
  });
}

/**
 * The metering footer to append to a worker result, per mode. `rounds` is the
 * per-stage usage (one entry per worker round for dispatch, one per loop
 * iteration for refine/search, one for delegate); `opts.stageLabels` names each
 * stage for `verbose`, and `opts.timing` carries elapsed time (per-stage in
 * `verbose`, total always). Empty string for `'none'` or no usage — so the
 * caller can append unconditionally.
 */
export function meterFooter(
  rounds: PerModelUsage[],
  mode: MeterMode,
  opts: { stageLabels?: string[]; timing?: MeterTiming } = {}
): string {
  if (mode === 'none' || rounds.length === 0) return '';
  const { stageLabels, timing } = opts;
  const lines: string[] = [];
  if (mode === 'verbose') {
    lines.push('— metering by stage —');
    rounds.forEach((u, i) => {
      const label = stageLabels?.[i] ?? `round ${i + 1}`;
      const ms = timing?.roundMs?.[i];
      const time = ms !== undefined ? ` — ${formatMs(ms)}` : '';
      lines.push(`  ${label}: ${usageLines(u).join('; ') || '(no usage)'}${time}`);
    });
  }
  const total = sumUsages(rounds);
  lines.push('— metering total —');
  for (const l of usageLines(total)) lines.push(`  ${l}`);
  lines.push(`  total: $${priceUSD(total).toFixed(4)}`);
  if (timing?.totalMs !== undefined) lines.push(`  elapsed: ${formatMs(timing.totalMs)}`);
  return `\n\n${lines.join('\n')}`;
}
