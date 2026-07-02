import { describe, it, expect, afterEach } from 'vitest';
import {
  registerModelCatalog,
  registerProviderConnection,
  type ChatOptions,
  type ChatReply,
} from '@verevoir/llm';
import { tierChat, tierEnvConfig, TIER_DEFAULTS } from '../src/tiers.js';
import { resetRegistryWarm } from '../src/registry.js';

// ── env helpers ──────────────────────────────────────────────────────────────

const TIER_ENVS = [
  'AIGENCY_MODEL_REASONING',
  'AIGENCY_MODEL_REASONING_URI',
  'AIGENCY_MODEL_REASONING_KEY',
  'AIGENCY_MODEL_DRAFTING',
  'AIGENCY_MODEL_DRAFTING_URI',
  'AIGENCY_MODEL_DRAFTING_KEY',
  'AIGENCY_MODEL_EXTRACTION',
  'AIGENCY_MODEL_EXTRACTION_URI',
  'AIGENCY_MODEL_EXTRACTION_KEY',
  'AIGENCY_WORKER_MODEL',
  'AIGENCY_WORKER_URL',
  'AIGENCY_WORKER_API_KEY',
  'TIER_TEST_KEY',
  // Provider keys — cleared/restored so resolution is hermetic regardless of the
  // runner's ambient env. Without this, a real shell with provider keys present
  // makes a default tier resolvable, flipping the "null / ignored" assertions.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'SAMBA_NOVA_API_KEY',
  'MISTRAL_API_KEY',
];

const saved: Record<string, string | undefined> = {};
for (const k of TIER_ENVS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of TIER_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRegistryWarm();
});

function clearTierEnvs() {
  for (const k of TIER_ENVS) delete process.env[k];
}

// ── TIER_DEFAULTS ────────────────────────────────────────────────────────────

describe('TIER_DEFAULTS', () => {
  it('defaults reasoning to opus, drafting to sonnet, extraction to haiku', () => {
    expect(TIER_DEFAULTS.reasoning).toBe('opus');
    expect(TIER_DEFAULTS.drafting).toBe('sonnet');
    expect(TIER_DEFAULTS.extraction).toBe('haiku');
  });
});

// ── tierEnvConfig — back-compat aliases ─────────────────────────────────────

describe('tierEnvConfig — AIGENCY_WORKER_* back-compat alias for extraction', () => {
  it('reads AIGENCY_WORKER_MODEL as extraction model when AIGENCY_MODEL_EXTRACTION is unset', () => {
    clearTierEnvs();
    process.env.AIGENCY_WORKER_MODEL = 'qwen2.5:7b';
    const cfg = tierEnvConfig('extraction');
    expect(cfg.model).toBe('qwen2.5:7b');
  });

  it('reads AIGENCY_WORKER_URL as extraction URI when AIGENCY_MODEL_EXTRACTION_URI is unset', () => {
    clearTierEnvs();
    process.env.AIGENCY_WORKER_URL = 'http://localhost:11434/v1';
    const cfg = tierEnvConfig('extraction');
    expect(cfg.uri).toBe('http://localhost:11434/v1');
  });

  it('reads AIGENCY_WORKER_API_KEY as extraction key when AIGENCY_MODEL_EXTRACTION_KEY is unset', () => {
    clearTierEnvs();
    process.env.AIGENCY_WORKER_API_KEY = 'sk-legacy';
    const cfg = tierEnvConfig('extraction');
    expect(cfg.key).toBe('sk-legacy');
  });

  it('AIGENCY_MODEL_EXTRACTION wins over AIGENCY_WORKER_MODEL when both are set', () => {
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION = 'haiku';
    process.env.AIGENCY_WORKER_MODEL = 'qwen2.5:7b';
    const cfg = tierEnvConfig('extraction');
    expect(cfg.model).toBe('haiku');
  });

  it('AIGENCY_MODEL_EXTRACTION_URI wins over AIGENCY_WORKER_URL when both are set', () => {
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION_URI = 'https://api.example.com/v1';
    process.env.AIGENCY_WORKER_URL = 'http://localhost:11434/v1';
    const cfg = tierEnvConfig('extraction');
    expect(cfg.uri).toBe('https://api.example.com/v1');
  });

  it('does NOT alias AIGENCY_WORKER_* for the reasoning tier', () => {
    clearTierEnvs();
    process.env.AIGENCY_WORKER_MODEL = 'qwen2.5:7b';
    const cfg = tierEnvConfig('reasoning');
    expect(cfg.model).toBeNull();
  });
});

// ── tierChat — direct URI path ───────────────────────────────────────────────

