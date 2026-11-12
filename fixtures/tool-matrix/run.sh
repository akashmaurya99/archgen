#!/usr/bin/env bash
# tool-matrix/run.sh — EVERY tool action, through the REAL MCP server.
#
# WHY THIS EXISTS: the in-process action matrix
# (packages/mcp/test/contract/action-matrix.test.mjs) proves the handlers
# work. This proves the WHOLE path works: the real binary, the real stdio
# transport, the real argument parsing, the real envelope.
#
# It exists because two capabilities shipped DEAD and the unit tests did not
# notice:
#   - `archgen_plan{action:'graph'}` threw `ReferenceError: opts is not
#     defined` on every call, for every project, forever;
#   - `archgen_docs{action:'section', section:'<slug>'}` failed on every plan,
#     because the whole argument was treated as a FILE path — while the
#     digest handed out section SLUGS.
#
# Every call below must return ok:true. A typed failure is a finding for a
# NEGATIVE case, not for this script.
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

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/archgen-toolmatrix.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

DOT="$SANDBOX/.archgen/demo"
mkdir -p "$DOT/plans" "$DOT/docs" "$DOT/decisions"

cat > "$DOT/tasks.yaml" <<'YAML'
tasks:
  - id: SCAFFOLD
    title: Scaffold project skeleton and typed config loading
    depends_on: []
    file_ownership: ["src/config/**"]
    acceptance:
      - "npm run build exits 0"
  - id: SHARED
    title: Implement shared logging and error envelope helpers
    depends_on: [SCAFFOLD]
    file_ownership: ["src/shared/**"]
    acceptance:
      - "logger emits structured json lines"
  - id: API
    title: Notes REST API with validation
    depends_on: [SCAFFOLD, SHARED]
    file_ownership: ["src/features/api/**"]
    acceptance:
      - "GET /notes returns the seeded list"
  - id: WEB
    title: Admin console pages wired to the API client
    depends_on: [SCAFFOLD, SHARED]
    file_ownership: ["src/features/web/**"]
    acceptance:
      - "console renders the notes list from the live API"
  - id: VERIFY
    title: End-to-end smoke suite across api and web
    depends_on: [API, WEB]
    file_ownership: ["tests/e2e/**"]
    acceptance:
      - "smoke suite completes the happy path"
YAML

cat > "$DOT/plans/demo-platform.md" <<'MD'
# Demo Platform — generation plan (LARGE)

Wave plan: SCAFFOLD, then SHARED, then API and WEB in parallel, then VERIFY.

Every task id above carries objective acceptance criteria in tasks.yaml.
MD

cat > "$DOT/docs/prd.md" <<'MD'
# PRD — Demo platform

## Problem statement & goals
Ship a notes platform with an admin console.

## Functional requirements — Notes
- FR-NOTES-01 — a user can list and create notes
- FR-NOTES-02 — an empty body is rejected

## Non-functional requirements
- Performance: renders without a network request.
- Accessibility: semantic landmarks, keyboard navigation, visible focus.

## Success metrics
- p95 response under 200ms.
MD

cat > "$DOT/docs/user-guide.md" <<'MD'
# User guide

## Install
Run the installer.

## First run
Open the console.
MD

cat > "$DOT/decisions/0001-local-services.md" <<'MD'
# 1. Use local typed services

## Context
The demo has no backend.

## Decision
Ship typed local services.

## Consequences
The API is replaceable.
MD

printf '# Demo project\n\nProse that must survive a registry rewrite.\n\n<!-- archgen:features:start -->\n| Feature | Status | Updated |\n| --- | --- | --- |\n<!-- archgen:features:end -->\n' > "$SANDBOX/AGENTS.md"

TASKS="$DOT/tasks.yaml"
PLANS="$DOT/plans"

# mcp <tool> <json> — call a tool through the REAL server and assert ok:true.
CALLS=0
mcp() {
  local tool="$1" args="$2" label="$3"
  CALLS=$((CALLS + 1))
  local out
  out="$(node "$MCP" exec "$tool" "$args" --project "$SANDBOX" 2>&1)"
  if ! printf '%s' "$out" | grep -q '"ok": true'; then
    echo "--- $label ---" >&2
    printf '%s\n' "$out" >&2
    fail "$label did not return ok:true"
  fi
  printf '%s' "$out" > "$SANDBOX/.last.json"
}

