#!/usr/bin/env bash
# greenfield-demo/run.sh — deterministic GENERATE (LARGE) end-to-end driver.
# Simulates the full archgen greenfield flow with ZERO LLM calls:
#   interview answers file → artifact generation (templates) → validate.mjs
#   → verify-plan APPROVE → wave walk via next-tasks/set-status → final checks
#   → git-cleanliness proof → tamper test.
# The scripts+templates+conventions are what is under test; "workers" are the
# driver marking statuses and writing simulated logs inside .archgen/ only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHGEN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS="$ARCHGEN_ROOT/skill/scripts"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

command -v node >/dev/null 2>&1 || fail "node not found"
[ "$(node -p 'parseInt(process.versions.node)')" -ge 18 ] || fail "node >= 18 required"
[ -f "$SCRIPTS/validate.mjs" ] || fail "skill scripts not found at $SCRIPTS"

# ── [1/8] sandbox: throwaway git repo so cleanliness is provable ────────────
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/archgen-greenfield.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
printf '# demo sandbox\n' > "$SANDBOX/README.md"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" config user.email fixture@example.invalid
git -C "$SANDBOX" config user.name "Archgen Fixture"
git -C "$SANDBOX" add README.md
git -C "$SANDBOX" commit -qm "seed"
pass "[1/8] sandbox git repo ready at $SANDBOX"

DOT="$SANDBOX/.archgen/demo"
mkdir -p "$DOT/plans" "$DOT/docs" "$DOT/decisions" "$DOT/results"

# ── [2/8] interview: pre-seeded answers file (references/interview.md) ──────
cp "$SCRIPT_DIR/answers.yaml" "$DOT/answers.yaml"
grep -q '^scope_class: LARGE' "$DOT/answers.yaml" || fail "answers.yaml missing scope_class LARGE"
pass "[2/8] interview answers seeded (.archgen/demo/answers.yaml, scope LARGE)"

