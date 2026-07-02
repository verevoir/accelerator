import type { ChatOptions, ChatReply, ModelClass } from '@verevoir/llm';
import { resolveModelByTerm } from '@verevoir/llm';
import { warmRegistry, importProviderAdapter } from './registry.js';

// STDIO-467 — Uniform tier resolution.
//
// Each tier (reasoning / drafting / extraction) is configured via a three-var
// triple:
//
//   AIGENCY_MODEL_<TIER>       — model name/id or provider family; unset → default
//   AIGENCY_MODEL_<TIER>_URI   — optional; direct OpenAI-compatible endpoint URI
//   AIGENCY_MODEL_<TIER>_KEY   — optional bearer key for that endpoint
//
// When _URI is set, the tier uses a direct OpenAI-compat call (no provider
// adapter). When _URI is absent, the model name resolves through the uniform
// provider adapter layer (Anthropic / Gemini / OpenAI-compat / local).
//
// AIGENCY_WORKER_* is a deprecated alias for the extraction tier's triple:
//   AIGENCY_WORKER_MODEL  → AIGENCY_MODEL_EXTRACTION
//   AIGENCY_WORKER_URL    → AIGENCY_MODEL_EXTRACTION_URI
//   AIGENCY_WORKER_API_KEY → AIGENCY_MODEL_EXTRACTION_KEY
// The extraction tier reads both; the AIGENCY_MODEL_EXTRACTION_* vars win.

export const TIER_ENV: Record<ModelClass, string> = {
  reasoning: 'AIGENCY_MODEL_REASONING',
  drafting: 'AIGENCY_MODEL_DRAFTING',
  extraction: 'AIGENCY_MODEL_EXTRACTION',
};

const TIER_URI_ENV: Record<ModelClass, string> = {
  reasoning: 'AIGENCY_MODEL_REASONING_URI',
  drafting: 'AIGENCY_MODEL_DRAFTING_URI',
  extraction: 'AIGENCY_MODEL_EXTRACTION_URI',
};

const TIER_KEY_ENV: Record<ModelClass, string> = {
  reasoning: 'AIGENCY_MODEL_REASONING_KEY',
  drafting: 'AIGENCY_MODEL_DRAFTING_KEY',
  extraction: 'AIGENCY_MODEL_EXTRACTION_KEY',
};

/** Defaults when AIGENCY_MODEL_<TIER> is unset. */
export const TIER_DEFAULTS: Record<ModelClass, string> = {
  reasoning: 'opus',
  drafting: 'sonnet',
  extraction: 'haiku',
};

/**
 * The deprecated AIGENCY_WORKER_* envs are aliases for the extraction-tier
 * triple. AIGENCY_MODEL_EXTRACTION_* wins when both are set.
 */
const WORKER_COMPAT: { model: string; uri: string; key: string } = {
  model: 'AIGENCY_WORKER_MODEL',
  uri: 'AIGENCY_WORKER_URL',
  key: 'AIGENCY_WORKER_API_KEY',
};

/** Read the three-var triple for a tier, applying the AIGENCY_WORKER_* alias
 * for the extraction tier (deprecated; AIGENCY_MODEL_EXTRACTION_* wins). */
export function tierEnvConfig(tier: ModelClass): {
  model: string | null;
  uri: string | null;
  key: string | null;
} {
  const model =
    process.env[TIER_ENV[tier]]?.trim() ||
    (tier === 'extraction' ? process.env[WORKER_COMPAT.model]?.trim() : undefined) ||
    null;
  const uri =
    process.env[TIER_URI_ENV[tier]]?.trim() ||
    (tier === 'extraction' ? process.env[WORKER_COMPAT.uri]?.trim() : undefined) ||
    null;
  const key =
    process.env[TIER_KEY_ENV[tier]]?.trim() ||
    (tier === 'extraction' ? process.env[WORKER_COMPAT.key]?.trim() : undefined) ||
    null;
  return { model, uri, key };
}

/** Validate that the _URI env is a well-formed http(s) URL; throw a legible
 * error (surfaced at tier-resolution time, not at use time) when it is not. */
function validateUri(uri: string, envName: string): void {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`must be an http or https URL`);
    }
  } catch {
    throw new Error(`${envName} is not a valid http(s) URL: "${uri.slice(0, 80)}"`);
  }
}

// ── Provider → ChatFn dispatch ──────────────────────────────────────────────
//
// Each provider adapter subpath exports a `chat` function with the same
// ChatOptions → ChatReply signature. The map below mirrors the IMPORTERS map in
// registry.ts; importing the adapter module registers its catalog + connection
// (which resolveModelByTerm needs) and also gives us the `chat` fn.

/** A provider-agnostic chat function: (ChatOptions) → ChatReply. */
export type ChatFn = (options: ChatOptions) => Promise<ChatReply>;

const PROVIDER_CHAT_LOADERS: Record<string, () => Promise<{ chat: ChatFn }>> = {
  openai: () => import('@verevoir/llm/openai'),
  deepseek: () => import('@verevoir/llm/deepseek'),
  samba: () => import('@verevoir/llm/samba'),
  mistral: () => import('@verevoir/llm/mistral'),
  anthropic: () => import('@verevoir/llm/anthropic'),
  google: () => import('@verevoir/llm/google'),
};

// ── Direct OpenAI-compat chat (for _URI tiers) ─────────────────────────────

/** One chat-completions call to a direct OpenAI-compatible endpoint (the
 * _URI path). Throws on transport / HTTP / empty-content — callers handle. */