echo "── archgen_plan ───────────────────────────────────────────"
mcp archgen_plan "{\"action\":\"validate\",\"tasksYaml\":\"$TASKS\"}" "plan/validate"
mcp archgen_plan "{\"action\":\"verify\",\"tasksYaml\":\"$TASKS\",\"planDir\":\"$PLANS\"}" "plan/verify"
mcp archgen_plan "{\"action\":\"graph\",\"tasksYaml\":\"$TASKS\"}" "plan/graph json"
mcp archgen_plan "{\"action\":\"graph\",\"tasksYaml\":\"$TASKS\",\"format\":\"mermaid\"}" "plan/graph mermaid"
mcp archgen_plan "{\"action\":\"graph\",\"tasksYaml\":\"$TASKS\",\"format\":\"mermaid\",\"status\":true}" "plan/graph mermaid+status"
mcp archgen_plan "{\"action\":\"graph\",\"tasksYaml\":\"$TASKS\",\"node\":\"API\"}" "plan/graph node"
mcp archgen_plan "{\"action\":\"graph\",\"tasksYaml\":\"$TASKS\",\"module\":\"src/features/api\"}" "plan/graph module"
mcp archgen_plan "{\"action\":\"impact\",\"tasksYaml\":\"$TASKS\",\"target\":\"API\"}" "plan/impact"
mcp archgen_plan "{\"action\":\"coverage\",\"tasksYaml\":\"$TASKS\",\"planDir\":\"$PLANS\"}" "plan/coverage"
mcp archgen_plan "{\"action\":\"scaffold\",\"scope\":\"LARGE\",\"slug\":\"demo\"}" "plan/scaffold"
mcp archgen_plan "{\"action\":\"brief\",\"kind\":\"verifier\",\"tasksYaml\":\"$TASKS\"}" "plan/brief verifier (tasks.yaml alone)"
mcp archgen_plan "{\"action\":\"brief\",\"kind\":\"review\",\"tasksYaml\":\"$TASKS\"}" "plan/brief review"
mcp archgen_plan "{\"action\":\"brief\",\"kind\":\"survey\",\"slug\":\"demo\",\"featureRequest\":\"a notes app\"}" "plan/brief survey"
mcp archgen_plan "{\"action\":\"brief\",\"kind\":\"investigate\",\"tasksYaml\":\"$TASKS\",\"topic\":\"auth\",\"round\":1}" "plan/brief investigate"
pass "archgen_plan — 13 actions"

echo "── archgen_tasks ──────────────────────────────────────────"
mcp archgen_tasks "{\"action\":\"next\",\"tasksYaml\":\"$TASKS\"}" "tasks/next"
mcp archgen_tasks "{\"action\":\"list\",\"tasksYaml\":\"$TASKS\"}" "tasks/list"
mcp archgen_tasks "{\"action\":\"list\",\"tasksYaml\":\"$TASKS\",\"filterStatus\":\"pending\"}" "tasks/list filtered"
mcp archgen_tasks "{\"action\":\"contract\",\"tasksYaml\":\"$TASKS\",\"taskId\":\"API\"}" "tasks/contract"
mcp archgen_tasks "{\"action\":\"snapshot\",\"tasksYaml\":\"$TASKS\"}" "tasks/snapshot"
mcp archgen_tasks "{\"action\":\"set_status\",\"tasksYaml\":\"$TASKS\",\"taskId\":\"API\",\"status\":\"running\"}" "tasks/set_status"
pass "archgen_tasks — 6 actions"

echo "── archgen_docs ───────────────────────────────────────────"
mcp archgen_docs "{\"action\":\"index\"}" "docs/index"
mcp archgen_docs "{\"action\":\"digest\"}" "docs/digest"
mcp archgen_docs "{\"action\":\"validate\"}" "docs/validate"
mcp archgen_docs "{\"action\":\"section\",\"section\":\"non-functional-requirements\"}" "docs/section by SLUG"
mcp archgen_docs "{\"action\":\"section\",\"section\":\"demo/docs/prd.md#non-functional-requirements\"}" "docs/section by path#anchor"
mcp archgen_docs "{\"action\":\"section\",\"section\":\"demo/docs/prd.md\"}" "docs/section by path"
mcp archgen_docs "{\"action\":\"refs\",\"token\":\"FR-NOTES-01\"}" "docs/refs"
mcp archgen_docs "{\"action\":\"map\",\"token\":\"FR-NOTES-01\"}" "docs/map"
pass "archgen_docs — 8 actions"

echo "── archgen_registry ───────────────────────────────────────"
mcp archgen_registry "{\"action\":\"show\"}" "registry/show"
mcp archgen_registry "{\"action\":\"update\",\"slug\":\"demo\",\"status\":\"planned\"}" "registry/update"
pass "archgen_registry — 2 actions"