# ── [3/8] generate artifacts per references/artifact-templates.md shapes ────
cp "$SCRIPT_DIR/architecture.template.yaml" "$DOT/architecture.yaml"
cp "$SCRIPT_DIR/tasks.template.yaml"        "$DOT/tasks.yaml"
cp "$SCRIPT_DIR/plans/demo-platform.md"     "$DOT/plans/demo-platform.md"
cp "$SCRIPT_DIR/docs/c4-context.md"         "$DOT/docs/c4-context.md"
cp "$SCRIPT_DIR/docs/c4-container.md"       "$DOT/docs/c4-container.md"
cp "$SCRIPT_DIR/docs/user-guide.md"         "$DOT/docs/user-guide.md"
cp "$SCRIPT_DIR"/decisions/*.md             "$DOT/decisions/"

# conventions conformance: architecture.yaml carries every normative top-level
# key and its slug names the dot-folder (schemas/architecture-conventions.md).
SCRIPTS="$SCRIPTS" node --input-type=module -e '
import { readFileSync } from "node:fs";
const { parseYaml } = await import("file://" + process.env.SCRIPTS + "/lib/yaml.mjs");
const { data } = parseYaml(readFileSync(process.argv[1], "utf8"), { filename: "architecture.yaml" });
for (const k of ["name", "slug", "stack", "structure", "modules", "decisions"]) {
  if (data[k] === undefined) { console.error("architecture.yaml missing key: " + k); process.exit(1); }
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.slug)) { console.error("bad slug"); process.exit(1); }
console.log("architecture.yaml conforms (" + data.modules.length + " modules, " + data.decisions.length + " decisions)");
' "$DOT/architecture.yaml" || fail "architecture.yaml does not match conventions"
grep -q '```mermaid' "$DOT/docs/c4-context.md" && grep -q '```mermaid' "$DOT/docs/c4-container.md" \
  || fail "mermaid C4 diagrams missing from docs/"
pass "[3/8] LARGE artifact set generated under .archgen/demo/"

TASKS="$DOT/tasks.yaml"

# ── [4/8] self-check: validate.mjs must exit 0 ──────────────────────────────
node "$SCRIPTS/validate.mjs" "$TASKS" 2>&1 | sed 's/^/       /'
node "$SCRIPTS/validate.mjs" "$TASKS" 2>/dev/null || fail "validate.mjs rejected fresh tasks.yaml"
pass "[4/8] validate.mjs exit 0 on generated tasks.yaml"

# ── [5/8] verifier gate: verify-plan.mjs must APPROVE ───────────────────────
verdict_json="$(node "$SCRIPTS/verify-plan.mjs" "$TASKS" --plan "$DOT/plans")" \
  || fail "verify-plan rejected: $verdict_json"
printf '%s' "$verdict_json" | grep -q '"verdict": "APPROVE"' || fail "verdict not APPROVE: $verdict_json"
pass "[5/8] verifier gate APPROVE"

# ── [6/8] START-WORK wave walk: resolve frontier, run wave, repeat ──────────
wave_no=0
while :; do
  wave_no=$((wave_no + 1))
  [ "$wave_no" -gt 12 ] && fail "wave walk did not converge after 12 waves"
  out="$(node "$SCRIPTS/next-tasks.mjs" "$TASKS")" || fail "next-tasks failed on wave $wave_no"
  ids="$(printf '%s' "$out" | node -e '
let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
  const j = JSON.parse(d);
  if ((j.blockedByFailure ?? []).length) { console.error("blockedByFailure: " + j.blockedByFailure.join(",")); process.exit(5); }
  console.log((j.waves[0] ?? []).map((t) => t.id).join(" "));
});') " || fail "next-tasks reported blockedByFailure or bad JSON on wave $wave_no"
  [ -z "${ids// }" ] && break
  echo "   wave $wave_no: $ids"
  for id in $ids; do
    node "$SCRIPTS/set-status.mjs" "$TASKS" "$id" running >/dev/null || fail "set-status running $id"
    # simulated worker success: log lands INSIDE .archgen/ only
    echo "simulated worker ok for $id ($(date -u +%FT%TZ))" > "$DOT/results/$id.log"
    node "$SCRIPTS/set-status.mjs" "$TASKS" "$id" done >/dev/null || fail "set-status done $id"
  done
done
pass "[6/8] wave walk complete ($((wave_no - 1)) waves, all workers succeeded)"

# ── [7/8] final assertions: validate passes, every status done ──────────────
node "$SCRIPTS/validate.mjs" "$TASKS" 2>/dev/null || fail "final validate failed"
SCRIPTS="$SCRIPTS" node --input-type=module -e '
import { readFileSync } from "node:fs";
const { parseYaml } = await import("file://" + process.env.SCRIPTS + "/lib/yaml.mjs");
const { data } = parseYaml(readFileSync(process.argv[1], "utf8"), { filename: "tasks.yaml" });
const bad = data.tasks.filter((t) => t.status !== "done");
if (bad.length) { console.error("not done: " + bad.map((t) => t.id).join(",")); process.exit(1); }
console.log("all " + data.tasks.length + " tasks status=done");
' "$TASKS" || fail "not all tasks reached done"
for f in "$DOT"/results/*.log; do [ -s "$f" ] || fail "empty worker log: $f"; done
pass "[7/8] final validate exit 0 and every task marked done"

# ── git cleanliness: NOTHING outside .archgen/ may appear ───────────────────
cd "$SANDBOX" || fail "cannot cd sandbox"
porcelain="$(git status --porcelain -uall)"
[ -z "$porcelain" ] && fail "flow produced no changes at all — nothing was exercised"
outside="$(printf '%s\n' "$porcelain" | grep -v '^?? \.archgen/' || true)"
[ -n "$outside" ] && fail "writes outside .archgen/: $outside"
git diff HEAD --quiet || fail "tracked files were modified"
changed_count="$(printf '%s\n' "$porcelain" | grep -c '^?? \.archgen/')"
pass "git clean: $changed_count new paths, all under .archgen/; zero tracked modifications"

# ── tamper test: corrupted copy MUST be caught by validate.mjs ──────────────
cp "$TASKS" "$DOT/tasks-tamper.yaml"
node -e '
const fs = require("fs");
const p = process.argv[1];
if (!fs.readFileSync(p, "utf8").includes("status: done")) process.exit(3);
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("status: done", "status: cancelled"));
' "$DOT/tasks-tamper.yaml" || fail "tamper setup failed"
if node "$SCRIPTS/validate.mjs" "$DOT/tasks-tamper.yaml" 2>"$DOT/tamper.err"; then
  fail "validate.mjs accepted corrupted tasks.yaml (status cancelled)"
fi
grep -q "invalid status 'cancelled'" "$DOT/tamper.err" || fail "validate error text unexpected: $(cat "$DOT/tamper.err")"
rm -f "$DOT/tasks-tamper.yaml" "$DOT/tamper.err"
pass "tamper test: corrupted copy rejected with named enum error"

echo "GREENFIELD E2E: ALL CHECKS PASSED"