async function directCompatChat(
  uri: string,
  modelId: string,
  apiKey: string | null,
  options: ChatOptions
): Promise<ChatReply> {
  const messages = [
    { role: 'system', content: options.systemPrompt },
    ...options.turns.map((t) => ({
      role: t.role,
      content: typeof t.content === 'string' ? t.content : JSON.stringify(t.content),
    })),
  ];
  const url = `${uri.replace(/\/+$/, '')}/chat/completions`;
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: modelId, messages }),
  };
  // Retry with backoff on 429 (rate limit) / 5xx — the worker tier (e.g.
  // SambaNova) rate-limits under the enact verify loop's rapid produce→review→
  // re-produce calls, and a bare failure there wastes the whole enactment. A
  // 402 (out of balance) is NOT retried — it won't clear by waiting.
  const maxAttempts = 5;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, init);
    if (res.ok) break;
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= maxAttempts - 1) {
      const body = await res.text().catch(() => '');
      throw new Error(`tier endpoint HTTP ${res.status} (${modelId}): ${body.slice(0, 160)}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(20000, 500 * 2 ** attempt) + Math.floor(Math.random() * 400);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      // OpenAI-compat: the cached portion of prompt_tokens, when the endpoint
      // reports it (SambaNova / vLLM / OpenAI all use this shape).
      prompt_tokens_details?: { cached_tokens?: number };
    };
  } | null;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`tier endpoint returned no content (${modelId})`);
  // Count the action's real tokens — the worker tier was reporting 0 because this
  // path hardcoded them. `prompt_tokens` is TOTAL input (incl. any cached), so the
  // cached slice is split out to be priced as cache-read, not fresh input.
  const usage = json?.usage;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = usage?.prompt_tokens ?? 0;
  return {
    content,
    usage: {
      provider: 'openai-compat',
      model: modelId,
      direction: 'extraction',
      inputTokens: Math.max(0, promptTokens - cached),
      outputTokens: usage?.completion_tokens ?? 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: cached,
    },
    stopReason: 'end_turn',
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** A resolved tier: the chat function to drive and the concrete model id (for
 * the meter, logs, and descriptions). */
export interface TierChat {
  /** The provider-agnostic chat function for this tier. */
  chat: ChatFn;
  /** The concrete model id (e.g. `claude-opus-4-7`, `DeepSeek-V3.2`). */
  modelId: string;
  /** The provider id, when resolved through a known adapter (e.g. `anthropic`).
   * `undefined` for a direct-URI tier. */
  provider?: string;
}

/**
 * Resolve a tier to a usable ChatFn via the uniform provider layer.
 *
 * Resolution order:
 * 1. If `_URI` is set → direct OpenAI-compat endpoint (validated).
 * 2. Else resolve the model name (or the default) via `resolveModelByTerm`
 *    through the known provider adapters.
 * 3. Returns `null` when the tier has no configured model AND the default
 *    doesn't resolve (no provider serves it).
 *
 * Never throws on an unresolvable model — returns null so callers can surface
 * a legible "not configured" note rather than crashing.
 */
export async function tierChat(tier: ModelClass): Promise<TierChat | null> {
  const { model: rawModel, uri, key } = tierEnvConfig(tier);

  // ── Direct-URI path ──────────────────────────────────────────────────────
  if (uri) {
    // KEY without URI is meaningless — only note it here, don't error: the URI
    // is missing so we fall through to adapter resolution. This branch handles
    // only the case where URI IS set.
    validateUri(uri, TIER_URI_ENV[tier] || `${TIER_ENV[tier]}_URI`);
    const modelId = rawModel || tier; // fallback to tier name when no model is given
    const baseUri = uri.replace(/\/+$/, '');
    const chat: ChatFn = (opts) => directCompatChat(baseUri, modelId, key, opts);
    return { chat, modelId };
  }

  // ── Adapter resolution path ──────────────────────────────────────────────
  await warmRegistry();
  const term = rawModel || TIER_DEFAULTS[tier];
  const entry = resolveModelByTerm(term, { modelClass: tier });
  if (!entry) {
    // The default didn't resolve either — no registered provider serves it.
    return null;
  }

  // Import the adapter for this provider to get the `chat` function that the
  // llm library's catalog entry was registered against.
  const adapter = await importProviderAdapter(entry.provider);
  if (!adapter) return null;
  const mod = adapter as { chat?: ChatFn };
  if (typeof mod.chat !== 'function') return null;

  return { chat: mod.chat, modelId: entry.currentId, provider: entry.provider };
}

/**
 * Resolve an arbitrary model TERM (e.g. `"opus"`, `"haiku"`, `"deepseek"`) to a
 * usable ChatFn + id + provider, routing to whichever provider actually serves
 * it. Unlike {@link tierChat} — which is env-configured and, for the extraction
 * tier, locked to the single configured worker (e.g. SambaNova, which serves
 * DeepSeek but NOT Anthropic's opus/haiku) — this follows the term to its real
 * provider. It's what a coordinator's up/down override needs: "route this up to
 * opus" must reach Anthropic, not the worker. Returns null when no registered
 * provider serves the term.
 */
export async function termChat(term: string): Promise<TierChat | null> {
  await warmRegistry();
  const entry = resolveModelByTerm(term);
  if (!entry) return null;
  const adapter = await importProviderAdapter(entry.provider);
  if (!adapter) return null;
  const mod = adapter as { chat?: ChatFn };
  if (typeof mod.chat !== 'function') return null;
  return { chat: mod.chat, modelId: entry.currentId, provider: entry.provider };
}

/**
 * The description of which reasoning providers are supported + configured,
 * for surface in tool descriptions. Mirrors provision.ts's
 * `reasoningProvidersSummary` but scoped to the tier system.
 */
export function tierProvidersSummary(): string {
  const names = Object.keys(PROVIDER_CHAT_LOADERS);
  return `Supported providers: ${names.join(', ')}.`;
}
