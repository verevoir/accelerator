import { describe, it, expect, beforeEach } from 'vitest';
import { createContextStore } from '@verevoir/context';
import type { ContextStore } from '@verevoir/context';
import { buildNeighbourhood, renderNeighbourhood } from '../src/graph.js';

// ---------------------------------------------------------------------------
// Synthetic TS sources
//
// File A defines `foo` (function) and `bar` (function); `bar` calls `foo`.
// File B imports `foo` from './a', has a top-level call to `foo`, and a call
// to `trim` (a stdlib method that must be dropped as noise).
// ---------------------------------------------------------------------------

const FILE_A = 'src/a.ts';
const FILE_B = 'src/b.ts';
const SOURCE_ID = '/test-repo';
const VERSION = '';

const SOURCE_A = `
export function foo() {
  return 42;
}

export function bar() {
  return foo();
}
`.trimStart();

const SOURCE_B = `
import { foo } from './a';

foo();

export function baz() {
  const s = 'hello';
  s.trim();
  foo();
}
`.trimStart();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedStore(): ContextStore {
  const store = createContextStore();
  store.setContent({ sourceId: SOURCE_ID, version: VERSION, itemId: FILE_A }, SOURCE_A);
  store.setContent({ sourceId: SOURCE_ID, version: VERSION, itemId: FILE_B }, SOURCE_B);
  return store;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildNeighbourhood — foo', () => {
  let store: ContextStore;

  beforeEach(() => {
    store = seedStore();
  });

  it('finds the definition of foo in file A', () => {
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    expect(nb.definitions).toHaveLength(1);
    expect(nb.definitions[0]).toMatchObject({ file: FILE_A, kind: 'function' });
  });

  it('includes bar as a caller of foo (defined-symbol caller)', () => {
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    const callerNames = nb.callers.map((c) => c.from);
    expect(callerNames).toContain('bar');
  });

  it('includes the top-level call in file B as a caller of foo', () => {
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    const topLevelCallers = nb.callers.filter((c) => c.from === '<top-level>');
    expect(topLevelCallers.length).toBeGreaterThan(0);
    expect(topLevelCallers[0].file).toBe(FILE_B);
  });

  it('callees of foo resolve only to defined symbols (foo itself calls nothing project-internal)', () => {
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    // foo() body is `return 42` — no calls at all
    expect(nb.callees).toHaveLength(0);
  });

  it('importedBy includes file B (which imports foo by name)', () => {
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    expect(nb.importedBy).toContain(FILE_B);
  });

  it('importedBy does not include file A (foo is defined there, not imported)', () => {
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    expect(nb.importedBy).not.toContain(FILE_A);
  });
});

describe('buildNeighbourhood — bar', () => {
  it('callees of bar include foo (defined in this source) but not trim (stdlib noise)', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'bar');
    expect(nb.callees).toContain('foo');
    // trim is a stdlib String method — not a defined symbol, must be dropped
    expect(nb.callees).not.toContain('trim');
  });
});

describe('buildNeighbourhood — baz', () => {
  it('callees of baz include foo but not trim', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'baz');
    expect(nb.callees).toContain('foo');
    expect(nb.callees).not.toContain('trim');
  });
});

describe('buildNeighbourhood — unknown symbol', () => {
  it('returns empty lists for a symbol that does not exist', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'nonExistent');
    expect(nb.definitions).toHaveLength(0);
    expect(nb.callers).toHaveLength(0);
    expect(nb.callees).toHaveLength(0);
    expect(nb.importedBy).toHaveLength(0);
  });

  it('renderNeighbourhood returns the not-found message for an unknown symbol', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'nonExistent');
    const text = renderNeighbourhood(nb, SOURCE_ID);
    expect(text).toMatch(/no symbol 'nonExistent' found/);
    expect(text).toMatch(/find_symbol/);
  });
});

describe('renderNeighbourhood — foo', () => {
  it('output contains the definition location', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    const text = renderNeighbourhood(nb, SOURCE_ID);
    expect(text).toMatch(/`foo`/);
    expect(text).toMatch(/defined at/);
    expect(text).toMatch(FILE_A);
  });

  it('output lists bar as a caller', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    const text = renderNeighbourhood(nb, SOURCE_ID);
    expect(text).toMatch(/called by:/);
    expect(text).toMatch(/bar/);
  });

  it('output lists file B in imported by', () => {
    const store = seedStore();
    const nb = buildNeighbourhood(store, SOURCE_ID, VERSION, 'foo');
    const text = renderNeighbourhood(nb, SOURCE_ID);
    expect(text).toMatch(/imported by:/);
    expect(text).toMatch(FILE_B);
  });
});
