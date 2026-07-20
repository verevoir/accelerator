import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shape regression tests for the verdict-surface step of the antagonistic-review
// workflow. Its behaviour lives inline in the YAML (not an extractable script like
// resolve-merge-base.sh / aggregate.sh), so these pin the text shape that must hold —
// zero-dependency, same approach as guardrails' antagonistic-review-gate tests.
// Regexes match whitespace-collapsed text so the YAML's line-wrapping never matters.

const yml = readFileSync(
  fileURLToPath(new URL('../.github/workflows/antagonistic-review.yml', import.meta.url)),
  'utf8'
);
const flat = yml.replace(/\s+/g, ' ');

describe('antagonistic-review.yml — the lens-verdict surface step', () => {
  it('exists, always runs, and is budgeted', () => {
    // if: always() is load-bearing: the review action may exit non-zero on a REJECT,
    // and the skip-on-failure default would suppress the step in exactly the case it
    // exists to show.
    expect(flat).toMatch(
      /name: Surface this lens's verdict as the job conclusion if: always\(\) timeout-minutes: 2/
    );
  });

  it('extracts the verdict via jq with a fail-closed fallback (empty, never APPROVE)', () => {
    // On jq failure `v` becomes EMPTY (≠ APPROVE → reject). "Fixing" it to
    // `|| echo 'APPROVE'` would turn a parse failure into a silent approve.
    expect(flat).toMatch(
      /v="\$\(timeout 10 jq -r '\.verdict \/\/ empty' "\$f" 2>\/dev\/null \|\| echo ''\)"/
    );
  });

  it('fails the job legibly when the panelist wrote no verdict file', () => {
    expect(flat).toMatch(/if \[ ! -f "\$f" \]; then[^]{0,250}produced no verdict[^]{0,250}exit 1/);
  });

  it('bounds the summary jq parse too (not just the verdict parse)', () => {
    // A pathological .summary payload must not hang the step; the summary parse carries
    // the same timeout 10 as the verdict parse. A suffix-only pin (from `head -1`) would
    // pass even if this timeout were reverted, so assert the bound explicitly.
    expect(flat).toMatch(/summary="\$\(timeout 10 jq -r '\.summary \/\/ ""'/);
  });

  it('sanitises the summary: strip CR, %25-encode, then neutralise a line-starting ::', () => {
    // Order is load-bearing and mirrors aggregate.sh's safe(): a literal \r is a runner
    // line terminator (so '\r::set-env' would open a command the ^:: sed never sees) —
    // strip it FIRST; then %-encode before embedding (a %0A/%0D escape would decode
    // inside the `::` value into a newline + fresh command); then neutralise line-start
    // ::. First line only, capped at 300 chars.
    expect(flat).toMatch(
      /head -1 \| cut -c1-300 \| tr -d '\\r' \| sed -e 's\/%\/%25\/g' -e 's\/\^::\/ ::\/'/
    );
  });

  it('surfaces the sanitised summary in the reject ::error', () => {
    expect(flat).toMatch(/rejected::\$\{summary\}/);
  });

  it('keeps the APPROVE echo as the terminal statement (after the last exit 1)', () => {
    // An accidental exit after the APPROVE echo would start blocking every merge.
    const stepAt = yml.indexOf("name: Surface this lens's verdict as the job conclusion");
    expect(stepAt).toBeGreaterThanOrEqual(0);
    const stepBody = yml.slice(stepAt, yml.indexOf('antagonistic-review:', stepAt));
    const approveAt = stepBody.indexOf('echo "${{ matrix.lens }} — APPROVE"');
    expect(approveAt).toBeGreaterThanOrEqual(0);
    expect(approveAt).toBeGreaterThan(stepBody.lastIndexOf('exit 1'));
  });

  it('guards the review job to same-repo heads (fork PRs never reach the panel)', () => {
    // The load-bearing fork control: panelists + org secrets only run for a head in
    // this repo. Dropping this if: would expose the secrets to fork-authored diffs.
    expect(flat).toMatch(
      /review: name: review[^]{0,400}if: github\.event_name == 'workflow_dispatch' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
    );
  });
});
