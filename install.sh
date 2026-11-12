#!/usr/bin/env bash
# POSIX-only (Linux/macOS). On Windows use the cross-platform equivalent:
#   npx archgen-skill init   (or: npx archgen-skill install)
# every flag here has a matching --flag on the CLI; parity is enforced by
# packages/cli tests + the managed-block byte comparison.
# install.sh — multi-harness installer for the archgen skill.
# Zero dependencies beyond coreutils; no sudo; no network.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/skill"

# THE VERSION IS READ, NEVER WRITTEN.
#
# `skill/archgen.config.json` is the canonical config, derived from the repo
# root by `npm run sync`. install.sh renders the managed block's provenance
# stamp from it, so this script carries NO version literal: a release cannot
# forget to update it, and it can never disagree with the CLI — which reads
# the same config.
ARCHGEN_VERSION=""
read_archgen_version() {
  ARCHGEN_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SOURCE/archgen.config.json" 2>/dev/null | head -1)"
  [ -n "$ARCHGEN_VERSION" ] || die "cannot read the version from $SOURCE/archgen.config.json — run 'npm run sync' in the repository first"
}

MODE="link"
PROJECT_ARG=""
UNINSTALL=0
INIT=0
INIT_DIR=""
CODEGRAPH=1
MCP=1
# The server wiring is GLOBAL by default: the server is one binary for every
# harness, and a project that carries its own .mcp.json has to be re-wired in
# every clone. `--location-project` opts into the per-project wiring.
LOCATION="global"

