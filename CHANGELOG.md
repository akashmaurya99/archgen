# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Extension: SETUP folded out of the tab strip into a centered dialog opened by a new ⚙ header button (⋯ menu too); empty-state copy tightened; sidebar clicks (feature/task/doc) now land you on the right board view.

### Fixed

- Extension: the kickoff-prompt input was a top-center native quick-input jump; it now opens as a centered modal inside the Task Board itself (Enter copies, Esc cancels), while non-board entry points keep the native input.
- Clicking a Docs-tree entry could update an invisible board; documents now open the board directly on their page.

## [0.0.4] - 2026-08-26

### Added

- **Artifact intelligence layer** — two zero-dependency graph tools ship inside
  the skill, because audited codegraph-family indexers extract source symbols
  only (no markdown headings, no YAML task semantics):
  `scripts/plan-graph.mjs` queries the task DAG (`--node <id>` transitive
  neighborhood with distances, `--mermaid [--status]` flowcharts,
  `--module <name>` filter), and `scripts/doc-index.mjs` indexes markdown
  artifacts (heading tree, `--refs-to` backlinks across TASK/FR/ADR/path
  references, `--validate` broken-reference gate, `--stale` freshness audit,
  `--diagrams` inventory). Both are scope-hardened to `.archgen/<slug>/`
  (symlink and look-alike escapes refused), dedup-guaranteed
  (`duplicatesCollapsed` / realpath file inventory / unique-ref counting /
  duplicate FR-definition detection), scale-guarded (iterative traversals,
  800-task stress-tested, whole-graph renders refuse >250 nodes with scoping
  hints, deterministic truncation markers past 100 files), and surface a
  non-fatal `quality:{selfDeps,emptyOwnership,blankAcceptance}` facts block.
- **No-fallback dispatch policy**: tasks go to the platform's native sub-agent
  mechanism; when sub-agents are unavailable or fail (including missing tool
  permissions) the main agent executes the task itself. Switching to another
  harness/platform requires telling you the concrete issue and getting your
  explicit approval first — automatic headless-CLI worker fallbacks are gone.
- **PLAN-REVIEW stage**: the gate sequence is now verifier → plan-review →
  user. After verifier APPROVE, reviewer sub-agent(s) sized by scope class
  audit edge cases, task ordering, cross-module contracts and documentation
  completeness; artifacts iterate until zero findings or explicit waiver.
- **Root-cause investigation protocol**: recurring post-implementation issues
  trigger complexity-sized investigators (main agent for small scopes, 1–3
  split by subsystem otherwise) producing root cause, evidence and blast
  radius before any fix task is written — patch-fixing without a root cause
  is forbidden.
- **Mandatory capability-skill loading**: registry entries carry a `policy`
  field; UI/design/frontend work requires the design skills fetched and
  followed before planning and dispatch, with a one-line compliance note in
  every affected worker completion report.
- **Professional plan depth**: interviews classify intent (GREENFIELD-SYSTEM
  through BROWNFIELD-CHANGE) with survey-before-questioning for brownfield;
  greenfield systems get PRD-grade artifacts — requirements with stable
  FR-ids, naming/data/API contracts, environment matrix, per-module Mermaid
  diagrams, and edge-case matrices wired to acceptance criteria — under
  self-containment rules that pin every path verbatim so no session
  hallucinates file names after context summarization.
- **Status discipline (non-negotiable)**: every completed task updates
  tasks.yaml, the todo tracker and the AGENTS.md registry timestamp in the
  same turn; batching status writes to session end is forbidden.
- **MCP installs discover their method via web search** when the current
  command/config shape is not known with confidence, then apply it at the
  correct scope — that specific harness's config, or global for npx-style
  servers — behind the existing approval gate.
- **Proactive setup UX**: the extension now wakes on startup even before a plan
  exists and detects three states — archgen skill missing, skill installed but
  no `.archgen/` plan yet, and installed-but-outdated skill (via a new
  `.archgen-version` stamp written by the CLI on every install/init/update,
  readable through symlink layouts). Each state gets a one-time notification
  (signature-keyed dismissal, never nagging), a status-bar shortcut, and a
  non-blocking **Setup panel** whose buttons copy ready-to-paste prompts that
  give your agent full context to install / initialize / update. Everything
  keeps working on older skill versions — updating is recommended, never
  required. New command: `ArchGen: Open Setup Panel`.
