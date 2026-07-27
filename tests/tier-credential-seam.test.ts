import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tierChat } from '../src/tiers.js';

// The seam that actually matters. Every governed path that needs a model —
// the antagonist reviewer, enact's overseer, delegate/dispatch's verify —
// resolves it through `tierChat`, which asks @verevoir/llm whether a provider
// is configured. So THIS is where credential support has to be asserted.
//
// It is not enough to test @verevoir/llm directly: a consumer can hold a
// correct top-level copy while `tierChat` resolves a DIFFERENT, nested one.
// That is exactly what shipped — accelerator declared `@verevoir/llm: ^0.20.0`,
// which (caret on a 0.x version pins the minor) cannot admit 0.21.x, so npm
// nested an old copy under accelerator. capabilities' own paths saw 0.21.1 with
// the OAuth support; `tierChat` saw 0.20.3 without it, reported "no reasoning
// tier configured", and every governed review silently could not run.

const KEY = 'ANTHROPIC_API_KEY';
const OAUTH = 'CLAUDE_CODE_OAUTH_TOKEN';
const TIER = 'AIGENCY_MODEL_REASONING';

describe('tierChat — the credential seam the governed paths resolve through', () => {
  const saved = { key: process.env[KEY], oauth: process.env[OAUTH], tier: process.env[TIER] };

  beforeEach(() => {
    delete process.env[KEY];
    delete process.env[OAUTH];
    delete process.env[TIER];
  });
  afterEach(() => {
    for (const [k, v] of [
      [KEY, saved.key],
      [OAUTH, saved.oauth],
      [TIER, saved.tier],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves the reasoning tier from a subscription OAuth token alone', async () => {
    process.env[OAUTH] = 'sk-ant-oat-seam-test';
    const tier = await tierChat('reasoning');
    expect(tier).not.toBeNull();
    expect(tier?.modelId).toMatch(/opus/);
  });

  it('resolves the reasoning tier from an API key alone (unchanged for metered setups)', async () => {
    process.env[KEY] = 'sk-ant-seam-test';
    const tier = await tierChat('reasoning');
    expect(tier).not.toBeNull();
  });

  it('resolves nothing when neither credential is present — fail closed, not a silent default', async () => {
    expect(await tierChat('reasoning')).toBeNull();
  });
});

describe('dependency hygiene — exactly one @verevoir/llm in the tree', () => {
  it('has no nested duplicate that could shadow the resolved version', () => {
    // A second copy is how a correct top-level dependency stops being the one
    // the code actually runs. Walk node_modules for every @verevoir/llm.
    const found: string[] = [];
    const walk = (dir: string, depth = 0) => {
      if (depth > 4 || !existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const here = join(dir, entry.name);
        if (entry.name === 'llm' && here.includes(join('@verevoir', 'llm'))) {
          const pkg = join(here, 'package.json');
          if (existsSync(pkg)) found.push(JSON.parse(readFileSync(pkg, 'utf8')).version);
          continue;
        }
        if (entry.name === 'node_modules' || entry.name.startsWith('@') || depth < 2) {
          walk(here, depth + 1);
        }
      }
    };
    walk('node_modules');
    expect(found.length, `expected one @verevoir/llm, found ${found.join(', ')}`).toBe(1);
  });
});