usage() {
  cat <<EOF
Usage: install.sh [--copy] [--project <dir>] [--uninstall] [--no-codegraph]

  --copy            make real copies instead of symlinks (default: symlink)
  --project <dir>   create + install into <dir>/.github/skills (GitHub Copilot,
                    project-local); without it .github/skills is used only when
                    it already exists under the current working directory
  --uninstall       remove exactly what a previous run recorded in
                    \$HOME/.archgen-install-manifest.list (no-op exit 0 if none)
  --init [dir]      project setup: create the canonical skill store at
                    <dir>/.agents/skills/archgen (the only real copy), symlink
                    <dir>/.claude/skills/archgen -> ../../.agents/skills/archgen
                    (skipped gracefully when symlinks are unavailable), and
                    generate AGENTS.md / CLAUDE.md pointer blocks so every
                    agent harness auto-discovers archgen (default dir: cwd).
                    Also bootstraps the servers: wires the archgen MCP server
                    into every detected harness, and ensures CodeGraph (its
                    CLI, its MCP entry, and the project index — kept live by
                    the server's file watcher).
  --no-codegraph    opt out of the CodeGraph bootstrap (the MCP wiring stays)
  --no-mcp          opt out of the archgen MCP wiring
  --location-global wire the MCP servers globally (default)
  --location-project wire the MCP servers into THIS project as well
  -h, --help        show this help

Targets (installed only when the directory already exists):
  \$HOME/.claude/skills           Claude Code / Claude Desktop
  \$HOME/.agents/skills           agentskills.io generic layout (Zed reads this flat)
  \$HOME/.config/opencode/skills  OpenCode
  \$HOME/.cursor/skills           Cursor
  .github/skills                 GitHub Copilot (project-local)

Platforms not covered here: npx skills add akashmaurya99/archgen
EOF
}

warn() { printf 'install.sh: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

# Prune dev-only + OBSOLETE subtrees from a copied store (CLI parity:
# DEV_ONLY_RELPATHS / OBSOLETE_RELPATHS in packages/cli/lib/store.js).
# The repo's own node:test suite never ships to end users; hashDir ignores it
# on both sides too. The scripts/ tree is OBSOLETE: the skill no longer ships
# code (every capability moved into the archgen MCP server), so a store carried
# over from the pre-MCP layout must shed it.
#
# 'scripts' is removed only when the PACKAGED tree no longer ships it — the
# same rule the CLI's pruneObsolete() applies (findObsolete() skips a relpath
# the package still carries). Removing it unconditionally would delete a
# directory the installer itself had just shipped, if the skill ever grew
# scripts/ again. $2 is the packaged (vendor) tree.
prune_dev_only() { # $1 = installed store root, $2 = packaged tree root
  [ -d "$1/scripts/test" ] && rm -rf -- "$1/scripts/test"
  if [ ! -d "$2/scripts" ] && [ -d "$1/scripts" ]; then rm -rf -- "$1/scripts"; fi
  find "$1" -name '.DS_Store' -o -name 'Thumbs.db' -o -name 'desktop.ini' 2>/dev/null | while IFS= read -r f; do rm -f -- "$f"; done
  return 0
}

# ---- Installer safety helpers (parity with packages/cli/lib/store.js) -------
# lstat-style refusal: [ -L ] inspects the link itself, never its target. A
# pre-existing symlink at a write target (supply-chain attack: a malicious
# clone plants a link at the target) aborts the install instead of writing
# through it.
refuse_symlink() { # $1 = path
  [ -L "$1" ] || return 0
  die "Refusing to write through symlink at $1 — use --copy or remove symlink"
}

# Physical (all symlinks resolved) path of an existing directory.
phys_of() { (cd -- "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"; }

# Realpath-escape check: refuse when $1 resolves outside base dir $2.
refuse_escape() { # $1 = path, $2 = base dir
  [ -e "$1" ] || [ -L "$1" ] || return 0
  base_phys="$(phys_of "$2")"
  case "$(phys_of "$1")" in
    "$base_phys" | "$base_phys"/*) return 0 ;;
    *) die "Refusing to write through symlink at $1 — use --copy or remove symlink" ;;
  esac
}

[ -n "${HOME:-}" ] || die '$HOME is not set; cannot resolve target directories.'
MANIFEST="$HOME/.archgen-install-manifest.list"
# The project roots a previous run installed into. The uninstall allowlist is
# built from THESE, not from the current working directory: an install made
# from one directory must still be removable from another.
ROOTS_FILE="$HOME/.archgen-install-roots.list"
[ -d "$SOURCE" ] || die "skill source not found: $SOURCE"

# The destinations a global install may create. A manifest entry is acted on
# ONLY when it names one of them.
#
# The previous rule was a SUFFIX test (`*/skills/archgen`), so ANY path with
# that ending was removable — including a directory the installer never
# touched. The allowlist is EXACT: the four known harness destinations plus
# the project-local destination of every root this machine recorded.
allowed_dest() { # $1 = path from the manifest
  p="${1%/}"
  for d in "$HOME/.claude/skills/archgen" "$HOME/.agents/skills/archgen" \
           "$HOME/.config/opencode/skills/archgen" "$HOME/.cursor/skills/archgen"; do
    [ "$p" = "${d%/}" ] && return 0
  done
  if [ -f "$ROOTS_FILE" ]; then
    while IFS= read -r root; do
      [ -n "$root" ] || continue
      [ "$p" = "${root%/}/.github/skills/archgen" ] && return 0
    done < "$ROOTS_FILE"
  fi
  return 1
}

# Record a destination in the uninstall manifest. A manifest that cannot be
# written strands the install forever: the next uninstall finds nothing.
manifest_add() { # $1 = kind, $2 = path
  have_entry "$(printf '%s\t%s' "$1" "$2")" && return 0
  if ! printf '%s\t%s\n' "$1" "$2" >> "$MANIFEST"; then
    printf '%-8s %-5s %s\n' FAILED - "$2 (could not record the uninstall manifest)"
    failed=$((failed+1))
    return 1
  fi
  return 0
}

# Record a project root so the uninstall can recognise its project-local
# destination later — from any working directory.
roots_add() { # $1 = project root
  r="${1%/}"
  grep -Fqx -- "$r" "$ROOTS_FILE" 2>/dev/null && return 0
  printf '%s\n' "$r" >> "$ROOTS_FILE" 2>/dev/null || return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --copy)      MODE="copy"; shift ;;
    --project)   [ $# -ge 2 ] || die '--project requires a path argument'; PROJECT_ARG="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-codegraph) CODEGRAPH=0; shift ;;
    --no-mcp)    MCP=0; shift ;;
    --location-project) LOCATION="project"; shift ;;
    --location-global)  LOCATION="global"; shift ;;
    --init)
      INIT=1; shift
      # The project directory is an OPTIONAL positional argument — and only
      # when it is not a flag. Consuming the next argument whatever it was
      # made `--init --no-codegraph` fail with "cannot enter directory".
      if [ $# -gt 0 ]; then
        case "$1" in
          -*) ;;
          *) INIT_DIR="$1"; shift ;;
        esac
      fi
      ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

# --init and --uninstall are two different jobs. The --init branch used to
# win silently: the uninstall request was ignored and the script reported a
# successful INSTALL.
if [ "$INIT" -eq 1 ] && [ "$UNINSTALL" -eq 1 ]; then
  die "--init and --uninstall cannot be combined — run them separately"
fi

# ---- Uninstall: remove exactly the manifest-recorded entries ----------------
# ---- --init: project-local canonical store + context pointer files ----------
if [ "$INIT" -eq 1 ]; then
  ROOT="$(cd -- "${INIT_DIR:-$PWD}" && pwd)" || die "cannot enter directory: ${INIT_DIR:-$PWD}"

  # The version is read BEFORE anything is written. It used to be read after
  # the store had been replaced: a missing config then left the project with
  # a NEW store, no pointer blocks, and no summary — the worst possible
  # half-installed state.
  read_archgen_version

  # Canonical store: ONE real copy at .agents/skills/archgen.
  # Safety (CLI parity): stamp-only differences refresh in place; a divergent
  # store moves to .archgen/.backup/<timestamp>/ before replacement.
  # Symlink safety (CLI parity with lib/init.js): a symlinked store — or a
  # symlinked parent dir escaping the project root — aborts the install, and
  # a divergent store is NEVER replaced unless its backup succeeded.
  STORE="$ROOT/.agents/skills/archgen"
  refuse_symlink "$STORE"
  refuse_escape "$ROOT/.agents" "$ROOT"
  refuse_escape "$ROOT/.agents/skills" "$ROOT"
  refuse_escape "$ROOT/.claude" "$ROOT"
  # The Claude adapter is created INSIDE .claude/skills, so THAT directory is
  # the one that must not point outside the project. The check stopped one
  # level too high: a symlinked `.claude/skills` made the installer create
  # the link outside the project root.
  refuse_escape "$ROOT/.claude/skills" "$ROOT"
  mkdir -p -- "$ROOT/.agents/skills"
  BACKUP_NOTE=""
  # The copy lands in a TEMPORARY sibling FIRST. The old store is only moved
  # aside once the new one is COMPLETE, so an interrupted or failing copy
  # leaves the project with the store it had — never with none.
  # (The CLI's init does the same: copy → temp → rename old aside → rename
  # temp into place → restore on failure.)
  STORE_TMP="$(mktemp -d "$ROOT/.agents/skills/.archgen-install.XXXXXX" 2>/dev/null)" \
    || die "could not create a temporary directory next to .agents/skills/archgen"
  if ! cp -R -- "$SOURCE/." "$STORE_TMP"; then
    rm -rf -- "$STORE_TMP"
    die "could not copy the skill store into .agents/skills/archgen — the existing store was left untouched"
  fi
  prune_dev_only "$STORE_TMP" "$SOURCE"

  if [ -e "$STORE" ] || [ -L "$STORE" ]; then
    if [ -d "$STORE" ] && [ ! -L "$STORE" ] && \
       diff -rq -x '.archgen-version' -- "$SOURCE" "$STORE" >/dev/null 2>&1; then
      rm -rf -- "$STORE"
    else
      TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
      BACKUP_DEST="$ROOT/.archgen/.backup/$TS/.agents/skills/archgen"
      mkdir -p -- "$(dirname -- "$BACKUP_DEST")"
      if mv -- "$STORE" "$BACKUP_DEST" 2>/dev/null; then
        BACKUP_NOTE="previous divergent store moved to .archgen/.backup/$TS/.agents/skills/archgen"
      else
        rm -rf -- "$STORE_TMP"
        die "could not back up divergent store at .agents/skills/archgen - refusing to replace without backup"
      fi
    fi
  fi
  if ! mv -- "$STORE_TMP" "$STORE"; then
    rm -rf -- "$STORE_TMP"
    die "could not move the copied skill store into place at .agents/skills/archgen"
  fi
  prune_dev_only "$STORE" "$SOURCE"

  # Version stamp inside the store. Canonical source: archgen.config.json at
  # the repo root; falls back to the CLI package.json scrape, then "dev".
  CONFIG_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$SCRIPT_DIR/archgen.config.json" 2>/dev/null | head -n 1)"
  CLI_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$SCRIPT_DIR/packages/cli/package.json" 2>/dev/null | head -n 1)"
  printf '%s\n' "${CONFIG_VERSION:-${CLI_VERSION:-dev}}" > "$STORE/.archgen-version"

  # Claude adapter: RELATIVE symlink into the store; skip gracefully on failure.
  # CLI parity (lib/init.js): a foreign live symlink is kept untouched, a
  # dangling one is repaired — never silently replaced via ln -sfn.
  CLAUDE_LINK="$ROOT/.claude/skills/archgen"
  LINK_NOTE=""
  if [ -d "$CLAUDE_LINK" ] && [ ! -L "$CLAUDE_LINK" ]; then
    LINK_NOTE="kept existing real directory at .claude/skills/archgen (not replaced)"
  elif [ -L "$CLAUDE_LINK" ]; then
    if [ "$(readlink -- "$CLAUDE_LINK")" = "../../.agents/skills/archgen" ] && [ -e "$CLAUDE_LINK" ]; then
      : # ours and resolving — reported by the summary below
    elif [ -e "$CLAUDE_LINK" ]; then
      LINK_NOTE="kept foreign symlink at .claude/skills/archgen (left untouched)"
    elif ! { rm -f -- "$CLAUDE_LINK" && ln -s -- "../../.agents/skills/archgen" "$CLAUDE_LINK"; }; then
      LINK_NOTE="could not repair dangling symlink at .claude/skills/archgen (skipped)"
    fi
  elif ! { mkdir -p -- "$ROOT/.claude/skills" && ln -s -- "../../.agents/skills/archgen" "$CLAUDE_LINK"; }; then
    LINK_NOTE="could not create symlink at .claude/skills/archgen (skipped; store still works standalone)"
  fi

  # The content BETWEEN two markers, exclusive. Empty when they are absent.
  extract_between() { # $1 = file, $2 = start marker, $3 = end marker
    awk -v s="$2" -v e="$3" '
      index($0, s) { inblock=1; next }
      inblock && index($0, e) { inblock=0; next }
      inblock { print }
    ' "$1"
  }

  # Replace the content between two markers, in place. Both markers stay.
  splice_between() { # $1 = file, $2 = start marker, $3 = end marker, $4 = content file
    awk -v s="$2" -v e="$3" -v cf="$4" '
      BEGIN { while ((getline l < cf) > 0) c = c l "\n" }
      !done && index($0, s) { print; printf "%s", c; done=1; inblock=1; next }
      inblock && index($0, e) { print; inblock=0; next }
      inblock { next }
      { print }
    ' "$1" > "$1.splice" && mv -- "$1.splice" "$1"
  }

  # Replace ONE managed block with the rendered one, in place. The content
  # outside the markers is preserved; the block's provenance stamp is
  # refreshed, so an old block never claims a version the store does not have.
  replace_block() { # $1 = file, $2 = rendered block file
    awk -v s="archgen:start" -v e="archgen:end" -v bf="$2" '
      BEGIN { while ((getline l < bf) > 0) blk = blk l "\n" }
      !done && index($0, s) { printf "%s", blk; done=1; skip=1; next }
      skip && index($0, e) { skip=0; next }
      skip { next }
      { print }
    ' "$1"
  }

  strip_managed_blocks() { # stdout = $1 minus every complete managed block
    awk '/archgen:start/ && !skip { skip=1; next } /archgen:end/ && skip { skip=0; next } !skip { print }' "$1"
  }

  normalize_duplicates() { # $1 = file with >1 start markers (balanced counts)
    f="$1"
    starts=$(grep -c "archgen:start" -- "$f" 2>/dev/null); starts=${starts:-0}
    [ "$starts" -gt 1 ] || return 0
    ends=$(grep -c "archgen:end" -- "$f" 2>/dev/null); ends=${ends:-0}
    [ "$starts" -eq "$ends" ] || { warn "corrupted archgen markers in $f ($starts start / $ends end) - fix or remove them manually"; return 1; }
    warn "normalizing $starts duplicated archgen blocks in $f to a single block"
    strip_managed_blocks "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  }

  write_block() { # $1 = target file; the managed block is REPLACED in place
    f="$1"
    refuse_symlink "$f"
    if [ -d "$f" ] && [ ! -L "$f" ]; then
      # `mv "$f.tmp" "$f"` would move the temp file INTO the directory and
      # the script would report a pointer block that is not there.
      warn "$f is a directory - the archgen pointer block was NOT written"
      return 1
    fi
    # The feature registry inside the block is DATA: it is carried across the
    # refresh instead of being reset to an empty table.
    rows_tmp="$f.archgen-rows.$$"
    block_tmp="$f.archgen-block.$$"
    out_tmp="$f.archgen.$$"
    refuse_symlink "$rows_tmp"; refuse_symlink "$block_tmp"; refuse_symlink "$out_tmp"
    : > "$rows_tmp"
    if [ -f "$f" ]; then
      extract_between "$f" "archgen:features:start" "archgen:features:end" > "$rows_tmp"
    fi
    # Content mirrors packages/cli lib/block.js renderManagedBlockText() - regenerate when block format changes.
    # Byte-for-byte parity is enforced by packages/cli/test/config/config.test.mjs (install.sh managed-block parity).
    # The version is SUBSTITUTED, never written here: the heredoc stays
    # quoted (so nothing else in it can expand), and the one placeholder is
    # filled from the canonical config the CLI itself reads. A literal in
    # this file would be a release chore AND a drift source - the block
    # would claim one version while the CLI stamps another.
    if ! sed "s/@@ARCHGEN_VERSION@@/$ARCHGEN_VERSION/g" > "$block_tmp" <<'BLOCK'
<!-- archgen:start (managed block - do not edit between markers) -->
<!-- archgen:block v@@ARCHGEN_VERSION@@ -->
# ArchGen - Architecture Generation & Autonomous Task Execution

This project uses the **archgen** skill, installed at `.agents/skills/archgen/`.

**Before running any archgen workflow, read its instructions:**
read `.agents/skills/archgen/SKILL.md` first - it defines every mode, gate, and rule.

Quick triggers:
- "generate architecture for X" -> greenfield GENERATE mode
- "add feature X" -> BROWNFIELD survey-first mode (analyzes this codebase)
- "start work" -> execute pending tasks in `.archgen/*/tasks.yaml` wave-by-wave
- "roll back ..." / "install mcp ..." / "fetch design skill" -> auxiliary modes

Rules of the road:
- Generated artifacts live ONLY under `.archgen/<slug>/`
- Never hand-edit task statuses - call the `archgen_tasks` MCP tool (comment-safe)
- Two gates before any execution: verifier approval, then human approval

## Features registry

<!-- archgen:features:start -->
| Feature | Status | Updated |
| --- | --- | --- |
<!-- archgen:features:end -->
<!-- archgen:end -->
BLOCK
    then
      rm -f -- "$rows_tmp" "$block_tmp"
      warn "could not render the archgen pointer block for $f"
      return 1
    fi
    if [ -s "$rows_tmp" ]; then
      splice_between "$block_tmp" "archgen:features:start" "archgen:features:end" "$rows_tmp"
    fi
    if [ -f "$f" ]; then
      starts=$(grep -c "archgen:start" -- "$f" 2>/dev/null); starts=${starts:-0}
      ends=$(grep -c "archgen:end" -- "$f" 2>/dev/null); ends=${ends:-0}
      if [ "$starts" -gt 1 ] || [ "$ends" -gt 1 ]; then
        normalize_duplicates "$f" || { rm -f -- "$rows_tmp" "$block_tmp"; return 1; }
      fi
      starts=$(grep -c "archgen:start" -- "$f" 2>/dev/null); starts=${starts:-0}
      if [ "$starts" -eq 1 ]; then
        replace_block "$f" "$block_tmp" > "$out_tmp" || { rm -f -- "$rows_tmp" "$block_tmp" "$out_tmp"; return 1; }
      else
        { [ -f "$f" ] && cat "$f" && printf '\n'; cat "$block_tmp"; } > "$out_tmp"
      fi
    else
      cat "$block_tmp" > "$out_tmp"
    fi
    if ! mv -- "$out_tmp" "$f"; then
      rm -f -- "$out_tmp" "$rows_tmp" "$block_tmp"
      warn "could not write $f"
      return 1
    fi
    rm -f -- "$rows_tmp" "$block_tmp"
    return 0
  }

  write_bridge() { # $1 = CLAUDE.md; one-line @AGENTS.md pointer inside markers
    f="$1"
    refuse_symlink "$f"
    if [ -d "$f" ] && [ ! -L "$f" ]; then
      warn "$f is a directory - the archgen bridge was NOT written"
      return 1
    fi
    if [ -f "$f" ] && grep -Eq '^[[:space:]]*@AGENTS\.md[[:space:]]*$' "$f"; then return 0; fi
    block_tmp="$f.archgen-block.$$"
    out_tmp="$f.archgen.$$"
    refuse_symlink "$block_tmp"; refuse_symlink "$out_tmp"
    # Content mirrors packages/cli lib/block.js renderClaudeBridgeText() - regenerate when block format changes.
    # Byte-for-byte parity is enforced by packages/cli/test/config/config.test.mjs (install.sh managed-block parity).
    if ! sed "s/@@ARCHGEN_VERSION@@/$ARCHGEN_VERSION/g" > "$block_tmp" <<'BLOCK'
<!-- archgen:start (managed block - do not edit between markers) -->
<!-- archgen:block v@@ARCHGEN_VERSION@@ -->
@AGENTS.md
<!-- archgen:end -->
BLOCK
    then
      rm -f -- "$block_tmp"
      warn "could not render the archgen bridge for $f"
      return 1
    fi
    if [ -f "$f" ]; then
      starts=$(grep -c "archgen:start" -- "$f" 2>/dev/null); starts=${starts:-0}
      if [ "$starts" -gt 1 ]; then
        normalize_duplicates "$f" || { rm -f -- "$block_tmp"; return 1; }
      fi
      starts=$(grep -c "archgen:start" -- "$f" 2>/dev/null); starts=${starts:-0}
      if [ "$starts" -eq 1 ]; then
        replace_block "$f" "$block_tmp" > "$out_tmp" || { rm -f -- "$block_tmp" "$out_tmp"; return 1; }
      else
        { [ -f "$f" ] && cat "$f" && printf '\n'; cat "$block_tmp"; } > "$out_tmp"
      fi
    else
      cat "$block_tmp" > "$out_tmp"
    fi
    if ! mv -- "$out_tmp" "$f"; then
      rm -f -- "$out_tmp" "$block_tmp"
      warn "could not write $f"
      return 1
    fi
    rm -f -- "$block_tmp"
    return 0
  }

  # The pointer blocks. A failure is REPORTED, not fatal: the store is
  # installed, and the summary must say what is missing instead of exiting
  # with no explanation at all.
  #
  # The bridge was written TWICE here: once before this block, once in it.
  # The second call saw the file the first one had just written and
  # returned early — so the first call was dead work that produced a
  # DUPLICATED warning when it failed, and the `BLOCK_FAILED=0` below
  # discarded its failure. A CLAUDE.md that could not be written was
  # therefore reported twice and counted once, and the count depended on
  # which call happened to run last.
  #
  # It is written ONCE now, and its failure is counted where it happens.
  BLOCK_FAILED=0
  write_block "$ROOT/AGENTS.md" || BLOCK_FAILED=1
  write_bridge "$ROOT/CLAUDE.md" || BLOCK_FAILED=1

  # The project install manifest (CLI parity): the record of what this
  # install created, so `archgen uninstall <dir>` can remove it. The CLI
  # wrote one and install.sh did not, so an install made by the shell
  # installer was invisible to the CLI's uninstaller.
  PROJECT_MANIFEST="$ROOT/.archgen/.install-manifest.json"
  if mkdir -p -- "$ROOT/.archgen" 2>/dev/null && [ ! -L "$ROOT/.archgen" ]; then
    NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    LINK_ENTRY=""
    if [ -L "$CLAUDE_LINK" ] && [ "$(readlink -- "$CLAUDE_LINK")" = "../../.agents/skills/archgen" ]; then
      LINK_ENTRY="    { \"kind\": \"link\", \"path\": \".claude/skills/archgen\", \"createdAt\": \"$NOW\" },"
    fi
    {
      printf '{\n  "version": 1,\n  "createdAt": "%s",\n  "entries": [\n' "$NOW"
      printf '    { "kind": "dir", "path": ".agents/skills/archgen", "createdAt": "%s" },\n' "$NOW"
      printf '%s\n' "$LINK_ENTRY"
      printf '    { "kind": "block", "path": "AGENTS.md", "createdAt": "%s" },\n' "$NOW"
      printf '    { "kind": "block", "path": "CLAUDE.md", "createdAt": "%s" }\n' "$NOW"
      printf '  ]\n}\n'
    } > "$PROJECT_MANIFEST" 2>/dev/null || warn "could not write $PROJECT_MANIFEST"
  fi

  # Server bootstrap (mirrors packages/cli --init): wire the archgen MCP server
  # into every DETECTED harness AND ensure CodeGraph (its CLI, its MCP entry,
  # the project index). Non-fatal by design: an offline machine still gets the
  # skill installed.
  if [ "$CODEGRAPH" -eq 1 ] || [ "$MCP" -eq 1 ]; then
    if command -v node >/dev/null 2>&1; then
      echo 'archgen: bootstrapping servers (archgen MCP + CodeGraph)…'
      # The MCP server owns every deterministic capability now — the skill
      # ships no scripts. `npx -y archgen-mcp` resolves it from the registry
      # (and is cached by npx after the first run); a locally installed
      # archgen-mcp on PATH is preferred by the server itself.
      #
      # The wiring is GLOBAL by default: the server is one binary for every
      # harness, and a project that carries its own .mcp.json has to be
      # re-wired in every clone. `--location-project` opts into the
      # per-project wiring.
      #
      # The two halves are skipped INDEPENDENTLY: `--no-codegraph` used to
      # switch the whole bootstrap off, so opting out of CodeGraph also
      # unwired the MCP server.
      BOOT_ARGS="--project $ROOT --location $LOCATION --yes"
      [ "$CODEGRAPH" -eq 0 ] && BOOT_ARGS="$BOOT_ARGS --no-codegraph"
      [ "$MCP" -eq 0 ] && BOOT_ARGS="$BOOT_ARGS --no-mcp"
      # shellcheck disable=SC2086
      if ! npx -y archgen-mcp bootstrap $BOOT_ARGS; then
        warn "server bootstrap incomplete — run: npx archgen-mcp bootstrap --project . --yes"
      fi
    else
      warn "node not found on PATH — skipping the server bootstrap (the skill needs Node >= 20 for its MCP server)"
    fi
  else
    warn "server bootstrap skipped (--no-codegraph --no-mcp)"
  fi


  echo "archgen: project initialized at $ROOT"
  echo "  + .agents/skills/archgen (canonical store)"
  if [ -n "$BACKUP_NOTE" ]; then
    printf '  ! %s\n' "$BACKUP_NOTE"
  fi
  if [ -n "$LINK_NOTE" ]; then
    printf '  ! %s\n' "$LINK_NOTE"
  elif [ -L "$CLAUDE_LINK" ]; then
    echo '  + .claude/skills/archgen -> ../../.agents/skills/archgen'
  fi
  if [ "$BLOCK_FAILED" -eq 0 ]; then
    echo '  + AGENTS.md / CLAUDE.md pointer blocks'
  else
    echo '  ! AGENTS.md / CLAUDE.md pointer blocks were NOT written (see the warnings above)'
  fi
  echo 'Next: commit these files, then say "generate architecture" or "start work" in your agent.'
  [ "$BLOCK_FAILED" -eq 0 ] && exit 0 || exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  if [ ! -f "$MANIFEST" ]; then
    printf 'Nothing to uninstall: no manifest at %s\n' "$MANIFEST"
    exit 0
  fi
  removed=0; failed=0; kept=""
  # `|| [ -n "$path" ]` — a manifest whose LAST line has no newline ends the
  # read with a non-zero status, and the body never ran for that line: the
  # entry was silently dropped and the manifest then deleted.
  while IFS=$'\t' read -r kind path || [ -n "${path:-}" ]; do
    [ -n "${path:-}" ] || continue
    if ! allowed_dest "$path"; then
      warn "skipping unexpected manifest entry: $path"
      failed=$((failed+1))
      kept="${kept}${kind}	${path}
"
      continue
    fi
    if [ -e "$path" ] || [ -L "$path" ]; then
      # An EDITED copy is moved into the backup vault before it is removed:
      # the uninstall must never be the last place those edits exist.
      if [ "$kind" = "copy" ] && [ -d "$path" ] && [ ! -L "$path" ]; then
        if ! diff -rq -- "$SOURCE" "$path" >/dev/null 2>&1; then
          TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
          BACKUP="$(dirname -- "$path")/.archgen-backups/$TS/archgen"
          if mkdir -p -- "$(dirname -- "$BACKUP")" && mv -- "$path" "$BACKUP" 2>/dev/null; then
            printf '  backed up %s -> %s\n' "$path" "$BACKUP"
          else
            warn "could not back up $path - refusing to remove it"
            failed=$((failed+1))
            kept="${kept}${kind}	${path}
"
            continue
          fi
        fi
      fi
      if rm -rf -- "$path"; then
        printf '  removed  %s (%s)\n' "$path" "$kind"; removed=$((removed+1))
      else
        warn "could not remove: $path"; failed=$((failed+1))
        kept="${kept}${kind}	${path}
"
      fi
    else
      printf '  absent   %s (already gone)\n' "$path"
    fi
  done < "$MANIFEST"
  # The manifest is the ONLY record of what was not removed. It is deleted
  # only when nothing was left behind.
  if [ -z "$kept" ]; then
    rm -f -- "$MANIFEST"
  else
    printf '%s' "$kept" > "$MANIFEST" || warn "could not rewrite $MANIFEST — the skipped entries are lost"
  fi
  printf 'Uninstall finished: %s removed, %s problem(s).\n' "$removed" "$failed"
  [ "$failed" -eq 0 ] && exit 0 || exit 1
fi

# ---- Resolve targets --------------------------------------------------------
targets=""
add() { targets="${targets}${1}
"; }

for d in "$HOME/.claude/skills" "$HOME/.agents/skills" \
         "$HOME/.config/opencode/skills" "$HOME/.cursor/skills"; do
  add "$d"
done

CREATABLE=""
if [ -n "$PROJECT_ARG" ]; then
  mkdir -p -- "$PROJECT_ARG" || die "cannot create project directory: $PROJECT_ARG"
  PROJ="$(cd -- "$PROJECT_ARG" && pwd)" || die "cannot enter project directory: $PROJECT_ARG"
  CREATABLE="$PROJ/.github/skills"
else
  CREATABLE=""
  PROJ="$(pwd)"
  add "$(pwd)/.github/skills"
fi
[ -z "$CREATABLE" ] || add "$CREATABLE"

have_entry() { grep -Fqx -- "$1" "$MANIFEST" 2>/dev/null; }

# ---- Install loop + per-target result table ---------------------------------
printf 'Installing archgen skill (mode: %s)\n\n' "$MODE"
printf '%-8s %-5s %s\n' RESULT MODE PATH
printf '%-8s %-5s %s\n' -------- ----- ----

changed=0; same=0; skipped=0; failed=0

# The version is read BEFORE anything is written, so a packaged tree with no
# readable config fails the install instead of stamping every copy with
# 'dev' — a stamp that tells `doctor` the tree is LEGACY when it is current.
read_archgen_version

while IFS= read -r tdir; do
  [ -n "$tdir" ] || continue
  dest="$tdir/archgen"
  [ "$tdir" = "$CREATABLE" ] && roots_add "${PROJ:-$PWD}"

  if [ ! -d "$tdir" ]; then
    if [ "$tdir" = "$CREATABLE" ]; then
      mkdir -p -- "$tdir" || { printf '%-8s %-5s %s\n' FAILED - "$tdir (cannot create)"; failed=$((failed+1)); continue; }
    else
      printf '%-8s %-5s %s\n' SKIP - "$tdir (does not exist)"
      skipped=$((skipped+1)); continue
    fi
  fi
  if [ ! -w "$tdir" ]; then
    printf '%-8s %-5s %s\n' FAILED - "$tdir (not writable)"
    failed=$((failed+1)); continue
  fi

  # Realpath-escape guard (CLI parity with lib/install.js): a symlinked
  # harness dir must not redirect the install outside its base dir.
  case "$tdir" in
    "$HOME"/*) tbase="$HOME" ;;
    *) tbase="${PROJ:-$PWD}" ;;
  esac
  tdir_phys="$(phys_of "$tdir")"
  tbase_phys="$(phys_of "$tbase")"
  case "$tdir_phys" in
    "$tbase_phys" | "$tbase_phys"/*) ;;
    *)
      printf '%-8s %-5s %s\n' FAILED - "$tdir (refusing: resolves outside $tbase via symlink)"
      failed=$((failed+1)); continue ;;
  esac

  if [ "$MODE" = "link" ]; then
    if [ -L "$dest" ]; then
      if [ "$(readlink -- "$dest")" = "$SOURCE" ]; then
        printf '%-8s %-5s %s\n' SAME link "$dest"; same=$((same+1)); continue
      elif [ -e "$dest" ]; then
        # Live foreign symlink: belongs to the user — kept untouched and NOT
        # recorded in the uninstall manifest (CLI parity: KEPT, never ln -sfn).
        printf '%-8s %-5s %s\n' KEPT - "$dest (foreign symlink, not recorded)"
        skipped=$((skipped+1)); continue
      else
        # Dangling link (npx cache eviction): recreate against current source.
        if rm -f -- "$dest" && ln -s -- "$SOURCE" "$dest"; then
          printf '%-8s %-5s %s -> %s\n' REPAIRED link "$dest" "$SOURCE"; changed=$((changed+1))
          manifest_add link "$dest"
        else
          printf '%-8s %-5s %s\n' FAILED link "$dest (symlink repair failed)"; failed=$((failed+1))
        fi
        continue
      fi
    fi
    if [ -e "$dest" ]; then
      printf '%-8s %-5s %s\n' FAILED - "$dest exists and is not a symlink; run --uninstall first"
      failed=$((failed+1)); continue
    fi
    if ln -s -- "$SOURCE" "$dest"; then
      printf '%-8s %-5s %s -> %s\n' OK link "$dest" "$SOURCE"; changed=$((changed+1))
      manifest_add link "$dest"
    else
      printf '%-8s %-5s %s\n' FAILED link "$dest (symlink failed)"; failed=$((failed+1))
    fi
  else
    if [ -L "$dest" ] && [ "$(readlink -- "$dest")" != "$SOURCE" ]; then
      # Foreign symlink at dest: refuse instead of replacing it (CLI parity).
      printf '%-8s %-5s %s\n' FAILED - "Refusing to write through symlink at $dest — use --copy or remove symlink"
      failed=$((failed+1)); continue
    fi
    if [ -d "$dest" ] && [ ! -L "$dest" ] && diff -rq -- "$SOURCE" "$dest" >/dev/null 2>&1; then
      printf '%-8s %-5s %s\n' SAME copy "$dest"; same=$((same+1)); continue
    fi
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      # Backup-before-replace (CLI parity: <tdir>/.archgen-backups/<ts>/archgen);
      # a replace that cannot be backed up is refused, never forced.
      TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
      BACKUP="$tdir/.archgen-backups/$TS/archgen"
      if mkdir -p -- "$(dirname -- "$BACKUP")" && mv -- "$dest" "$BACKUP" 2>/dev/null; then
        printf '%-8s %-5s %s\n' BACKED-UP - "$BACKUP"
      else
        printf '%-8s %-5s %s\n' FAILED copy "$dest (could not back up - refusing to replace without backup)"
        failed=$((failed+1)); continue
      fi
    fi
    if cp -R -- "$SOURCE" "$dest"; then
      prune_dev_only "$dest" "$SOURCE"
      # The version stamp (CLI parity: install.js writes it in copy mode too).
      # It is what `doctor` and the MCP server read to tell a fresh install
      # from an outdated one, and WITHOUT it a copied global tree looks
      # 'unknown (legacy)' forever — the CLI's own copy mode has always
      # stamped, so a shell install was the only path that did not.
      #
      # ARCHGEN_VERSION is the one read at startup from the packaged
      # archgen.config.json; CONFIG_VERSION/CLI_VERSION only exist on the
      # --init path, so using them here would stamp 'dev'.
      printf '%s\n' "${ARCHGEN_VERSION:-dev}" > "$dest/.archgen-version" 2>/dev/null || true
      printf '%-8s %-5s %s\n' OK copy "$dest"; changed=$((changed+1))
      manifest_add copy "$dest"
    else
      printf '%-8s %-5s %s\n' FAILED copy "$dest (copy failed)"; failed=$((failed+1))
    fi
  fi
done <<EOF
$targets
EOF

# ---- Summary + guidance ------------------------------------------------------
printf '\nSummary: %s changed, %s unchanged, %s skipped, %s failed.\n' "$changed" "$same" "$skipped" "$failed"
cat <<'EOF'

Other platforms should use the universal installer:
  npx skills add akashmaurya99/archgen

Notes:
  * Zed expects the FLAT ~/.agents/skills layout — this installer maintains
    that directory when it exists (no extra nesting beyond skills/archgen/).
  * Kiro custom agents must declare explicit skill:// resources pointing at
    the installed skill directory to load it.
EOF

[ "$failed" -eq 0 ] || { warn "$failed target(s) failed; exiting non-zero."; exit 1; }
exit 0
