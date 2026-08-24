#!/usr/bin/env bash
# brownfield-demo/run.sh — deterministic BROWNFIELD survey→plan end-to-end.
# ZERO LLM calls: the SURVEY sub-agent is simulated by a static-analysis stub
# (find/grep over the real fixture project) writing codebase-map.md; planning
# is a committed MEDIUM-sized artifact pair. Under test: right-sizing (artifact
# set equality), ownership against real paths, impact.mjs pin, verifier APPROVE.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHGEN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPTS="$ARCHGEN_ROOT/skills/archgen/scripts"
SLUG="demo-brownfield"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

command -v node >/dev/null 2>&1 || fail "node not found"
[ "$(node -p 'parseInt(process.versions.node)')" -ge 18 ] || fail "node >= 18 required"
[ -f "$SCRIPTS/impact.mjs" ] || fail "skill scripts not found at $SCRIPTS"

# ── [1/7] sandbox git repo seeded with the pre-existing TS project ──────────
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/archgen-brownfield.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT
cp -R "$SCRIPT_DIR/project" "$SANDBOX/project"
git -C "$SANDBOX" init -q
git -C "$SANDBOX" config user.email fixture@example.invalid
git -C "$SANDBOX" config user.name "Archgen Fixture"
git -C "$SANDBOX" add -A
git -C "$SANDBOX" commit -qm "seed: existing notes service"
SRC="$SANDBOX/project/src"
[ -f "$SRC/server.ts" ] && [ -f "$SRC/shared/logger.ts" ] || fail "seed project incomplete"
pass "[1/7] sandbox ready with existing TS project (server, routes, index, shared/logger)"

DOT="$SANDBOX/.archgen/$SLUG"
mkdir -p "$DOT/plans"

# ── [2/7] SURVEY step — static stub per orchestration.md §survey contract ───
# Real read-only analysis of the seeded tree feeds the four required sections;
# every claim cites a path that actually exists (the §survey VERIFY rule).
{
  echo "# codebase-map — $SLUG"
  echo
  echo "## Structure"
  echo
  echo '```'
  ( cd "$SANDBOX/project" && find . -type f | sort | sed 's|^\./|  |' )
  echo '```'
  echo
  echo "## Modules"
  echo
  echo "| module | responsibility | key entry points |"
  echo "| --- | --- | --- |"
  echo "| server | http lifecycle and request logging | src/server.ts |"
  echo "| routes | request dispatch table | src/routes.ts |"
  echo "| shared | cross-cutting structured logging | src/shared/logger.ts |"
  echo
  echo "## Conventions"
  echo
  for sym in $(grep -h '^export' "$SRC"/server.ts "$SRC"/routes.ts "$SRC"/shared/logger.ts \
                 | sed -E 's/^export (function|const) ([A-Za-z0-9_]+).*/\2/' | sort); do
    echo "- named export \`$sym\` (observed via grep over src)"
  done
  echo "- errors handled at the dispatch boundary in src/routes.ts"
  echo "- no test layout present yet"
  echo
  echo "## Affected"
  echo
  echo "- src/server.ts — limiter core lands beside createServer (evidence: src/server.ts)"
  echo "- src/routes.ts — per-route budgets attach in handleRoute (evidence: src/routes.ts)"
  echo "- src/shared/logger.ts — limit events reuse the emit helper (evidence: src/shared/logger.ts)"
} > "$DOT/codebase-map.md"

for section in "## Structure" "## Modules" "## Conventions" "## Affected"; do
  grep -qF "$section" "$DOT/codebase-map.md" || fail "codebase-map.md missing required section: $section"
done
# every cited path must exist (§survey VERIFY rule)
for p in src/server.ts src/routes.ts src/shared/logger.ts; do
  grep -qF "$p" "$DOT/codebase-map.md" || fail "codebase-map.md does not cite $p"
  [ -f "$SANDBOX/project/$p" ] || fail "codebase-map cites non-existent path $p"
done
pass "[2/7] survey stub wrote codebase-map.md (all 4 sections, evidence paths verified)"

