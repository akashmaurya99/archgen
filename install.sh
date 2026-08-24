#!/usr/bin/env bash
# install.sh — multi-harness installer for the archgen skill.
# Zero dependencies beyond coreutils; no sudo; no network.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/skills/archgen"

MODE="link"
PROJECT_ARG=""
UNINSTALL=0

usage() {
  cat <<EOF
Usage: install.sh [--copy] [--project <dir>] [--uninstall]

  --copy            make real copies instead of symlinks (default: symlink)
  --project <dir>   create + install into <dir>/.github/skills (GitHub Copilot,
                    project-local); without it .github/skills is used only when
                    it already exists under the current working directory
  --uninstall       remove exactly what a previous run recorded in
                    \$HOME/.archgen-install-manifest.list (no-op exit 0 if none)
  -h, --help        show this help

Targets (installed only when the directory already exists):
  \$HOME/.claude/skills           Claude Code / Claude Desktop
  \$HOME/.agents/skills           agentskills.io generic layout (Zed reads this flat)
  \$HOME/.config/opencode/skills  OpenCode
  \$HOME/.cursor/skills           Cursor
  .github/skills                 GitHub Copilot (project-local)

Platforms not covered here: npx skills add akash/archgen
EOF
}

warn() { printf 'install.sh: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

[ -n "${HOME:-}" ] || die '$HOME is not set; cannot resolve target directories.'
MANIFEST="$HOME/.archgen-install-manifest.list"
[ -d "$SOURCE" ] || die "skill source not found: $SOURCE"

while [ $# -gt 0 ]; do
  case "$1" in
    --copy)      MODE="copy"; shift ;;
    --project)   [ $# -ge 2 ] || die '--project requires a path argument'; PROJECT_ARG="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

# ---- Uninstall: remove exactly the manifest-recorded entries ----------------
if [ "$UNINSTALL" -eq 1 ]; then
  if [ ! -f "$MANIFEST" ]; then
    printf 'Nothing to uninstall: no manifest at %s\n' "$MANIFEST"
    exit 0
  fi
  removed=0; failed=0
  while IFS=$'\t' read -r kind path; do
    [ -n "${path:-}" ] || continue
    case "$path" in
      */skills/archgen) ;;
      *) warn "skipping unexpected manifest entry: $path"; failed=$((failed+1)); continue ;;
    esac
    if [ -e "$path" ] || [ -L "$path" ]; then
      if rm -rf -- "$path"; then
        printf '  removed  %s (%s)\n' "$path" "$kind"; removed=$((removed+1))
      else
        warn "could not remove: $path"; failed=$((failed+1))
      fi
    else
      printf '  absent   %s (already gone)\n' "$path"
    fi
  done < "$MANIFEST"
  rm -f -- "$MANIFEST"
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
  add "$(pwd)/.github/skills"
fi
[ -z "$CREATABLE" ] || add "$CREATABLE"

have_entry() { grep -Fqx -- "$1" "$MANIFEST" 2>/dev/null; }

# ---- Install loop + per-target result table ---------------------------------
printf 'Installing archgen skill (mode: %s)\n\n' "$MODE"
printf '%-8s %-5s %s\n' RESULT MODE PATH
printf '%-8s %-5s %s\n' -------- ----- ----

changed=0; same=0; skipped=0; failed=0

while IFS= read -r tdir; do
  [ -n "$tdir" ] || continue
  dest="$tdir/archgen"

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

  if [ "$MODE" = "link" ]; then
    if [ -L "$dest" ] && [ "$(readlink -- "$dest")" = "$SOURCE" ]; then
      printf '%-8s %-5s %s\n' SAME link "$dest"; same=$((same+1)); continue
    fi
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      printf '%-8s %-5s %s\n' FAILED - "$dest exists and is not a symlink; run --uninstall first"
      failed=$((failed+1)); continue
    fi
    if ln -sfn -- "$SOURCE" "$dest"; then
      printf '%-8s %-5s %s -> %s\n' OK link "$dest" "$SOURCE"; changed=$((changed+1))
      have_entry "$(printf 'link\t%s' "$dest")" || printf 'link\t%s\n' "$dest" >> "$MANIFEST"
    else
      printf '%-8s %-5s %s\n' FAILED link "$dest (symlink failed)"; failed=$((failed+1))
    fi
  else
    if [ -d "$dest" ] && [ ! -L "$dest" ] && diff -rq -- "$SOURCE" "$dest" >/dev/null 2>&1; then
      printf '%-8s %-5s %s\n' SAME copy "$dest"; same=$((same+1)); continue
    fi
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      rm -rf -- "$dest" || { printf '%-8s %-5s %s\n' FAILED copy "$dest (cannot replace)"; failed=$((failed+1)); continue; }
    fi
    if cp -R -- "$SOURCE" "$dest"; then
      printf '%-8s %-5s %s\n' OK copy "$dest"; changed=$((changed+1))
      have_entry "$(printf 'copy\t%s' "$dest")" || printf 'copy\t%s\n' "$dest" >> "$MANIFEST"
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
  npx skills add akash/archgen

Notes:
  * Zed expects the FLAT ~/.agents/skills layout — this installer maintains
    that directory when it exists (no extra nesting beyond skills/archgen/).
  * Kiro custom agents must declare explicit skill:// resources pointing at
    the installed skill directory to load it.
EOF

[ "$failed" -eq 0 ] || { warn "$failed target(s) failed; exiting non-zero."; exit 1; }
exit 0
