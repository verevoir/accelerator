import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tierChat } from '../src/tiers.js';
import { warmRegistry } from '../src/registry.js';

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

// FIRST in the file, deliberately: vitest runs describes in declaration order, so
// this is the only position from which a stale install is diagnosed BEFORE the tier
// assertions below fail at it. Placed after them it would still fail, but only after
// the mystifying `expected null not to be null` it exists to pre-empt.
describe('install integrity — checked before anything reads a resolved model', () => {
  it('has the installed @verevoir/llm the lockfile pins, not a stale one', () => {
    // The real reported symptom: an install predating the ^0.21.1 bump leaves 0.20.x
    // on disk, which has no `altKeyEnvs`, so CLAUDE_CODE_OAUTH_TOKEN is not counted
    // as a credential and every tier below resolves null — with nothing naming the
    // cause. CI never sees it (`npm ci` installs the lockfile); a working tree does.
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    // lockfileVersion 2/3 key it under `packages`, v1 under `dependencies`. Read
    // both: assuming v2+ makes `locked` undefined against a v1 lockfile, and the
    // assertion then reports "the lockfile pins undefined — run `npm ci`", sending
    // you after a stale install when the real problem is the lockfile format.
    const locked =
      lock.packages?.['node_modules/@verevoir/llm']?.version ??
      lock.dependencies?.['@verevoir/llm']?.version;
    expect(
      locked,
      `could not read the pinned @verevoir/llm version from package-lock.json ` +
        `(lockfileVersion ${lock.lockfileVersion}) — neither packages['node_modules/@verevoir/llm'] ` +
        `nor dependencies['@verevoir/llm'] carried one. This is a lockfile-shape problem, ` +
        `not a stale install: fix this assertion rather than running \`npm ci\`.`
    ).toBeTypeOf('string');

    const installed = JSON.parse(
      readFileSync(join('node_modules', '@verevoir', 'llm', 'package.json'), 'utf8')
    ).version;
    expect(
      installed,
      `@verevoir/llm on disk is ${installed} but the lockfile pins ${locked} — run \`npm ci\`. ` +
        `A pre-0.21 copy has no altKeyEnvs, so CLAUDE_CODE_OAUTH_TOKEN does not count as ` +
        `a credential and every tier assertion below fails for that reason alone.`
    ).toBe(locked);
  });
});

describe('tierChat — the credential seam the governed paths resolve through', () => {
  const saved = { key: process.env[KEY], oauth: process.env[OAUTH], tier: process.env[TIER] };

  // Clear the credentials BEFORE the first warm, then warm. `warmRegistry` only
  // imports the provider adapters — it populates the catalog and does not capture
  // credential state — but it latches after its first run, so warming against a
  // known-empty environment removes the question entirely rather than leaving the
  // suite resting on where the credential check happens to live. The warm itself
  // still has to precede every case: a case running before any warm would see an
  // EMPTY registry and get null regardless of credentials, passing the "resolves
  // nothing" assertion for entirely the wrong reason.
  beforeEach(async () => {
    delete process.env[KEY];
    delete process.env[OAUTH];
    delete process.env[TIER];
    await warmRegistry();
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
    // Same strength as the OAuth case: a non-null tier of the WRONG class would
    // still be a defect, so assert what actually resolved.
    expect(tier?.modelId).toMatch(/opus/);
  });

  it('resolves nothing when neither credential is present — fail closed, not a silent default', async () => {
    expect(await tierChat('reasoning')).toBeNull();
  });

  it('re-evaluates credentials per call — the warm does not bake them in', async () => {
    // The case above only means something if the credential check reads the
    // environment at call time. If it were captured when `warmRegistry` latched,
    // that assertion would pass or fail on whatever the environment held at latch
    // time — including ambient CI credentials — and neither it nor any other case
    // here could tell. Proven directly instead: flip the environment three times
    // against an ALREADY-warmed registry, in one test, so no ordering between tests
    // is involved. This is also the canary — move the credential check into the
    // warm and this fails immediately rather than making the suite quietly
    // environment-dependent.
    await warmRegistry();
    expect(await tierChat('reasoning')).toBeNull();
    process.env[OAUTH] = 'sk-ant-oat-reeval';
    expect(await tierChat('reasoning')).not.toBeNull();
    delete process.env[OAUTH];
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