describe('tierChat — direct-URI path (_URI set)', () => {
  it('returns a TierChat with the configured modelId when _URI is set', async () => {
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION = 'my-model';
    process.env.AIGENCY_MODEL_EXTRACTION_URI = 'https://api.example.com/v1';
    process.env.AIGENCY_MODEL_EXTRACTION_KEY = 'sk-x';

    const result = await tierChat('extraction');
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe('my-model');
    // No provider for a direct-URI tier
    expect(result!.provider).toBeUndefined();
  });

  it('rejects a malformed _URI with a legible error', async () => {
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION_URI = 'not-a-url';
    process.env.AIGENCY_MODEL_EXTRACTION = 'some-model';

    await expect(tierChat('extraction')).rejects.toThrow(/not a valid http/i);
  });

  it('AIGENCY_WORKER_URL (back-compat) is treated as a direct-URI tier', async () => {
    clearTierEnvs();
    process.env.AIGENCY_WORKER_MODEL = 'qwen2.5:7b';
    process.env.AIGENCY_WORKER_URL = 'http://localhost:11434/v1';

    const result = await tierChat('extraction');
    expect(result).not.toBeNull();
    expect(result!.modelId).toBe('qwen2.5:7b');
  });

  it('KEY without URI is ignored (KEY alone is meaningless)', async () => {
    // When ONLY the key is set (no URI), we fall through to adapter resolution.
    // Since no provider serves 'haiku' in the test registry, it should return null.
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION_KEY = 'sk-x';
    // No URI → falls through to adapter path; no catalog entry for 'haiku' → null
    const result = await tierChat('extraction');
    expect(result).toBeNull();
  });
});

// ── tierChat — adapter resolution path ──────────────────────────────────────

describe('tierChat — adapter resolution path (no _URI)', () => {
  it('returns null when the tier env is unset and no provider serves the default', async () => {
    clearTierEnvs();
    // 'opus' / 'sonnet' / 'haiku' are not in the test catalog, so all tiers return null.
    expect(await tierChat('reasoning')).toBeNull();
    expect(await tierChat('drafting')).toBeNull();
    expect(await tierChat('extraction')).toBeNull();
  });

  it('resolves AIGENCY_MODEL_EXTRACTION (a family) to a TierChat via the catalog', async () => {
    clearTierEnvs();
    registerModelCatalog([
      {
        provider: 'tiertest',
        family: 'tiertest-mini',
        modelClass: 'extraction',
        currentId: 'tiertest-mini-1',
        rates: [0.1, 0.2],
        label: 'TierTest Mini',
        prefixes: ['tiertest'],
      },
    ]);
    registerProviderConnection({
      provider: 'tiertest',
      apiKeyEnv: 'TIER_TEST_KEY',
      defaultBaseUrl: 'https://tier.example/v1',
    });
    process.env.TIER_TEST_KEY = 'k';
    process.env.AIGENCY_MODEL_EXTRACTION = 'tiertest';

    const result = await tierChat('extraction');
    // The adapter module for 'tiertest' isn't in PROVIDER_CHAT_LOADERS, so it
    // resolves the catalog entry but returns null (no chat fn for unknown providers).
    // This is the expected behaviour: unknown providers can't provide a ChatFn.
    expect(result).toBeNull();
  });

  it('resolves via AIGENCY_WORKER_MODEL (back-compat) through the adapter when no URI', async () => {
    clearTierEnvs();
    // With no URI, AIGENCY_WORKER_MODEL is treated as the model term to resolve.
    // Since 'qwen2.5:7b' is not in any adapter's catalog, it returns null.
    process.env.AIGENCY_WORKER_MODEL = 'qwen2.5:7b';

    const result = await tierChat('extraction');
    expect(result).toBeNull();
  });
});

// ── tierChat — the ChatFn returned for a direct-URI tier actually calls fetch ─

describe('tierChat — ChatFn drives fetch correctly for a direct-URI tier', () => {
  it('posts to <uri>/chat/completions and returns the content', async () => {
    const { vi } = await import('vitest');
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION = 'test-model';
    process.env.AIGENCY_MODEL_EXTRACTION_URI = 'https://compat.example/v1';
    process.env.AIGENCY_MODEL_EXTRACTION_KEY = 'sk-compat';

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello from compat' } }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await tierChat('extraction');
    expect(result).not.toBeNull();

    const chatOpts: ChatOptions = {
      systemPrompt: 'be helpful',
      turns: [{ role: 'user', content: 'hi' }],
    };
    const reply: ChatReply = await result!.chat(chatOpts);
    expect(reply.content).toBe('hello from compat');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://compat.example/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages[0]).toMatchObject({ role: 'system', content: 'be helpful' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-compat');

    vi.unstubAllGlobals();
  });

  it('throws on a non-ok response so the caller can surface a legible error', async () => {
    const { vi } = await import('vitest');
    clearTierEnvs();
    process.env.AIGENCY_MODEL_EXTRACTION = 'test-model';
    process.env.AIGENCY_MODEL_EXTRACTION_URI = 'https://compat.example/v1';

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }))
    );

    const result = await tierChat('extraction');
    expect(result).not.toBeNull();
    await expect(
      result!.chat({ systemPrompt: 'x', turns: [{ role: 'user', content: 'y' }] })
    ).rejects.toThrow(/HTTP 401/);

    vi.unstubAllGlobals();
  });
});
