# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **CodeGraph bootstrap everywhere** — install.sh, `archgen init`, and
  `archgen install` (global) now ensure the CodeGraph CLI is present and
  up-to-date, wire the MCP server into every DETECTED harness, and build the
  project index — all through the new `scripts/codegraph.mjs`. `--no-codegraph`
  (CLI) / `--no-codegraph` (install.sh) / `ARCHGEN_CODEGRAPH=0` (env) opt out;
  the bootstrap is never fatal to the skill install. The CLI suite no longer
  touches the developer's real global MCP configs (`ARCHGEN_CODEGRAPH=0` is set
  for `npm test`).
- **CodeGraph command shape corrected** — the MCP server is `codegraph serve
  --mcp` (stdio). There is no `codegraph mcp` subcommand (it prints the
  top-level help and exits, so a server declared that way never connects).
  `serve --mcp` keeps the file watcher ON, so the index stays live in real
  time once it is built — no re-indexing, ever.
- **Per-harness MCP wiring is now data-driven** via new
  `assets/harness-mcp.json` (11 harnesses; correct top-level key per platform —
  `mcpServers` / `servers` / `mcp` / `context_servers` — and codegraph's own
  native target list `claude,cursor,codex,opencode,gemini,antigravity,kiro`;
  Windsurf, VS Code/Copilot, Zed and Trae are written by the script itself).
  The writer never rewrites an unparseable config (JSONC stays untouched), is
  idempotent, and resolves harness `local` install paths from the project root.
- **Real-time index on every new project** — `codegraph init` (1.6.x indexes
  by default) builds `.codegraph/` once; the MCP server's watcher
  (`--no-watch` never passed) keeps it synchronized in real time.
- **Internal context-budget tool** — `internal/tools/context-budget.mjs`
  (repo-only, never shipped): token cost of the skill payload, per-slug
  artifacts, and load scenarios as a percentage of 32k/64k/128k/200k/1M
  windows; `--budget <n>` exits 1 when any scenario exceeds it;
  `--tokenizer <pkg>` swaps in an exact tokenizer. Internal QA only — it does
  not ship in the npm payload or installed stores, like all of `internal/`.
  The shipped skill only carries the runtime retrieval lenses (`--digest` /
  `--section` / `--map`).
- **Section-level artifact retrieval** — `scripts/lib/docs.mjs` +
  `doc-index.mjs --digest` (sections with line ranges), `--section
  <path>[#anchor]` (fetch exactly one section), `--map <token>` (which
  SECTIONS mention a task/FR/ADR). Workers can now pull one section instead of
  a whole plan. No token reporting ships — the retrieval lenses carry only
  structure.
- **Anchor validation** — `doc-index.mjs --validate` now resolves markdown
  heading anchors against the target document's GitHub-exact slugs (duplicate
  headings get `-1`, `-2`); a link to a deleted/renamed section is a broken
  `anchor`, previously a silent pass.
- **GitHub-exact heading slugs** — `slugifyHeading()` matches GitHub (each
  whitespace char → one hyphen, runs are NOT collapsed), with a tolerant
  collapsed-hyphen comparison for hand-typed anchors.
- **CRLF corpus fixture** (`fixtures/yaml-corpus/crlf.yaml`) — both YAML
  parsers normalize `\r\n` identically; locked by 2 new corpus tests.
- **Extension YAML parser parity fixes** — CRLF normalization, duplicate-key
  rejection (mappings and flat flow mappings), mirroring skill/scripts/lib/yaml.mjs.
- **tests**: `codegraph.test.mjs`, `docs.test.mjs`, `skill-registry.test.mjs`
  (skill); `codegraph.test.mjs` (CLI); `context-budget.test.mjs` (internal).
  30+ new tests; skill suite now 183, CLI suite now 100, internal suite new (11).

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

### Changed
- **The skill no longer restates CodeGraph's command surface.** Once the MCP
  server is wired it exposes its own tool set to the agent, so the shipped
  skill keeps only the rules that matter (bootstrap once, never re-index, use
  the MCP tools for comprehension, telemetry is on by default) and points at
  the installed CLI for command syntax. The official command list now lives
  only in the runtime script and `assets/harness-mcp.json` (data the writer
  needs), not in the agent-facing docs.
