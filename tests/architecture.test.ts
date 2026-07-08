import { describe, it, expect } from 'vitest';
import { createContextStore } from '@verevoir/context';
import type { ContextStore } from '@verevoir/context';
import { checkArchitecture, globToRegExp } from '../src/architecture.js';

const SOURCE_ID = '/test-repo';
const VERSION = '';

/** Seed a store with `{ path: source }` files. */
function seed(files: Record<string, string>): ContextStore {
  const store = createContextStore();
  for (const [itemId, content] of Object.entries(files)) {
    store.setContent({ sourceId: SOURCE_ID, version: VERSION, itemId }, content);
  }
  return store;
}

const check = (store: ContextStore, rules: Parameters<typeof checkArchitecture>[3]) =>
  checkArchitecture(store, SOURCE_ID, VERSION, rules);

describe('globToRegExp', () => {
  it('* matches within a segment but not across a slash', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/sub/a.ts')).toBe(false);
  });

  it('** matches across segments', () => {
    expect(globToRegExp('src/**').test('src/sub/deep/a.ts')).toBe(true);
  });

  it('**/x matches x at any depth including the root', () => {
    expect(globToRegExp('**/infra').test('@org/infra')).toBe(true);
    expect(globToRegExp('**/infra').test('infra')).toBe(true);
    expect(globToRegExp('**/infra').test('src/other')).toBe(false);
  });

  it('** is anchored at a segment boundary — it does not match a partial segment', () => {
    expect(globToRegExp('**/infra').test('notinfra')).toBe(false);
    expect(globToRegExp('**/infra').test('xinfra')).toBe(false);
    expect(globToRegExp('**/infra').test('x/infra')).toBe(true);
  });

  it('a single star spans one segment, a double star spans subpaths (node:* vs node:**)', () => {
    expect(globToRegExp('node:*').test('node:fs')).toBe(true);
    expect(globToRegExp('node:*').test('node:fs/promises')).toBe(false); // * stops at the slash
    expect(globToRegExp('node:**').test('node:fs/promises')).toBe(true); // ** crosses it
  });

  it('escapes regex metacharacters so a dotted specifier matches literally', () => {
    expect(globToRegExp('app.infra.db').test('app.infra.db')).toBe(true);
    expect(globToRegExp('app.infra.db').test('appXinfraXdb')).toBe(false);
  });
});

describe('checkArchitecture — forbidden dependency edges', () => {
  it('flags a domain file importing an infra module (a layering violation)', () => {
    const store = seed({
      'src/domain/user.ts': "import { db } from '../infra/db';\nexport function u() { return db; }",
      'src/infra/db.ts': 'export const db = {};',
    });
    const v = check(store, [
      { from: 'src/domain/**', forbid: '**/infra/**', reason: 'domain must not depend on infra' },
    ]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: 'src/domain/user.ts', module: '../infra/db' });
    expect(v[0].rule.reason).toContain('domain must not depend on infra');
  });

  it('does not flag an allowed import within the same layer', () => {
    const store = seed({
      'src/domain/user.ts':
        "import { Id } from '../domain/id';\nexport function u() { return Id; }",
      'src/domain/id.ts': 'export const Id = 1;',
    });
    expect(check(store, [{ from: 'src/domain/**', forbid: '**/infra/**' }])).toHaveLength(0);
  });

  it('flags a banned package imported from anywhere', () => {
    const store = seed({ 'src/a.ts': "import x from 'legacy-utils';\nexport const a = x;" });
    const v = check(store, [{ from: '**', forbid: 'legacy-utils' }]);
    expect(v).toHaveLength(1);
    expect(v[0].module).toBe('legacy-utils');
  });

  it('flags a node builtin imported into a forbidden layer', () => {
    const store = seed({
      'src/ui/button.ts': "import { readFile } from 'node:fs';\nexport const b = readFile;",
    });
    expect(check(store, [{ from: 'src/ui/**', forbid: 'node:*' }])).toHaveLength(1);
  });

  it('reports the line the forbidden import sits on', () => {
    const store = seed({ 'src/a.ts': "\nimport y from 'banned';\nexport const a = y;" });
    expect(check(store, [{ from: '**', forbid: 'banned' }])[0].line).toBe(2);
  });

  it('returns nothing for an empty ruleset', () => {
    const store = seed({ 'src/a.ts': "import x from 'anything';\nexport const a = x;" });
    expect(check(store, [])).toEqual([]);
  });

  it('is language-agnostic — flags a Python layering violation too', () => {
    const store = seed({
      'app/domain/user.py': 'from app.infra.db import conn\n',
      'app/infra/db.py': 'conn = 1\n',
    });
    const v = check(store, [{ from: 'app/domain/**', forbid: '**infra**' }]);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: 'app/domain/user.py', module: 'app.infra.db' });
  });
});
