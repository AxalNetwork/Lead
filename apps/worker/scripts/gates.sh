#!/usr/bin/env bash
#
# Local replica of the three "Gate:" steps in .github/workflows/check.yml.
#
# Those gates scan only the lines a change ADDS, so `npm run lint`, `npm run
# typecheck` and `npm test` all pass while CI still rejects the branch — which
# is exactly how a bare console.warn reached a pull request once already. This
# script closes that gap: run it before you push and you see what CI will see.
#
# One deliberate difference from CI: this diffs the merge-base against your
# WORKING TREE rather than against HEAD, so it catches problems before you
# commit, not after. Once committed the two are the same set.
#
# The pathspec carries :(glob) magic for a reason. Plain 'src/**/*.ts' makes
# git require at least one intermediate directory, so it silently skips
# index.ts, scheduled.ts, errors.ts and types.ts — the two entrypoints among
# them. Keep this identical to the pathspec in .github/workflows/check.yml.
#
#   npm run gates            # against origin/main
#   npm run gates -- origin/release
#
set -uo pipefail

BASE="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)" || exit 2

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "gates: base ref '$BASE' not found — try: git fetch origin main" >&2
  exit 2
fi

MB=$(git merge-base "$BASE" HEAD)
CHANGED=$(git diff --name-only --diff-filter=AM "$MB" -- ':(glob)apps/worker/src/**/*.ts' || true)
if [ -z "$CHANGED" ]; then
  echo "gates: no added/modified worker TypeScript files versus $BASE — nothing to check."
  exit 0
fi

echo "gates: scanning added lines in $(echo "$CHANGED" | wc -l | tr -d ' ') file(s) versus $BASE"
BAD=0

# $1 = label, $2 = message CI prints, rest = the filter pipeline for added lines
check () {
  local label="$1" message="$2"; shift 2
  local hit=0 f added
  for f in $CHANGED; do
    added=$(git diff "$MB" -- "$f" | grep -E '^\+[^+]' | "$@" || true)
    if [ -n "$added" ]; then
      printf 'FAIL [%s] %s\n       %s\n' "$label" "$f" "$message"
      echo "$added" | sed 's/^/       /'
      hit=1
    fi
  done
  if [ "$hit" -eq 0 ]; then printf 'ok   [%s]\n' "$label"; fi
  return "$hit"
}

check console \
  'new bare console.error/warn — use logError(env, { err }) from src/db/error_log.ts' \
  grep -E 'console\.(error|warn)\(' || BAD=1

check sql \
  'SQL string interpolation in new code — use prepare(...).bind(...) parameter binding' \
  grep -iE '(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)[^"`]*\$\{' || BAD=1

# The fetch gate needs two greps in sequence, so it does not fit `check`.
fetch_gate () {
  local hit=0 f added
  for f in $CHANGED; do
    added=$(git diff "$MB" -- "$f" \
      | grep -E '^\+[^+]' \
      | grep -E '(^|[^a-zA-Z_])fetch\(' \
      | grep -vE '(signal|AbortSignal|httpFetch|env\.[A-Z_]+\.fetch|BROWSER\.fetch|AI_SEARCH\.fetch)' || true)
    if [ -n "$added" ]; then
      printf 'FAIL [%s] %s\n       %s\n' fetch "$f" \
        'raw fetch() without signal/timeout — use httpFetch() with AbortSignal.timeout(...)'
      echo "$added" | sed 's/^/       /'
      hit=1
    fi
  done
  if [ "$hit" -eq 0 ]; then printf 'ok   [%s]\n' fetch; fi
  return "$hit"
}
fetch_gate || BAD=1

if [ "$BAD" -ne 0 ]; then
  echo
  echo "gates: at least one gate would fail in CI (see FAIL lines above)."
fi
exit "$BAD"