- **"Init once" is now stated identically everywhere** — SKILL.md, platforms.md,
  orchestration.md, interview.md and the script output all say: the index is
  built once per project, the server's watcher keeps it live, and nothing is
  re-indexed by hand. Manual index/sync is documented only as the escape hatch
  for a disabled watcher.
- **Comment + prose diet** (token size): the agent-facing surface was trimmed
  to essentials — `codegraph.mjs` 80 → ~55 comment lines, `lib/docs.mjs` 66 →
  26, `lib/spawn-npm.js` 30 → 11, `cli/lib/codegraph.js` 26 → 11,
  `internal/tools/tokens.mjs` 33 → 20; SKILL.md's CodeGraph section, Hard rule
  9 and the platforms.md CodeGraph section were rewritten tighter. Shipped
  payload: 76.3k → 74.3k tokens; the always-loaded SKILL.md: 6.2k → 5.9k.
- **CodeGraph bootstrap now drives ONLY the official commands** (verified against
  the official docs): `npm i -g @colbymchenry/codegraph` (install, always the
  latest published release — **no version is pinned anywhere**),
  `codegraph upgrade` / `codegraph upgrade --check` (freshness, official
  updater), `codegraph install --target=<ids> --location=<global|local> --yes`
  (wiring), `codegraph init <path>` (creates `.codegraph/` AND builds the
  graph in one step), `codegraph status --json` (verification),
  `codegraph telemetry status|on|off` (disclosure). The custom script only
  adds what the official installer does not cover: detection of DETECTED
  harnesses, the approval gate before any config write, telemetry disclosure,
  and the config write for harnesses codegraph does not target (VS Code /
  Copilot, Windsurf, Zed, Trae) with the per-platform key from
  `assets/harness-mcp.json`.
- **No codegraph version is referenced in the shipped skill** — the docs point
  at `codegraph help <command>` for the current surface, and the installer
  always takes the latest published release.

### Fixed
- **Windows npm spawn (EINVAL)** — `npm` was spawned unshelled, which fails on
  Windows since the CVE-2024-27980 hardening, so `update` always reported
  "could not reach the npm registry". Root fix: `lib/spawn-npm.js` invokes
  npm's JS entry point with the current node binary (no shim, no shell), with
  a portable PATH lookup replacing the POSIX-only `command -v`. The Windows-only
  regression test was rewritten as two cross-platform tests — the CLI suite now
  reports **0 skipped** (was 1).


- **install.sh shipped the dev-only `scripts/test` suite** into every installed
  store (the CLI prunes it via `DEV_ONLY_RELPATHS`); both `--init` and global
  `--copy` now prune `scripts/test` and OS junk, matching the CLI.
- **install.sh `--init` skipped the CodeGraph bootstrap** entirely; it now
  runs the same engine as the CLI (`node scripts/codegraph.mjs ensure --yes`).
- **Vendor mirror drift** — new `scripts/codegraph.mjs`, `scripts/lib/docs.mjs`,
  `scripts/lib/yaml.mjs` parity fixes and `assets/harness-mcp.json` were not in
  the npm payload until re-synced. (The token/context QA tooling was
  deliberately moved out of the payload into `internal/` in the same pass.)
- **platforms.md CodeGraph section was written against v1.0.1** (install flags,
  target list, Node 22/24 requirement, "100% local" telemetry claim). Updated to
  v1.6.2: `codegraph install --target=...`, `init` indexes by default,
  telemetry ON by default with a machine ID (`codegraph telemetry
  status|on|off`; disclosed, never auto-disabled without consent).
- **assets/mcp-template.json used the non-existent `codegraph mcp` subcommand**
  in every variant; all now use `codegraph serve --mcp`.
- **`.gitignore` now excludes `.codegraph/`** (14 MB local index was
  accidentally created in the repo by the test suite before the
  `ARCHGEN_CODEGRAPH=0` guard existed — removed).


## [0.0.5] - 2026-08-27

Enterprise-hardening release: restore reliability, security, performance
budgets, installer safety, and release hygiene across skill, CLI, and
extension.

### Added

- **Extension restore hardening**: `onWebviewPanel:archgen.taskBoard`
  activation event + `retainContextWhenHidden` so a quit/restart-restored
  board re-runs its `ready` handshake and renders with zero interaction; a
  webview watchdog re-posts `ready` (750 ms → 5 s backoff, capped at 2 min
  with an explicit Retry card) instead of spinning forever. Locked by
  `test/panel-restore.test.ts` + `MANUAL-TEST.md` §11 full-restart repro.
