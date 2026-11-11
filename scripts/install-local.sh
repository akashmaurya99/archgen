#!/usr/bin/env bash
# install-local.sh — install the UNPUBLISHED build into a project, for testing.
#
#   scripts/install-local.sh <project-dir> [--location-project] [--no-codegraph] [--check]
#
# WHY THIS EXISTS.
#
# A build that is not on the registry cannot be tested with `npx
# archgen-skill init` — that installs the PUBLISHED packages. So a local test
# has to point two things at this checkout:
#
#   - the SKILL comes from this repo's CLI (its vendored copy, which
#     `npm run sync` keeps identical to `skill/`);
#   - the MCP entry points at this repo's server, via `ARCHGEN_MCP_BIN`.
#
# The MCP is wired GLOBALLY by default — one server for every harness, the
# way a published install behaves. `--location-project` puts it in the
# project instead.
#
# Nothing is published, and the global server install is left untouched.
#
# EXIT CODES
#   0  installed (or verified) and healthy
#   1  a step failed
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO/packages/cli/bin/archgen.mjs"
SERVER="$REPO/packages/mcp/bin/archgen-mcp.mjs"

TARGET=""
LOCATION_PROJECT=0
NO_CODEGRAPH=0
CHECK_ONLY=0

die() { printf '\033[31minstall-local:\033[0m %s\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --location-project) LOCATION_PROJECT=1; shift ;;
    --no-codegraph) NO_CODEGRAPH=1; shift ;;
    --check) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option '$1'" ;;
    *) [ -n "$TARGET" ] && die "one project directory, please"; TARGET="$1"; shift ;;
  esac
done

[ -n "$TARGET" ] || die "usage: scripts/install-local.sh <project-dir> [--location-project] [--no-codegraph] [--check]"
[ -d "$TARGET" ] || die "no such directory: $TARGET"
TARGET="$(cd "$TARGET" && pwd)"

[ -f "$CLI" ] || die "the local CLI is missing: $CLI"
[ -f "$SERVER" ] || die "the local server is missing: $SERVER"
[ -d "$REPO/packages/mcp/node_modules" ] || die "the server's dependencies are missing — run: npm ci --prefix packages/mcp"

step "the build under test"
printf '   repo   %s\n' "$REPO"
printf '   skill  %s\n' "$(node -e "console.log(require('$REPO/archgen.config.json').version)")"
printf '   server %s\n' "$(node "$SERVER" exec archgen_help '{"topic":"all"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).meta.serverVersion))")"

if [ "$CHECK_ONLY" -eq 1 ]; then
  step "what is installed in $TARGET"
  if [ -f "$TARGET/.agents/skills/archgen/SKILL.md" ]; then
    printf '   skill  %s\n' "$(node -e "
      const t=require('fs').readFileSync('$TARGET/.agents/skills/archgen/SKILL.md','utf8');
      console.log((/version:\s*(\S+)/.exec(t)||[])[1] ?? 'unknown');
    ")"
  else
    printf '   skill  NOT INSTALLED\n'
  fi
  printf '   mcp    %s\n' "$(node "$SERVER" exec archgen_help '{"topic":"all"}' >/dev/null && echo "local server reachable")"
  exit 0
fi

step "keeping the vendored skill identical to skill/"
( cd "$REPO" && npm run sync >/dev/null ) || die "npm run sync failed"

step "installing into $TARGET"
# ARCHGEN_MCP_BIN is the override the server's own resolver honours: the
# wiring then points at THIS build's binary instead of a published one.
export ARCHGEN_MCP_BIN="$SERVER"
INIT_ARGS=(init "$TARGET")
[ "$LOCATION_PROJECT" -eq 1 ] && INIT_ARGS+=(--location-project)
[ "$NO_CODEGRAPH" -eq 1 ] && INIT_ARGS+=(--no-codegraph)
node "$CLI" "${INIT_ARGS[@]}"

step "verifying"
# The doctor resolves the skill relative to ITS project root, so it must run
# against the target — not against this repo.
( cd "$TARGET" && node "$SERVER" exec archgen_setup '{"action":"doctor"}' ) > /tmp/archgen-local-doctor.json 2>/dev/null || true
node - <<'NODE'
const fs = require('fs');
const out = JSON.parse(fs.readFileSync('/tmp/archgen-local-doctor.json', 'utf8'));
const d = out.data ?? {};
console.log(`   doctor  ${d.status} — ${d.summary ?? ''}`);
console.log(`   versions: skill ${d.versions?.skill ?? 'none'} · server ${d.versions?.server ?? 'none'}`);
if (d.serverActions) {
  console.log(`   server actions: ${(d.serverActions.archgen_plan ?? []).join(', ')}`);
}
if (d.checks?.length) {
  for (const c of d.checks) console.log(`   ${c.status}: ${c.msg}`);
}
NODE

# The MCP entry the client will actually use. The MCP is wired GLOBALLY by
# default (one server for every harness); `--location-project` puts it in
# the project instead.
if [ "$LOCATION_PROJECT" -eq 1 ]; then
  printf '   MCP config (project):\n'
  for cfg in "$TARGET/.mcp.json" "$TARGET/.cursor/mcp.json" "$TARGET/.vscode/mcp.json" "$TARGET/opencode.json"; do
    [ -f "$cfg" ] || continue
    printf '      %s\n' "${cfg#"$TARGET"/}"
  done
else
  printf '   MCP config (global):\n'
  for cfg in "$HOME/.claude.json" "$HOME/.config/opencode/opencode.json" "$HOME/.codex/config.toml"; do
    [ -f "$cfg" ] || continue
    grep -q "$SERVER" "$cfg" 2>/dev/null && printf '      %s → local build\n' "$cfg"
  done
fi

printf '\n\033[32mThe local build is installed.\033[0m\n'
printf '   MCP command: %s\n' "$SERVER"
printf '   Skill:       %s/.agents/skills/archgen\n' "$TARGET"
printf '\n   Revert the MCP wiring:  %s uninstall-mcp --yes\n' "$SERVER"
printf '   Restart the client session so it re-fetches the tool catalog.\n'
