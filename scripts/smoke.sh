#!/bin/bash
# smoke.sh — test the RELEASE before you publish it.
#
# It installs the packed tarballs — the exact bytes npm would serve — into a
# clean project, then drives the real surfaces: the MCP server over stdio, the
# CLI installer, the harness wiring, and a full plan→verify→wave run.
#
# Nothing here touches the registry, your real project, or your global
# installs. Everything happens in a temp directory.
#
# Usage: bash scripts/smoke.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/archgen-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

pass() { printf "  ✅ %s\n" "$1"; }
fail() { printf "  ❌ %s\n" "$1"; exit 1; }
step() { printf "\n▸ %s\n" "$1"; }

cd "$REPO"

step "1. The version is consistent everywhere"
npm run --silent test:versions >/dev/null || fail "the version surfaces disagree"
npm run --silent sync:check >/dev/null || fail "a derived file is out of sync"
pass "all version surfaces agree"

step "2. The suites pass"
npm run --silent test:mcp >/dev/null || fail "the MCP suite failed"
pass "the MCP suite"
npm run --silent test:cli >/dev/null || fail "the CLI suite failed"
pass "the CLI suite"

step "3. The tarballs build (the exact bytes npm would serve)"
TARBALLS="$(mktemp -d "${TMPDIR:-/tmp}/archgen-tarballs.XXXXXX")"
(cd packages/mcp && npm pack --pack-destination "$TARBALLS" >/dev/null)
(cd packages/cli && npm pack --pack-destination "$TARBALLS" >/dev/null)
ls "$TARBALLS" | sed 's/^/     /'
# The version comes from the canonical config, so a release never has to
# remember to update this file — and a forgotten bump cannot make the smoke
# test assert the OLD tarball name and pass anyway.
VERSION="$(node -p "require('$REPO/archgen.config.json').version")"
[ -f "$TARBALLS/archgen-mcp-$VERSION.tgz" ] || fail "the MCP tarball is missing (expected archgen-mcp-$VERSION.tgz)"
[ -f "$TARBALLS/archgen-skill-$VERSION.tgz" ] || fail "the CLI tarball is missing (expected archgen-skill-$VERSION.tgz)"
pass "both tarballs built ($VERSION)"