- **Fork smoke checklist** (`MANUAL-TEST.md` §16): human-executed release gate
  for VS Code forks (Cursor 1.4+, Windsurf) — open board, reload,
  quit+restart, search, build→clipboard, theme switch.
- **Accessibility scope documented**: WCAG 2.1 AA scoped commitment in the
  extension README — keyboard navigation, theme-variable contrast, aria-live
  for status pushes (third-party render internals explicitly out of scope).
- **CI hardening** (`.github/workflows/ci.yml`): skill/CLI matrix on Node
  20+22; extension typecheck/compile/test pinned to Node 22 with a HARD ≥90%
  coverage gate; cross-mode parity; version/vendor single-source check;
  `npm audit --audit-level=high`; gitleaks secret scan over full history;
  vsix built by CI and uploaded as the `archgen-extension-vsix` artifact —
  never committed to the repo.
- **`docs/releasing.md` single-source release flow**: bump the version in
  `archgen.config.json`, run `node packages/cli/scripts/sync-config.mjs &&
  node packages/cli/scripts/sync-vendor.mjs`, verify with `sync:check`.
- **Tag-triggered release workflow** (`.github/workflows/release.yml`):
  pushing a `vextension-*` tag runs the extension gates, builds the vsix, and
  publishes a GitHub Release with the vsix attached — no manual upload step.
- **Root monorepo scripts**: a private, scripts-only root `package.json` —
  `npm run setup` (once) installs extension deps, `npm test` runs the skill +
  CLI + extension suites CI runs, plus `test:fixtures`, `sync`, and
  `sync:check` aliases. Deliberately not npm-workspaces (the extension keeps
  its own lockfile + native rebuild); no root `version` field (single source
  stays `archgen.config.json`).
- **Community policies**: `SECURITY.md` (private vulnerability reporting via
  GitHub advisories or email) and `CODE_OF_CONDUCT.md` (Contributor Covenant
  2.1).

### Changed

- Extension: SETUP folded out of the tab strip into a centered dialog opened by a new ⚙ header button (⋯ menu too); empty-state copy tightened; sidebar clicks (feature/task/doc) now land you on the right board view.
- README installs point at the CI-built vsix on GitHub Releases instead of an
  in-repo vsix file.
- Version is single-sourced: `archgen.config.json` is now the only place the
  version is edited; sync-config propagates it to the skill config, SKILL.md
  frontmatter, and both package.json files (CI `vendor-check` fails on drift).

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

### Fixed

- **Security (extension)**: markdown-it `validateLink` allowlist blocks
  `javascript:`/`data:text/html`/other-scheme XSS in rendered docs (degrades
  to literal text); task ids are sanitized before reaching the harness
  `{{outfile}}` path (no tmpdir traversal); all codegraph SQL identifiers are
  quoted; harness `spawn` delivery is refused in untrusted workspaces
  (clipboard delivery unaffected).
- **Security/safety (CLI installer)**: no write-through-symlink anywhere
  (lstat-based guards incl. parent-dir escapes); copy-mode installs back up
  foreign targets before replacing; managed-block markers normalize to exactly
  one pair; `install.sh` parity with CLI semantics.
- **Extension perf**: codegraph re-send gated by DB stat (unchanged index →
  zero re-read/re-serialize); search input debounced (200 ms) with ≤2
  relayouts per burst; dagre layouts cached per component; codegraph focus and
  selection survive live background updates (no more ghost-selection dimming).
- **Extension readers**: warn-don't-throw tolerance locked for dup ids,
  invalid statuses, empty/CRLF/unicode docs; corrupt sibling features degrade
  to a warning while the active board renders; 10k-task parse <500 ms.
- Extension: the kickoff-prompt input was a top-center native quick-input jump; it now opens as a centered modal inside the Task Board itself (Enter copies, Esc cancels), while non-board entry points keep the native input.
- Clicking a Docs-tree entry could update an invisible board; documents now
  open the board directly on their page.
- `CONTRIBUTING.md` repo map now names the CLI package correctly
  (`archgen-skill`, not `archgen`).

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

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

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

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

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

[0.0.5]: https://github.com/akashmaurya99/archgen/releases/tag/vextension-0.0.5
[0.0.4]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.4
[0.0.2]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.2
[0.0.1]: https://github.com/akashmaurya99/archgen/releases/tag/v0.0.1