- **Clipboard-first delivery**: ▶ Build This Task and ▶ Start Work now copy the
  composed prompt to the clipboard and ask you to paste it into any agent chat —
  reliable across VS Code, Cursor, Windsurf, VSCodium and every agent harness,
  with no CLI or IDE API required. New settings: `archgen.delivery.mode`
  (`clipboard` | `spawn`) and `archgen.delivery.autoFillChat` (best-effort
  pre-fill of the IDE's native chat input; never auto-sends).
- **Activity-bar cockpit**: the single launcher view becomes three sidebar
  views — Overview (feature switcher + live progress summary), Tasks
  (status-grouped live task tree with per-task ▶ build), Docs (quick-open).
- **Start Work** and **Open Board** view-title actions on the cockpit views.
- Native welcome states in each view when no `.archgen/` plan exists.
- Status bar running indicator while a build is in flight.
- **Central config (`archgen.config.json`)**: one canonical file at the repo root
  now pins the version, managed-block markers and well-known filenames;
  `npm run sync` propagates it into SKILL.md frontmatter, package.json and the
  vendored skill copy — ending the SKILL.md-says-1.0.0-vs-CLI-ships-0.0.x drift,
  with a CI vendor-freshness gate so stale publishes are impossible.
- **`archgen-skill restore`**: lists backup snapshots across the project vault
  (`.archgen/.backup/`) and the per-harness global vaults; `--snapshot <ts>`
  restores one, moving the current state into a fresh safety snapshot first.
- **`archgen-skill migrate [--check|--apply]`**: framework for evolving
  generated-artifact formats in place — dry-run by default, every touched file
  backed up before modification. Ships migration `001-stamp-provenance`, which
  stamps `# schema_version` / generator / generated-at comments onto
  `.archgen/*/tasks.yaml` and `architecture.yaml`.
- **Versioned managed blocks**: AGENTS.md/CLAUDE.md blocks now open with a
  `<!-- archgen:block vX.Y.Z -->` provenance line, and init/doctor upgrade
  legacy unversioned blocks to the current format in place automatically.
- **Backup-before-replace on global `--copy` installs**: destinations are
  fingerprinted first — identical trees skip like link mode, divergent ones move
  into `<skills-dir>/.archgen-backups/<timestamp>/` before replacement.
- **Dangling global symlink self-repair**: `install` recreates symlinks whose
  target was evicted (npx cache cleanup) against the current source instead of
  reporting SAME on a broken link.
- **Doctor block-upgrade detection**: stale-format managed blocks are reported
  (`UPGRADED`, or would-upgrade under `--check`) instead of passing silently.

### Fixed

- The installer no longer records foreign symlinks (targets that predate us) in
  the uninstall manifest, so `uninstall` removes only what archgen installed.
- Doctor reports broken marker states (orphan/duplicate/reversed markers) as
  FAIL rows instead of aborting the whole run.
- `validate`, `set-status` and `impact` report clean one-line errors (no raw
  stack traces) for unparseable or missing files.
- `set-status` no longer reopens done work via done→failed without `--force`.
- Duplicate YAML keys inside a task are rejected instead of silently last-wins.
- The schema id pattern/type is enforced, so numeric-coerced task ids fail
  validation fast.
- The board's ▶ Start Work button silently did nothing (its message was never
  routed). Both webview↔host message switches now fail compilation if a future
  intent is added without a route.
- Task acceptance criteria were parsed from tasks.yaml but never shown; they
  now appear in sidebar task tooltips and board node hover details.
- Invalid install hint `npx archgen-skill generate` (no such CLI verb)
  corrected to the real `npx archgen-skill init` + agent phrase in the welcome
  views and the board empty state.
- Prompt-injection hardening in harness dispatch: task titles containing
  quotes/backslashes can no longer corrupt spawned argv or smuggle instructions
  (values are escaped at template interpolation and decoded by a hardened argv
  splitter, proven against an adversarial test suite).
- Board refreshes that changed anything beyond id/status/doc paths (warnings,
  acceptance, …) were deduped away and never reached the UI; the model
  fingerprint now covers the full payload.
- Board empty-state was a dead end after `archgen-skill init` (it re-instructed
  the same command while the real next step is generating a plan); it is now
  setup-aware — skill-installed workspaces get a 'Copy kickoff prompt' action —
  and the board replays the setup snapshot whenever it opens.

### Changed

- ▶ actions deliver work via the clipboard by default. Set
  `archgen.delivery.mode` = `"spawn"` for the previous headless CLI behavior
  (unchanged byte-for-byte).

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
