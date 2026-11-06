#!/usr/bin/env bash
# verifier-negative/run.sh — the verifier gate's NEGATIVE suite.
# Feeds archgen_plan{verify} three poisoned inputs and one clean input:
#   01-cycle           → dependency cycle
#   02-overlap         → same-wave file_ownership overlap
#   03-unknown-ref     → dangling depends_on
#   04-clean           → must APPROVE
# Every case goes through the REAL archgen MCP tool surface.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHGEN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP="$ARCHGEN_ROOT/packages/mcp/bin/archgen-mcp.mjs"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

command -v node >/dev/null 2>&1 || fail "node not found"
[ "$(node -p 'parseInt(process.versions.node)')" -ge 20 ] || fail "node >= 20 required"
[ -f "$MCP" ] || fail "archgen MCP server not found at $MCP"
[ -d "$ARCHGEN_ROOT/packages/mcp/node_modules" ] || fail "run 'npm ci --prefix packages/mcp' first"

# mcp_exec <tool> <json-args> — run one archgen MCP tool in a case directory.
mcp_exec() { node "$MCP" exec "$1" "$2" --project "$3"; }

check_rejected() {
  local dir="$1" label="$2" expect="$3"
  local out
  out="$(mcp_exec archgen_plan "{\"action\":\"verify\",\"tasksYaml\":\"$dir/tasks.yaml\",\"planDir\":\"$dir/plans\"}" "$dir" 2>&1 || true)"
  printf '%s' "$out" | grep -q '"verdict": "ISSUES"' || fail "$label was NOT rejected: $out"
  printf '%s' "$out" | grep -qi "$expect" || fail "$label rejected for the wrong reason (expected '$expect'): $out"
  pass "$label rejected"
}

check_approved() {
  local dir="$1" label="$2"
  local out
  out="$(mcp_exec archgen_plan "{\"action\":\"verify\",\"tasksYaml\":\"$dir/tasks.yaml\",\"planDir\":\"$dir/plans\"}" "$dir" 2>&1 || true)"
  printf '%s' "$out" | grep -q '"verdict": "APPROVE"' || fail "$label was NOT approved: $out"
  pass "$label approved"
}

check_rejected "$SCRIPT_DIR/cases/01-cycle"      "01-cycle"      "cycle"
check_rejected "$SCRIPT_DIR/cases/02-overlap"    "02-overlap"    "ownership overlap"
check_rejected "$SCRIPT_DIR/cases/03-unknown-ref" "03-unknown-ref" "unknown\|not found\|dangling"
check_approved "$SCRIPT_DIR/cases/04-clean"      "04-clean"

echo "VERIFIER-NEGATIVE E2E: ALL CHECKS PASSED"
