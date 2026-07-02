#!/usr/bin/env bash
#
# Require a `Practices:` trailer on every commit that changes source code, so the
# practices a change was held to are recorded as a durable, checkable artefact
# rather than left to the author's memory (STDIO-403). Provisioning before a code
# change is a precondition; this gate makes "did you, and to what bar?" structural
# instead of a thing to remember.
#
# Runs in CI over a pull request's commit range. Also runnable locally as a
# pre-push check:  BASE_SHA=origin/main HEAD_SHA=HEAD scripts/check-practices-trailer.sh
#
# Only commits that touch `src/**.ts` are required to carry the trailer — a
# docs/config/changelog-only commit is not a code change and is exempt.
set -euo pipefail

base="${BASE_SHA:-origin/main}"
head="${HEAD_SHA:-HEAD}"

missing=0
while read -r sha; do
  [ -z "$sha" ] && continue
  # Skip merge commits (more than one parent).
  if [ "$(git rev-list --parents -n1 "$sha" | wc -w)" -gt 2 ]; then continue; fi
  # Only require the trailer when the commit changes source code.
  if ! git diff-tree --no-commit-id --name-only -r "$sha" | grep -qE '^src/.*\.ts$'; then continue; fi
  if ! git log -1 --format=%B "$sha" | grep -qiE '^Practices:[[:space:]]*\S'; then
    echo "::error::commit $(git log -1 --format='%h %s' "$sha") changes source but has no 'Practices:' trailer"
    missing=1
  fi
done < <(git rev-list "${base}..${head}")

if [ "$missing" -ne 0 ]; then
  echo ""
  echo "Every source change must record the practices it was held to (STDIO-403)."
  echo "Provision the work, then add a trailer to the commit message, e.g.:"
  echo ""
  echo "    Practices: threat-modelling, input-validation, automated-testing"
  echo ""
  exit 1
fi

echo "Practices trailer present on all source-changing commits."
