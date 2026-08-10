import { describe, it, expect } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(
  new URL('../.github/antagonistic-review/resolve-merge-base.sh', import.meta.url)
);

// Start from process.env (PATH etc.), but strip any repo-pointing git vars the
// runner environment might carry — they would redirect the fixture's git operations.
const {
  GIT_DIR: _d,
  GIT_WORK_TREE: _w,
  GIT_INDEX_FILE: _i,
  GIT_OBJECT_DIRECTORY: _o,
  ...cleanEnv
} = process.env;
const GIT_ENV = {
  ...cleanEnv,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: GIT_ENV, timeout: 20000 });
  return stdout.trim();
}

/** A clone of a local bare origin whose history is the wrong-diff shape the script
 * exists for: feature branched at A, then the base advanced to B. Returns the shas
 * so each test picks the (BASE_REF, BASE_SHA, HEAD_SHA) triple it needs. */
async function repoFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rmb-'));
  try {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    await run('git', ['init', '--bare', '-b', 'main', origin], { env: GIT_ENV });
    await run('git', ['clone', origin, work], { env: GIT_ENV });
    await writeFile(join(work, 'f'), 'a\n');
    await git(work, 'add', 'f');
    await git(work, 'commit', '-m', 'A');
    const a = await git(work, 'rev-parse', 'HEAD');
    await git(work, 'push', 'origin', 'main');
    await git(work, 'checkout', '-b', 'feature');
    await writeFile(join(work, 'f'), 'a\nfeature\n');
    await git(work, 'commit', '-am', 'C');
    const head = await git(work, 'rev-parse', 'HEAD');
    await git(work, 'checkout', 'main');
    await writeFile(join(work, 'g'), 'b\n');
    await git(work, 'add', 'g');
    await git(work, 'commit', '-m', 'B');
    const b = await git(work, 'rev-parse', 'HEAD');
    await git(work, 'push', 'origin', 'main');
    return { dir, work, a, b, head };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

async function resolve(
  work: string,
  env: Partial<
    Record<
      'BASE_REF' | 'BASE_SHA' | 'HEAD_SHA' | 'GITHUB_ENV' | 'GIT_OP_TIMEOUT' | 'LC_ALL',
      string
    >
  >,
  pathOverride?: string,
  omitGithubEnv = false
): Promise<{ code: number; stdout: string; stderr: string; exported: string }> {
  const githubEnv = env.GITHUB_ENV ?? join(work, 'github-env');
  if (!omitGithubEnv && env.GITHUB_ENV === undefined) await writeFile(githubEnv, '');
  const runEnv = { ...GIT_ENV } as NodeJS.ProcessEnv;
  delete runEnv.BASE_REF;
  delete runEnv.BASE_SHA;
  delete runEnv.HEAD_SHA;
  delete runEnv.GITHUB_ENV;
  Object.assign(runEnv, env);
  if (!omitGithubEnv && env.GITHUB_ENV === undefined) runEnv.GITHUB_ENV = githubEnv;
  if (pathOverride) runEnv.PATH = pathOverride;
  try {
    const { stdout, stderr } = await run('bash', [SCRIPT], {
      cwd: work,
      env: runEnv,
      timeout: 20000,
    });
    return { code: 0, stdout, stderr, exported: await readFile(githubEnv, 'utf8') };
  } catch (e) {
    const err = e as {
      code?: number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    // A killed subprocess is a hang, not a verdict — fail the test loudly.
    if (err.killed || err.signal) {
      throw new Error(
        `resolve-merge-base.sh was killed (${err.signal ?? 'timeout'}) — hung, not failed`
      );
    }
    let exported = '';
    try {
      exported = await readFile(githubEnv, 'utf8');
    } catch {
      /* the missing-GITHUB_ENV test never creates the file */
    }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', exported };
  }
}

const FULL = (env: Partial<Record<string, string>>) => ({
  BASE_REF: 'main',
  BASE_SHA: 'aaa1111',
  HEAD_SHA: 'bbb2222',
  ...env,
});

// Per-test bound set ABOVE the helper's 20s subprocess cap, matching the other
// gate-script suites.
describe('resolve-merge-base.sh — the diff range the panel reviews', { timeout: 25_000 }, () => {
  it('resolves against the LIVE base ref, not the frozen event sha', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      // BASE_SHA is deliberately set to HEAD: a script that consulted the frozen sha
      // first would compute merge-base(HEAD, HEAD) = HEAD and fail the vacuous guard.
      // Passing proves the live base ref wins.
      const { code, exported } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: head,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits the divergence-point diagnostic on the happy path', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      const { code, stdout } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: a,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(stdout).toContain(`merge base: ${a} (divergence point of live 'main' and head)`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the frozen event sha when the base ref is not fetchable', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'deleted-branch',
        BASE_SHA: a,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(stdout).toContain('falling back to the frozen event sha');
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the frozen sha when the base ref fetches but shares no history with HEAD', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      // an orphan branch on origin: the fetch succeeds, but merge-base(origin/orphan,
      // HEAD) exits non-zero — the FIRST sub-expression's failure, distinct from the
      // unfetchable-ref case
      await git(work, 'checkout', '--orphan', 'orphan');
      await git(work, 'rm', '-rf', '.');
      await writeFile(join(work, 'o'), 'o\n');
      await git(work, 'add', 'o');
      await git(work, 'commit', '-m', 'O');
      await git(work, 'push', 'origin', 'orphan');
      await git(work, 'checkout', 'main');
      const { code, exported } = await resolve(work, {
        BASE_REF: 'orphan',
        BASE_SHA: a,
        HEAD_SHA: head,
      });
      expect(code).toBe(0);
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when neither the live ref nor the frozen sha yields a merge base', async () => {
    const { dir, work, head } = await repoFixture();
    try {
      const bogus = '0123456789abcdef0123456789abcdef01234567';
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'deleted-branch',
        BASE_SHA: bogus,
        HEAD_SHA: head,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('No merge base');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when HEAD is already contained in the live base ref (vacuous pass)', async () => {
    const { dir, work, a, b } = await repoFixture();
    try {
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: a,
        HEAD_SHA: b,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('No reviewable diff');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on the vacuous pass even when HEAD_SHA is ABBREVIATED', async () => {
    // git merge-base emits a full 40-char sha; an abbreviated head that resolves to the
    // same commit must still trip the guard. Without canonicalising the head, the string
    // comparison never matches and the guard fails OPEN.
    const { dir, work, a, b } = await repoFixture();
    try {
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: a,
        HEAD_SHA: b.slice(0, 10),
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('No reviewable diff');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed via the fallback path when the frozen sha IS the head (vacuous pass)', async () => {
    const { dir, work, head } = await repoFixture();
    try {
      // unfetchable ref forces the frozen-sha fallback, and BASE_SHA == HEAD_SHA makes
      // the merge base HEAD itself — the vacuous guard must fire on this path too
      const { code, stdout, exported } = await resolve(work, {
        BASE_REF: 'deleted-branch',
        BASE_SHA: head,
        HEAD_SHA: head,
      });
      expect(code).not.toBe(0);
      expect(stdout).toContain('No reviewable diff');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a PR that merged main in but has its own commits passes (distinct merge base)', async () => {
    const { dir, work, b, head } = await repoFixture();
    try {
      // merge the advanced main into feature: head moves past B, but the merge base
      // with main becomes B — distinct from the new head, so the diff is reviewable
      await git(work, 'checkout', 'feature');
      await git(work, 'merge', '--no-edit', 'main');
      const merged = await git(work, 'rev-parse', 'HEAD');
      expect(merged).not.toBe(head);
      const { code, exported } = await resolve(work, {
        BASE_REF: 'main',
        BASE_SHA: b,
        HEAD_SHA: merged,
      });
      expect(code).toBe(0);
      expect(exported).toContain(`MERGE_BASE=${b}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const missing of ['BASE_REF', 'BASE_SHA', 'HEAD_SHA', 'GITHUB_ENV'] as const) {
    it(`fails closed when required env ${missing} is unset`, async () => {
      const { dir, work, a, head } = await repoFixture();
      try {
        const env = FULL({ BASE_SHA: a, HEAD_SHA: head }) as Record<string, string>;
        delete env[missing];
        const { code } = await resolve(work, env, undefined, missing === 'GITHUB_ENV');
        expect(code).not.toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it(`fails closed when required env ${missing} is the empty string (distinct from unset)`, async () => {
      const { dir, work, a, head } = await repoFixture();
      try {
        const env = FULL({ BASE_SHA: a, HEAD_SHA: head, [missing]: '' }) as Record<string, string>;
        const { code } = await resolve(work, env);
        expect(code).not.toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  // Both positions of the validation loop, across the boundary cases the retired
  // diff-guard suite carried: non-hex/option-injection, too short, over-long, uppercase.
  for (const position of ['BASE_SHA', 'HEAD_SHA'] as const) {
    for (const bad of ['--upload-pack=evil', 'abc12', 'a'.repeat(41), 'AAA1111']) {
      it(`fails closed on invalid ${position} '${bad.slice(0, 20)}', never echoing it back`, async () => {
        const { dir, work, a, head } = await repoFixture();
        try {
          const env = { BASE_REF: 'main', BASE_SHA: a, HEAD_SHA: head, [position]: bad };
          const { code, stdout } = await resolve(work, env);
          expect(code).not.toBe(0);
          expect(stdout).toContain('Invalid sha');
          // the rejected value is never echoed back (no injection vector) — the
          // assertion the retired diff-guard suite carried, preserved here
          expect(stdout).not.toContain(bad);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it('fails closed on a base ref with option-injection or forbidden characters', async () => {
    const { dir, work, a, head } = await repoFixture();
    try {
      for (const ref of ['-evil', 'a b', 'x;y']) {
        const { code, stdout } = await resolve(work, {
          BASE_REF: ref,
          BASE_SHA: a,
          HEAD_SHA: head,
        });
        expect(code).not.toBe(0);
        expect(stdout).toContain('Invalid base ref');
        expect(stdout).not.toContain(ref); // rejected value never echoed back
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still resolves (the timeout wrapper is transparent) when coreutils timeout is absent from PATH', async () => {
    const { dir, work, a, head } = await repoFixture();
    const bin = await mkdtemp(join(tmpdir(), 'nobin-'));
    try {
      // a PATH carrying every external command the script needs EXCEPT timeout —
      // exercising bounded()'s fallback branch
      for (const tool of ['bash', 'git']) {
        const { stdout: p } = await run('which', [tool]);
        await symlink(p.trim(), join(bin, tool));
      }
      const { code, exported } = await resolve(
        work,
        { BASE_REF: 'main', BASE_SHA: a, HEAD_SHA: head },
        bin
      );
      expect(code).toBe(0);
      expect(exported).toContain(`MERGE_BASE=${a}`);
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed if the head will not canonicalise even though a merge base was found', async () => {
    // Contrived via a git shim (unreachable in a real repo: a merge base implies the head
    // resolves). The shim passes everything to real git EXCEPT `rev-parse …^{commit}`,
    // which it fails — proving the guard exits closed rather than comparing a raw head.
    const { dir, work, a, head } = await repoFixture();
    const bin = await mkdtemp(join(tmpdir(), 'gitshim-'));
    try {
      const { stdout: realGit } = await run('which', ['git']);
      await writeFile(
        join(bin, 'git'),
        `#!/usr/bin/env bash\nif [ "$1" = "rev-parse" ]; then exit 1; fi\nexec ${realGit.trim()} "$@"\n`,
        { mode: 0o755 }
      );
      const { stdout: realBash } = await run('which', ['bash']);
      await symlink(realBash.trim(), join(bin, 'bash'));
      const { code, stdout, exported } = await resolve(
        work,
        { BASE_REF: 'main', BASE_SHA: a, HEAD_SHA: head },
        `${bin}:${process.env.PATH}`
      );
      expect(code).not.toBe(0);
      expect(stdout).toContain('Unresolvable head');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when a git op exceeds its bound (GIT_OP_TIMEOUT fires, not a hang)', async () => {
    // Env-overridable bound (like aggregate.sh's JQ_BOUNDED_TIMEOUT): shrink it to 1s and
    // make merge-base sleep past it via a git shim. bounded() kills it, mb is empty, and
    // the script fails closed on "No merge base" rather than hanging to the step envelope.
    const { dir, work, a, head } = await repoFixture();
    const bin = await mkdtemp(join(tmpdir(), 'gitslow-'));
    try {
      const { stdout: realGit } = await run('which', ['git']);
      await writeFile(
        join(bin, 'git'),
        `#!/usr/bin/env bash\nif [ "$1" = "merge-base" ]; then sleep 3; fi\nexec ${realGit.trim()} "$@"\n`,
        { mode: 0o755 }
      );
      for (const tool of ['bash', 'timeout']) {
        const { stdout: p } = await run('which', [tool]);
        await symlink(p.trim(), join(bin, tool));
      }
      const { code, stdout, exported } = await resolve(
        work,
        { BASE_REF: 'main', BASE_SHA: a, HEAD_SHA: head, GIT_OP_TIMEOUT: '1' },
        `${bin}:${process.env.PATH}`
      );
      expect(code).not.toBe(0);
      expect(stdout).toContain('No merge base');
      expect(exported).not.toContain('MERGE_BASE=');
    } finally {
      await rm(bin, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Same 25s bound as the suite above, and for the same reason: the helper's own
// 20s subprocess cap is what turns a hang into `hung, not failed`, and a
// vitest-level timeout firing first would abort the test before that
// diagnostic is ever produced.
describe('the sha guard survives a hostile locale', { timeout: 25_000 }, () => {
  // WHY THIS EXISTS: `case "$sha" in *[!0-9a-f]*)` is a bracket expression, and a
  // range like `a-f` is COLLATION-ordered, not byte-ordered. Under a locale that
  // interleaves case, 'A' sorts inside a-f, the pattern does not match, and the
  // guard ACCEPTS a non-hex string — a fail-open in the one check standing between
  // an attacker-controlled ref and a git command line. The script pins LC_ALL=C to
  // stop that.
  //
  // The existing 'AAA1111' cases above do NOT cover this: they inherit whatever
  // locale the host happens to have, so they pass on a CI runner whether the fix
  // is present or not. This block sets the hostile locale deliberately.

  /** A probe is a `case` statement; five seconds is already absurdly generous. */
  const PROBE_TIMEOUT_MS = 5_000;

  /**
   * A locale on this host under which `[!0-9a-f]` collates case-insensitively,
   * or `null` if there is none.
   *
   * Probed rather than assumed, because which locales are generated differs by
   * machine. If none is hostile the test cannot discriminate, and it says so
   * instead of passing — a green test that could not have failed is worse than an
   * absent one, because it reads as protection.
   */
  function findHostileLocale(): string | null {
    for (const locale of ['en_US.UTF-8', 'en_GB.UTF-8']) {
      const probe = spawnSync(
        'bash',
        ['-c', 'case "A" in *[!0-9a-f]*) exit 1 ;; *) exit 0 ;; esac'],
        {
          env: { ...process.env, LC_ALL: locale },
          // `spawnSync` blocks the event loop until the child exits, so a bash
          // that stalls (locale initialisation on a misconfigured box is the
          // realistic one) hangs the whole runner with no bound. A probe is not
          // worth that risk.
          timeout: PROBE_TIMEOUT_MS,
        }
      );
      // A probe that could not run, or was killed on its timeout, tells us
      // NOTHING about this locale — it is not evidence that the locale is safe.
      // Move on rather than reading a non-answer as "not hostile".
      if (probe.error || probe.signal !== null) continue;
      // exit 0 means 'A' did NOT match [!0-9a-f] — i.e. it collated INSIDE a-f.
      if (probe.status === 0) return locale;
    }
    return null;
  }

  /**
   * Resolved ONCE, at collection time, because `it.skipIf` needs the answer
   * before the test is registered — which is the whole point of the change.
   */
  const HOSTILE_LOCALE = findHostileLocale();

  it('pins the collation before the first guard that depends on it', async () => {
    // THE TEST THAT RUNS EVERYWHERE — and the reason a structural assertion is
    // correct here, not a smell:
    //
    // The fail-open is only OBSERVABLE on a host that has a case-interleaving
    // locale generated. Standard CI runners do not, so the behavioural cases
    // below skip there — green, and unable to notice the fix being deleted. A
    // guard whose only test skips on the machine that gates merges is not a
    // tested guard.
    //
    // Structural assertions are usually wrong because they pin implementation
    // detail that a refactor should be free to change. Here the structure IS the
    // behaviour: `export LC_ALL=C` is not an implementation choice — it is the
    // only mechanism that makes the bracket expressions byte-ordered rather than
    // collation-ordered, and that mechanism must be in place before the first
    // guard fires. Any refactor that preserves the guards necessarily preserves
    // this line. There is no observable output to assert on that a test running
    // under a CI locale (already C/POSIX) could distinguish from the fix being
    // absent — so this structural check is the only check that runs where merges
    // are gated.
    const script = await readFile(SCRIPT, 'utf8');
    // Anchored to the CODE line, not the first textual match: the comment above
    // the pin quotes the pattern as an example, and an unanchored search would
    // find the prose and compare against the wrong position.
    const pin = /^\s*export LC_ALL=C\s*$/m.exec(script);
    const shaGuard = /^\s*case "\$sha" in \*\[!0-9a-f\]\*/m.exec(script);
    const refGuard = /^\s*-\* \| \*\[!A-Za-z0-9\._\/-\]\*\)/m.exec(script);

    expect(pin, 'the script must export LC_ALL=C').not.toBeNull();
    expect(shaGuard, 'the sha guard must still be a bracket expression').not.toBeNull();
    expect(refGuard, 'the BASE_REF guard must still be a bracket expression').not.toBeNull();
    // Exported, not merely assigned: git and any subshell must see it too.
    // The pin must precede BOTH guards — sha first in source order, then ref.
    expect(
      pin!.index,
      'the pin must come BEFORE the sha guard it protects'
    ).toBeLessThan(shaGuard!.index);
    expect(
      pin!.index,
      'the pin must come BEFORE the BASE_REF guard it protects'
    ).toBeLessThan(refGuard!.index);
  });

  // `skipIf`, not an early `return`. A bare `return` inside an `it` body exits
  // WITHOUT throwing, so vitest records the test as PASSED having asserted nothing
  // — on every CI runner, which has no case-interleaving locale. `skipIf` makes
  // the report say SKIPPED, which is the honest word for it.
  it.skipIf(HOSTILE_LOCALE === null)(
    'rejects a non-hex sha even when the environment asks for case-insensitive collation',
    async () => {
      const locale = HOSTILE_LOCALE as string;
      const { dir, work, a, head } = await repoFixture();
      try {
        const { code, stdout } = await resolve(work, {
          BASE_REF: 'main',
          BASE_SHA: a,
          HEAD_SHA: 'AAA1111',
          LC_ALL: locale,
        });
        expect(code, `the guard must not fail open under ${locale}`).not.toBe(0);
        expect(stdout).toContain('Invalid sha');
        // Still never echoed back, whatever the locale.
        expect(stdout).not.toContain('AAA1111');
        void head;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  // WHY THERE IS NO BEHAVIOURAL TEST FOR THE BASE_REF GUARD HERE:
  //
  // The BASE_REF guard is `case "$BASE_REF" in -* | *[!A-Za-z0-9._/-]*)`. For a
  // locale-collation fail-open to occur, a character that SHOULD be rejected
  // would need to collate inside one of the allowed ranges and thereby be treated
  // as part of the class (not matched by `[!...]`).
  //
  // The sha guard is exposed because its class `[0-9a-f]` is narrow — uppercase
  // A-F collate inside `a-f` under case-interleaving locales, so `A` looks valid.
  // The attack input (`AAA1111`) is itself a plausible-looking sha, and uppercase
  // is meaningful: it represents real hex digits that the guard is meant to
  // reject.
  //
  // The BASE_REF guard's class `[A-Za-z0-9._/-]` already includes BOTH cases
  // explicitly. Under case-interleaving collation, `A-Z` widens to encompass some
  // lowercase letters, and `a-z` widens to encompass some uppercase — but the
  // class already covers the full alphabetic range. What widens is NOT the set of
  // dangerous characters: shell metacharacters (`;`, `|`, `$`, `&`, newline,
  // backtick) have code points well outside the letter ranges and do not sort
  // inside `A-Z` or `a-z` under any standard locale. The only characters that
  // could be pulled in are accented letters (e.g. `é` between `e` and `f`), but
  // those are not command-injection vectors.
  //
  // Conclusion: the BASE_REF guard does not have the same case-interleaving
  // fail-open as the sha guard. Adding a behavioural test that cannot actually
  // fail on any real input would be worse than no test — it reads as coverage and
  // provides none. The structural assertion above (pin precedes both guards) is
  // the correct and sufficient addition.
});
