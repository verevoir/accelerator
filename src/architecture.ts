import { edgesForItem } from '@verevoir/context/code';
import type { ContextStore } from '@verevoir/context';

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

const REGEX_META = new Set(['.', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/** Compile a `*` / `**` glob to an anchored RegExp. A `**` followed by `/` matches any
 * number of leading path segments (including none) anchored at a segment boundary — so a
 * double-star-slash `infra` pattern matches `infra` and `x/infra`, but NOT `notinfra`; a
 * bare `**` matches anything across segments; a single `*` matches within one segment;
 * other regex metacharacters are escaped. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // a boundary-anchored `**/`: optional leading segments, never a mid-segment match
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
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
