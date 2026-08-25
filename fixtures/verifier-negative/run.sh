#!/usr/bin/env bash
# verifier-negative/run.sh — verifier-gate negative tests (todo 18).
# Feeds scripts/verify-plan.mjs three poisoned inputs and one clean input:
#   01-cycle        → rejected, issue mentions "dependency cycle"
#   02-overlap      → rejected, issue mentions "same-wave ownership overlap"
#   03-unknown-ref  → rejected, issue names the unknown id 'TASK-999'
#   04-clean        → APPROVE, exit 0
# Read-only over committed case files; no sandbox needed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHGEN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS="$ARCHGEN_ROOT/skill/scripts"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

command -v node >/dev/null 2>&1 || fail "node not found"
[ -f "$SCRIPTS/verify-plan.mjs" ] || fail "verify-plan.mjs not found at $SCRIPTS"

run_case() { # $1=case-dir  $2=expected-substring ("" for clean/APPROVE)
  local dir="$1" expect="$2" out rc issues
  out="$(node "$SCRIPTS/verify-plan.mjs" "$dir/tasks.yaml" --plan "$dir/plans")"
  rc=$?
  if [ -n "$expect" ]; then
    # poisoned: must exit 1 with verdict ISSUES and carry the expected finding
    [ "$rc" -eq 1 ] || fail "$(basename "$dir"): expected exit 1, got $rc — output: $out"
    printf '%s' "$out" | grep -q '"verdict": "ISSUES"' || fail "$(basename "$dir"): verdict not ISSUES"
    issues="$(printf '%s' "$out" | node -e '
let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
  for (const i of JSON.parse(d).issues) console.log("- " + i);
});')"
    printf '%s\n' "$issues" | grep -qF "$expect" \
      || fail "$(basename "$dir"): no issue matching '$expect'. Got:
$issues"
    echo "   $(basename "$dir") rejected with:"
    printf '%s\n' "$issues" | sed 's/^/     /'
    pass "$(basename "$dir"): rejected, issue text matches '$expect'"
  else
    # clean: must exit 0 with verdict APPROVE and zero issues
    [ "$rc" -eq 0 ] || fail "$(basename "$dir"): expected exit 0, got $rc — output: $out"
    printf '%s' "$out" | grep -q '"verdict": "APPROVE"' || fail "$(basename "$dir"): verdict not APPROVE"
    printf '%s' "$out" | grep -q '"issues": \[\]' || fail "$(basename "$dir"): non-empty issues: $out"
    echo "   $(basename "$dir") approved: $out"
    pass "$(basename "$dir"): APPROVE with zero issues"
  fi
}

echo "== verifier-gate negative tests =="
run_case "$SCRIPT_DIR/cases/01-cycle"       "dependency cycle"
run_case "$SCRIPT_DIR/cases/02-overlap"     "same-wave ownership overlap"
run_case "$SCRIPT_DIR/cases/03-unknown-ref" "unknown task id 'TASK-999'"
run_case "$SCRIPT_DIR/cases/04-clean"       ""

echo "VERIFIER-NEGATIVE: ALL CHECKS PASSED"
