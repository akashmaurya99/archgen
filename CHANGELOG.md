# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Activity-bar cockpit**: the single launcher view becomes three sidebar
  views — Overview (feature switcher + live progress summary), Tasks
  (status-grouped live task tree with per-task ▶ build), Docs (quick-open).
- **Start Work** and **Open Board** view-title actions on the cockpit views.
- Native welcome states in each view when no `.archgen/` plan exists.
- Status bar running indicator while a build is in flight.

## [0.0.3] - 2026-08-25

### Changed

- **Single-store installs**: `archgen-skill init` now writes exactly ONE skill
  copy at `.agents/skills/archgen` (the agentskills.io standard location read
  natively by OpenCode, Cursor, Codex, Gemini CLI, Copilot and Antigravity).
  Claude Code gets a relative symlink at `.claude/skills/archgen` — the only
  harness needing it. No more duplicate skill folders per project.
- **CLAUDE.md is a one-line bridge** (`@AGENTS.md`, Anthropic's documented
  pattern). Existing files keep all user content; files already importing
  AGENTS.md are left untouched.
- **AGENTS.md is a living hub**: managed block now carries a features registry
  (slug · status · updated) maintained by the new `update-agents.mjs` skill
  script after every generate/work cycle.

### Added

- `archgen-skill doctor [--check]`: verifies store integrity, version stamp,
  Claude link, block uniqueness, manifest resolution — auto-repairs what's safe.
- `archgen-skill uninstall --project`: surgical removal — strips managed blocks,
  our symlink and an unmodified store only; feature folders in `.archgen/` and
  all user content are preserved.
- Ownership verification before every mutation: divergent skill copies are
  backed up to `.archgen/.backup/<timestamp>/` instead of overwritten; legacy
  dual-copy layouts migrate to symlinks automatically.
- Install manifest (`.archgen/.install-manifest.json`) records everything the
  installer creates.

## [0.0.2] - 2026-08-25

### Fixed

- **CLI**: the published tarball now ships a proper `README.md` — the npm package
  page previously rendered without one (the README lived only at the repo root).
- Corrected repository links in the CLI `--help` footer and `install.sh`
  (`github.com/akash/archgen` → `github.com/akashmaurya99/archgen`).

### Changed

- Binary name aligned with the package: global installs now expose
  `archgen-skill` (was `archgen`); `npx archgen-skill …` usage is unchanged.
- Package metadata: added `homepage` and `bugs`, refined keywords.

## [0.0.1] - 2026-08-25

### Added

- **Skill**: archgen agent skill with 7 workflow modes, a plan-verifier gate
  (APPROVE/blocks on cycles, overlaps, unknown refs), and wave-based task
  execution (`next-tasks` / `set-status`).
- **CLI** (`packages/cli`, published as [`archgen-skill`](https://www.npmjs.com/package/archgen-skill)): `archgen init` (project-local skill copies +
  AGENTS.md/CLAUDE.md pointer blocks), `archgen install` / `--uninstall`
  (multi-harness global installer with manifest-recorded removal).
- **VS Code extension** (`packages/extension`): DAG view, code-graph view,
  docs view, and build button over `.archgen/` artifacts.
- Multi-harness support: Claude Code, agentskills.io generic layout, OpenCode,
  Cursor, GitHub Copilot (project-local), plus `install.sh` symlink/copy
  installer with uninstall manifest.

[0.0.2]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.2
[0.0.1]: https://github.com/akashmaurya99/archgen/releases/tag/v0.0.1