echo "── archgen_setup / archgen_codegraph (read + unapproved) ──"
mcp archgen_setup "{\"action\":\"doctor\"}" "setup/doctor"
mcp archgen_setup "{\"action\":\"harness_info\"}" "setup/harness_info"
mcp archgen_setup "{\"action\":\"harnesses\"}" "setup/harnesses"
mcp archgen_setup "{\"action\":\"install_mcp\"}" "setup/install_mcp (unapproved -> plan)"
mcp archgen_setup "{\"action\":\"uninstall_mcp\"}" "setup/uninstall_mcp (unapproved -> plan)"
mcp archgen_codegraph "{\"action\":\"status\"}" "codegraph/status"
mcp archgen_codegraph "{\"action\":\"wire\",\"noInstall\":true}" "codegraph/wire (unapproved -> plan)"
mcp archgen_codegraph "{\"action\":\"ensure\",\"noInstall\":true}" "codegraph/ensure (unapproved -> plan)"
pass "archgen_setup + archgen_codegraph — 8 actions"

echo "── archgen_skills ─────────────────────────────────────────"
mcp archgen_skills "{\"action\":\"list\"}" "skills/list"
mcp archgen_skills "{\"action\":\"installed\"}" "skills/installed"
mcp archgen_skills "{\"action\":\"match\",\"title\":\"Build the dashboard UI\",\"fileOwnership\":[\"src/features/web/**\"]}" "skills/match"
mcp archgen_skills "{\"action\":\"load\",\"skillId\":\"ui-baseline\"}" "skills/load (not installed -> hint)"
mcp archgen_skills "{\"action\":\"digest\",\"skillId\":\"ui-baseline\"}" "skills/digest (not installed -> hint)"
mcp archgen_skills "{\"action\":\"install\",\"skillId\":\"ui-baseline\"}" "skills/install (unapproved -> plan)"
pass "archgen_skills — 6 actions"

echo "── archgen_refs ───────────────────────────────────────────"
mcp archgen_refs "{\"action\":\"list\"}" "refs/list"
mcp archgen_refs "{\"action\":\"index\",\"topic\":\"orchestration\"}" "refs/index"
mcp archgen_refs "{\"action\":\"read\",\"topic\":\"orchestration\"}" "refs/read whole"
mcp archgen_refs "{\"action\":\"read\",\"topic\":\"orchestration\",\"section\":\"dispatch--wave-execution\"}" "refs/read one section"
mcp archgen_refs "{\"action\":\"search\",\"topic\":\"orchestration\",\"token\":\"APPROVE\"}" "refs/search"
pass "archgen_refs — 5 actions"

echo "── archgen_help ───────────────────────────────────────────"
for topic in plan tasks docs registry codegraph setup skills refs all; do
  mcp archgen_help "{\"topic\":\"$topic\"}" "help/$topic"
done
pass "archgen_help — 9 topics"

echo ""
echo "── the three original failures, re-checked ────────────────"
node "$MCP" exec archgen_plan "{\"action\":\"graph\",\"tasksYaml\":\"$TASKS\",\"format\":\"mermaid\",\"status\":true}" --project "$SANDBOX" \
  | grep -q '"ok": true' || fail "the graph action is still broken"
pass "the graph action works (was: opts is not defined)"

node "$MCP" exec archgen_docs "{\"action\":\"section\",\"section\":\"non-functional-requirements\"}" --project "$SANDBOX" \
  | grep -q '"ok": true' || fail "the section-by-slug call is still broken"
pass "a bare section slug resolves (was: NOT_FOUND)"

node "$MCP" exec archgen_plan "{\"action\":\"brief\",\"kind\":\"verifier\",\"tasksYaml\":\"$TASKS\"}" --project "$SANDBOX" \
  | grep -q '"ok": true' || fail "the brief still demands the slug"
pass "a brief derives its own paths from tasks.yaml (was: pass slug)"

# The brief must carry no literal placeholder, and the contract must not
# carry the old `<Domain>` one.
# The output is captured FIRST: a pipe into grep makes a CRASHING tool look
# like a clean one — the pipeline fails, the `&&` never fires, and the
# assertion passes on an empty answer.
brief_out="$(node "$MCP" exec archgen_plan "{\"action\":\"brief\",\"kind\":\"verifier\",\"tasksYaml\":\"$TASKS\"}" --project "$SANDBOX" 2>&1 || true)"
[ -n "$brief_out" ] || fail "the brief call produced no answer"
printf '%s' "$brief_out" | grep -q '<slug dir>' && fail "the brief still carries a literal placeholder"
pass "the brief carries no literal placeholder"

contract_out="$(node "$MCP" exec archgen_tasks "{\"action\":\"contract\",\"tasksYaml\":\"$TASKS\",\"taskId\":\"API\"}" --project "$SANDBOX" 2>&1 || true)"
[ -n "$contract_out" ] || fail "the worker contract call produced no answer"
printf '%s' "$contract_out" | grep -q '<Domain>' && fail "the worker contract still carries <Domain>"
pass "the worker contract carries no <Domain> placeholder"

echo ""
echo "TOOL-MATRIX E2E: ALL CHECKS PASSED ($CALLS calls)"
