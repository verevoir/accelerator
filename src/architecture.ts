import { contextStore } from '@verevoir/context';
import { edgesForItem } from '@verevoir/context/code';
import type { ContextStore } from '@verevoir/context';

// ARCHITECTURE — deterministic architectural-conformance checks over the code graph's
// import edges. A rule forbids a set of files (by path glob) from importing a set of
// modules (by import-specifier glob): layering ("domain must not import infra"), a banned
// dependency, "no node builtins in the UI layer". This is the `architecture-boundaries`
// practice made MECHANICAL — a project's OWN structural rules, which off-the-shelf
// scanners (Snyk / SAST) don't know. It is specifier-based: it reads the import as
// written; resolving a relative specifier to the file it points at is a later pass.

export interface ArchRule {
  /** Glob over file paths this rule applies to, e.g. `src/domain/**`. */
  from: string;
  /** Glob over import specifiers that are forbidden — a package name (`legacy-utils`), a
   * builtin (`node:*`), or a path fragment (a double-star matching an infra path). */
  forbid: string;
  /** Why — surfaced on the violation. */
  reason?: string;
}

export interface ArchViolation {
  file: string;
  module: string;
  line: number;
  rule: ArchRule;
}

/** Compile a `*` / `**` glob to an anchored RegExp. A double-star matches across `/`
 * (and swallows a following slash, so a leading double-star also matches at the root); a
 * single star matches within a segment; every other regex metacharacter is escaped. */
const REGEX_META = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/x` also matches `x` at the root
      } else {
        re += '[^/]*';
      }
    } else if (REGEX_META.has(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const matches = (glob: string, value: string): boolean => globToRegExp(glob).test(value);

/** Check a source's import graph against architectural rules, returning every violation —
 * a file matching a rule's `from` that imports a module matching its `forbid`. Deterministic
 * and specifier-based: it reads the import as written, across every language the code graph
 * parses. */
export function checkArchitecture(
  store: ContextStore,
  sourceUrl: string,
  version: string,
  rules: ArchRule[]
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  if (rules.length === 0) return violations;
  for (const itemId of store.listIndexedItems(sourceUrl, version)) {
    const edges = edgesForItem(store, sourceUrl, version, itemId);
    if (!edges) continue;
    for (const imp of edges.imports) {
      if (!imp.module) continue; // e.g. a bare `import './styles.css'` side-effect with no module name
      for (const rule of rules) {
        if (matches(rule.from, itemId) && matches(rule.forbid, imp.module)) {
          violations.push({ file: itemId, module: imp.module, line: imp.line, rule });
        }
      }
    }
  }
  return violations;
}

/** Convenience wrapper over the singleton store — for the MCP tool / a capability verify. */
export function queryArchitecture(
  sourceUrl: string,
  version: string,
  rules: ArchRule[]
): ArchViolation[] {
  return checkArchitecture(contextStore, sourceUrl, version, rules);
}