step "4. The tarballs install into a clean project"
PROJECT="$WORK/project"
mkdir -p "$PROJECT"
cd "$PROJECT"
npm init -y >/dev/null
npm install --no-audit --no-fund "$TARBALLS"/*.tgz >/dev/null
[ -x node_modules/.bin/archgen-mcp ] || fail "the archgen-mcp binary is not on PATH"
[ -x node_modules/.bin/archgen-skill ] || fail "the archgen-skill binary is not on PATH"
pass "both binaries installed"

step "5. The MCP server answers over its own CLI facade"
node_modules/.bin/archgen-mcp doctor --project "$PROJECT" --json > "$WORK/doctor.json" 2>&1 \
  || fail "the doctor failed: $(cat "$WORK/doctor.json")"
node -e '
  const r = require(process.argv[1]);
  if (!r || typeof r.server !== "string") { console.error("the doctor returned no server version"); process.exit(1); }
  if (r.skill !== null && typeof r.skill !== "object") { console.error("the doctor returned a malformed skill block"); process.exit(1); }
  console.log("     server:", r.server, "| node:", r.node, "| codegraph:", r.codegraph?.version ?? "not installed");
' "$WORK/doctor.json"
pass "the server is reachable and reports its version"

step "6. The tool catalog is complete"
node_modules/.bin/archgen-mcp --catalog > "$WORK/catalog.json" 2>&1 || fail "the catalog failed"
node -e '
  const fs = require("fs");
  const tools = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const names = tools.map((t) => t.name).sort();
  const expected = ["archgen_codegraph","archgen_docs","archgen_help","archgen_plan","archgen_refs","archgen_registry","archgen_setup","archgen_skills","archgen_tasks"];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) { console.error("missing tools:", missing.join(", ")); process.exit(1); }
  const withoutSchema = names.filter((n) => !tools.find((t) => t.name === n).inputSchema);
  if (withoutSchema.length) { console.error("tools without a schema:", withoutSchema.join(", ")); process.exit(1); }
  console.log("     " + names.length + " tools:", names.join(" "));
' "$WORK/catalog.json"
pass "all 9 tools are registered, each with a schema"

step "7. The CLI installs the skill and wires the MCP server"
# An isolated HOME: `init` wires the GLOBAL harness configs, and those live
# in the user's home. A smoke test must never write to the real one.
export HOME="$WORK/home"
mkdir -p "$HOME/.claude" "$HOME/.config/opencode" "$HOME/.codex" "$PROJECT/.claude"
node_modules/.bin/archgen-skill init "$PROJECT" --no-codegraph > "$WORK/init.log" 2>&1 \
  || fail "init failed: $(cat "$WORK/init.log")"
[ -f "$PROJECT/.agents/skills/archgen/SKILL.md" ] || fail "the skill was not installed"
[ -L "$PROJECT/.claude/skills/archgen" ] || fail "the Claude adapter is not a symlink"
pass "the skill store and the Claude symlink"

step "7b. The PROJECT root carries no MCP configuration"
for stray in .mcp.json .codex .gemini .cursor .zed .trae opencode.json opencode.jsonc; do
  [ -e "$PROJECT/$stray" ] && fail "the project root carries '$stray' — the wiring belongs in the harness's own config"
done
pass "the project root is clean"

step "8. The MCP server is wired into the detected harnesses"
WIRED=0
for f in "$HOME/.claude.json" "$HOME/.config/opencode/opencode.json" "$HOME/.codex/config.toml"; do
  [ -f "$f" ] || continue
  case "$f" in
    *.toml)
      grep -q '\[mcp_servers\.archgen\]' "$f" || fail "no [mcp_servers.archgen] in $f"
      echo "     $f -> [mcp_servers.archgen]"
      ;;
    *opencode*)
      # opencode nests its servers at mcp.servers.<id>; an entry under `mcp`
      # alone is invisible to the client.
      node -e '
        const fs = require("fs");
        const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const s = cfg.mcp && cfg.mcp.servers && cfg.mcp.servers.archgen;
        if (!s) { console.error("no archgen entry at mcp.servers.archgen in " + process.argv[1]); process.exit(1); }
        console.log("     " + process.argv[1] + " -> mcp.servers.archgen");
      ' "$f" || fail "the archgen entry is missing or wrong in $f"
      ;;
    *)
      node -e '
        const fs = require("fs");
        const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const s = cfg.mcpServers && cfg.mcpServers.archgen;
        if (!s) { console.error("no archgen entry in " + process.argv[1]); process.exit(1); }
        console.log("     " + process.argv[1] + " -> mcpServers.archgen");
      ' "$f" || fail "the archgen MCP entry is missing or wrong in $f"
      ;;
  esac
  WIRED=1
done
[ "$WIRED" -eq 1 ] || fail "no harness config carries the archgen MCP entry"
pass "the MCP entry is present, well-formed, and where the client reads it"

step "9. The doctor agrees the install is healthy"
node_modules/.bin/archgen-skill doctor "$PROJECT" --check > "$WORK/doctor2.log" 2>&1 || fail "the doctor reported a problem: $(cat "$WORK/doctor2.log")"
grep -E "^Summary:" "$WORK/doctor2.log" | sed 's/^/     /'
pass "the doctor is happy"

step "10. The end-to-end plan → verify → wave flow works"
cd "$REPO"
for f in greenfield-demo brownfield-demo verifier-negative; do
  bash "fixtures/$f/run.sh" >/dev/null 2>&1 || fail "the $f fixture failed"
  pass "the $f fixture"
done

step "11. Uninstalling removes what it installed"
cd "$PROJECT"
node_modules/.bin/archgen-skill uninstall "$PROJECT" > "$WORK/uninstall.log" 2>&1 \
  || fail "uninstall failed: $(cat "$WORK/uninstall.log")"
[ ! -e "$PROJECT/.agents/skills/archgen" ] || fail "the skill store survived the uninstall"
pass "the project uninstall removed the store"

printf "\n════════════════════════════════════════════\n"
printf "  SMOKE TEST PASSED — the release is ready to publish\n"
printf "════════════════════════════════════════════\n"