# ── [3/7] MEDIUM-sized plan for the rate-limit feature ──────────────────────
cp "$SCRIPT_DIR/tasks.template.yaml"     "$DOT/tasks.yaml"
cp "$SCRIPT_DIR/plans/add-rate-limit.md" "$DOT/plans/add-rate-limit.md"
TASKS="$DOT/tasks.yaml"
node "$SCRIPTS/validate.mjs" "$TASKS" 2>&1 | sed 's/^/       /'
node "$SCRIPTS/validate.mjs" "$TASKS" 2>/dev/null || fail "validate.mjs rejected brownfield tasks.yaml"
pass "[3/7] MEDIUM artifacts written and validated (plan + tasks only)"

# ── [4/7] ownership references EXISTING project paths ───────────────────────
SCRIPTS="$SCRIPTS" node --input-type=module -e '
const { parseYaml } = await import("file://" + process.env.SCRIPTS + "/lib/yaml.mjs");
import { readFileSync } from "node:fs";
const { data } = parseYaml(readFileSync(process.argv[1], "utf8"), { filename: "tasks.yaml" });
const globs = data.tasks.flatMap((t) => t.file_ownership ?? []);
if (!globs.length) { console.error("no file_ownership found"); process.exit(1); }
console.log(globs.join("\n"));
' "$TASKS" > /tmp/archgen-ownership.$$ 2>/dev/null || fail "could not extract file_ownership"
while IFS= read -r g; do
  [ -n "$g" ] || continue
  [ -f "$SANDBOX/project/$g" ] || fail "file_ownership references non-existent path: $g"
done < /tmp/archgen-ownership.$$
rm -f /tmp/archgen-ownership.$$
pass "[4/7] every file_ownership glob resolves to an existing tracked path"

# ── [5/7] right-sizing proof: artifact set is EXACTLY three files ───────────
actual="$(cd "$SANDBOX" && find .archgen -type f | sed 's|^\.archgen/||' | sort)"
expected="$(printf '%s\n' \
  "$SLUG/codebase-map.md" \
  "$SLUG/plans/add-rate-limit.md" \
  "$SLUG/tasks.yaml" | sort)"
if [ "$actual" != "$expected" ]; then
  fail "artifact set mismatch — right-sizing violated.
--- expected ---
$expected
--- actual ---
$actual"
fi
pass "[5/7] artifact set == exactly {codebase-map.md, tasks.yaml, plans/add-rate-limit.md}"

# ── [6/7] impact pin: changing RL1 ripples to exactly RL2+RL3 ───────────────
if ! diff -u "$SCRIPT_DIR/expected-impact.json" <(node "$SCRIPTS/impact.mjs" "$TASKS" RL1); then
  fail "impact.mjs output differs from pinned expected-impact.json"
fi
pass "[6/7] impact.mjs(RL1) byte-equals pinned expected-impact.json"

# ── [7/7] verifier checklist produced with APPROVE ──────────────────────────
verdict_json="$(node "$SCRIPTS/verify-plan.mjs" "$TASKS" --plan "$DOT/plans")" \
  || fail "verify-plan rejected: $verdict_json"
printf '%s' "$verdict_json" | grep -q '"verdict": "APPROVE"' || fail "verdict not APPROVE: $verdict_json"
echo "   verifier checklist: $verdict_json" | tr '\n' ' '; echo
pass "[7/7] verifier gate APPROVE"

# ── git cleanliness: nothing outside .archgen/ touched ──────────────────────
cd "$SANDBOX" || fail "cannot cd sandbox"
porcelain="$(git status --porcelain -uall)"
[ -z "$porcelain" ] && fail "flow produced no changes at all"
outside="$(printf '%s\n' "$porcelain" | grep -v '^?? \.archgen/' || true)"
[ -n "$outside" ] && fail "writes outside .archgen/: $outside"
git diff HEAD --quiet || fail "tracked files were modified"
pass "git clean: all new paths under .archgen/; zero tracked modifications"

echo "BROWNFIELD E2E: ALL CHECKS PASSED"
