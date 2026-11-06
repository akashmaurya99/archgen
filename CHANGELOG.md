## [0.0.7] - 2026-11-07

This release is the hardening pass that followed the MCP-first cutover. A
line-by-line audit of all three packages found 50 defects; every one is fixed
here, each at its root cause rather than at its symptom. The ones that
changed what the tool DOES are listed first.

### Fixed — security

- **The MCP server's boundary was model-controlled.** Every containment check
  was relative to a root the MODEL chose, so naming a different
  `projectRoot` moved the edge of what the server would read or write. The
  server now owns an **anchor** — the directory it was started in — and a
  tool's `projectRoot` is a *selector*: it must resolve inside the anchor, or
  the call is refused with `PERMISSION_DENIED`.
- **The extension's bridge could be talked into writing anywhere.** A command
  id became the acknowledgement file's name, and an id of
  `../../../../package.json` overwrote the workspace's `package.json`. Ids
  are now validated as file names at parse time, so the command never runs.
- **A symlinked document could be read out of the artifact space.**
  `.archgen/leak.md -> ~/.aws/credentials` passed a lexical prefix check and
  its contents were rendered. The real path of both the target and the
  `.archgen` root is compared now.
- **Restoring a snapshot removed every other installed skill.** The vault
  recorded a top-level directory name and the restore rebuilt the whole tree
  from it. It now records the exact backed-up paths and restores exactly
  those.
- **`archgen uninstall <dir>` performed a GLOBAL uninstall.** The positional
  form was accepted and then dropped, so it removed every archgen copy from
  the user's home directories. A positional directory now routes to the
  project uninstall.
- **The wiring manifest's paths were untrusted input.** The manifest is a
  file in the repository, so a clone could ship one naming any file on the
  machine and have `uninstall_mcp` edit it. Recorded paths are contained now.
- **The CLI's containment guard ran after the destructive step.** `install`
  deleted the existing Claude copy before asserting it was inside the
  project. The assertion comes first.
- **The global uninstall guard was a suffix test.** Any manifest path ending
  in `skills/archgen` was removed, including one outside the known harness
  directories; an edited copy was removed with no backup. The guard is an
  exact allow-list now, and an edited copy is backed up first.
- **On Windows the MCP server was spawned with a shell and unquoted
  arguments**, including the user's project path — a path with spaces was
  split and a path with `&` was interpreted by `cmd.exe`. The shim's JS
  entry point is invoked with node, with no shell.
- **The scope gate accepted any `.archgen` segment on the machine.** The
  artifact space is anchored to the project root now.

### Fixed — correctness

- **A status update could destroy the plan.** The emitter quoted VALUES but
  wrote KEYS verbatim, so a quoted key like `"odd: key"` was re-emitted
  unquoted and the file no longer parsed — every later tool call then failed.
  Keys are encoded exactly like values now.
- **Two workers in one wave could lose each other's status update.** The
  whole read-modify-write now runs under an exclusive on-disk lock: the
  workers are separate processes, so the guard has to live on disk.
- **The coverage report was inverted.** It said every UNCOVERED task was
  covered, because it re-derived "is this task mentioned?" from the checker's
  NEGATIVE findings — and an uncovered task's finding names the task. The
  checker now returns what it computed.
- **`archgen_setup{action:'uninstall_mcp'}` always failed** — the function was
  never imported.
- **Wiring any MCP config crashed when Codex CLI was installed.** The
  registry named an entry shape the writer did not know, so the loop threw
  and every harness after it was never configured. The registry and the
  writer now agree, and a test makes that agreement structural.
- **The npx fallback produced a command that could never start** — the npx
  form and the installed form are DIFFERENT COMMANDS, not one command with a
  swapped executable.
- **The wiring manifest recorded the wrong key**, so uninstall removed the
  wrong section.
- **`archgen_codegraph{action:'wire'}` installed and upgraded CodeGraph.**
  Its own help said it would not. It now only wires.
- **An installed CodeGraph is never upgraded.** The upgrade ran on every
  bootstrap, so a plain `npx archgen-skill init` could rewrite a working
  installation the user had pinned. CodeGraph is installed when it is
  MISSING and left alone when it is there.
- **A dispatched brief could contain `<slug dir>`.** Seven placeholders, two
  substituted, and the `slug dir` one given the bare slug. Every placeholder
  is filled in from ONE source now, and a brief that would still carry one
  is refused.
- **The resume snapshot could say "wave 3 of 2"**, and could be written
  outside `.archgen/`. One formula is used by both the file and the response,
  and the snapshot resolves its slug directory through the scope gate.
- **A missing file came back as `INTERNAL`.** The agent is told to branch on
  the code; "the file is not there" is a fact it can act on.
- **The DOCS "open in editor" button always opened the wrong path** — the two
  "open a document" routes disagreed about their base directory.
- **The board rendered dark in a light theme** until the user switched
  themes once.
- **The task board re-laid out its whole DAG on every model push**, although
  the layout depends only on the structure.
- **The long-running child processes blocked the whole stdio server.** A
  global install or an index build meant the server could not answer a
  single other request for up to fifteen minutes. Those operations are async
  now.
- **Two document reads could finish out of order**, leaving the DOCS tab
  showing the first document while the sidebar highlighted the second.
- **The host's "copied to clipboard" messages were discarded by the
  webview**, so the user got no confirmation of the action they triggered.

### Fixed — the installer

- **The store swap was not atomic**, despite the header saying it was: the
  old store was deleted before the new one was renamed in, so a failed rename
  left no store at all.
- **A migration could mutate a file it never backed up** — the framework and
  the migration computed their file lists at different moments.
- **The doctor could crash instead of reporting**: one unreadable file
  aborted the whole run, and a manifest without `entries` was a TypeError.
  A `FAIL` row now sets a non-zero exit code, which it did not.
- **A failed MCP bootstrap was reported as success.**
- **`--project` was a flag on `init` but a directory name**, so
  `init --project .` created a directory called `--project`. It is now
  accepted as a flag everywhere, and an unknown flag is a usage error rather
  than a directory name.
- **The global uninstall skipped a failed entry and then deleted the
  manifest**, so that entry could never be cleaned up.
- **The CLAUDE.md managed block was never version-upgraded** — it stayed
  frozen at the version of the first-ever init.
- **A non-semver registry version slipped past the refusal guard**, because
  the comparison returned "equal" for anything it could not parse.

### Changed

- **The npm publish workflow no longer assumes a lockfile exists.** The CLI is
  zero-dependency and deliberately ships none, so `npm ci` refused to install
  it (`EUSAGE`). The install step is now lockfile-aware.
- **The npm publish order is enforced**, not just documented: the CLI leg
  checks the registry for `archgen-mcp@<version>` and refuses to publish
  before the server is there.
- **The publish credential check is plain shell.** The previous inline
  `node -e` script could not run at all (`node -e` rejects a top-level
  `return`), so the check exited 1 in silence. It now runs on every npm
  version boundary and names both fixes when it refuses.
- **The capability-contract example is version-agnostic.** A concrete version
  in a doc or a comment is wrong at the next release and nobody notices. The
  examples now use the `>=x.y.z` placeholder the repo already used in
  `docs/releasing.md`, and `internal/tools/version-lint.mjs` keeps them that
  way — so no release ever has to go and update a comment again.
- **The UI command queue is pruned** by age and by count, so it is bounded by
  construction instead of growing for the life of the project.
- **`archgen_codegraph{action:'wire'}` no longer installs** anything, and the
  manual config writer honours the same `targets` filter the native path
  honoured.

### Added

- **Version drift gates.** `npm run sync:check` now also verifies that each
  committed lockfile's version matches its `package.json` (a mismatch makes
  `npm ci` refuse to install), and CI checks the same thing with the exact
  command that fixes it.
- **`npm run test:versions`** — the umbrella version check.
  `version-consistency.mjs` verifies every version surface against the
  canonical source and reports each mismatch with the command that fixes it.
  `version-lint.mjs` refuses a version pinned in an *illustrative* surface
  (a doc, a README, a reference asset, a source comment, the manual-test
  script) — examples show a shape, not a release, so no release ever has to
  go and update a comment by hand. The pattern is derived from the canonical
  version's `MAJOR.MINOR`, so the gate adapts as the project moves.
- **The coverage report is uploaded as a CI artifact**, so a threshold
  failure says *which* file fell below without a local reproduction.
- **`archgen_plan{action:'brief'}` accepts the inputs a brief genuinely
  needs** — a feature request, a topic, a round — and refuses a brief that
  would still carry a placeholder.

### Fixed — from the previous section

- **Generated artifacts now record the version that produced them.** The
  `scaffold` action wrote a bare `# generator: archgen` — no version at all —
  even though the server knows its own version exactly. The provenance header
  therefore said nothing about which release created the file, and the only
  guidance for the agent was a placeholder it could copy literally. The tool
  now writes the running server's version, and the reference tells the agent
  to paste that header verbatim and never type a version itself.
- **The extension read the MCP server's response on `'exit'`**, which fires
  before stdout is drained. On a fast runner the client could see an empty
  buffer from a server that had answered correctly and report
  `produced no JSON (exit 0)`. It now reads on `'close'`, which fires after
  the stdio streams are closed. The same race in `launchHarness` (its output
  tail could lose its last lines) and in the dispatch toast is fixed too. A
  deterministic regression test reproduces the original failure byte-for-byte.

## [0.0.6] - 2026-11-06

### Changed — BREAKING: the MCP server owns every capability

- **The skill ships no code.** `skill/scripts/*.mjs` (11 scripts + 5 lib
  modules) and their test suite are **deleted**. The skill is now guidance only.
- **New package `packages/mcp/`** (npm: `archgen-mcp`): the MCP server that
  owns all deterministic capability, built on the official
  `@modelcontextprotocol/server` v2 (2026-07-28 spec) with Zod v4.
  - 10 domain tools: `archgen_plan`, `archgen_tasks`, `archgen_docs`,
    `archgen_registry`, `archgen_codegraph`, `archgen_setup`, `archgen_ui`,
    `archgen_skills`, `archgen_refs`, `archgen_help`.
  - Every result is a typed envelope `{ ok, data, error, meta }` with a stable
    error-code taxonomy (`INVALID_INPUT`, `NOT_FOUND`, `CYCLE`,
    `OWNERSHIP_CONFLICT`, `CONFLICT`, `PERMISSION_DENIED`, `UNAVAILABLE`,
    `TIMEOUT`, `INTERNAL`).
  - A CLI facade (`archgen-mcp exec|bootstrap|doctor|uninstall-mcp`) lets the
    CLI installer and the VS Code extension reach the SAME handlers the agent
    uses — one implementation, three ways in.
- **One generic harness writer.** `core/harness-wiring.mjs` writes MCP entries
  for BOTH archgen and CodeGraph — one approval gate, one symlink guard, one
  idempotency check, one manifest-scoped uninstall. JSON and TOML (Codex CLI).
- **Real-time UI control.** `archgen_ui` drives the VS Code extension over a
  filesystem command queue (`.archgen/.runtime/cmd/` → `ack/`) with an
  allowlist, a workspace-root check, expiry, and idempotent replay. The data
  plane already worked (the extension's watcher); this adds the control plane.
- **CodeGraph** is installed, wired and indexed by the MCP server, which drives
  the official CLI and never reimplements it.
- **Installer wiring.** `archgen-skill init` / `install` now wire the archgen
  MCP server into every detected harness (new `--no-mcp` flag alongside
  `--no-codegraph`) and report an MCP-wired check in `doctor`.
- **Node floor raised to >= 20** (the official MCP SDK v2 requires it).

### Added — the capability contract

The skill calls the MCP server's tools — that is a dependency, and an
undeclared dependency is a latent outage: a skill at v1 driving a server at v2
whose action names changed fails SILENTLY (the agent calls a removed action and
improvises). It is now declared and enforced:

```yaml
# skill/SKILL.md frontmatter
metadata:
  requires:
    archgen_mcp: ">=0.0.6"
```

- `archgen_setup{action:'doctor'}` reports a `CAPABILITY MISMATCH` row.
- `archgen_setup{action:'bootstrap'}` reports the contract before wiring.
- A CI gate (`internal/tools/check-capability-contract.mjs`) refuses to ship a
  skill whose declared minimum exceeds the server's version.

### Added — `archgen_refs`, and the references moved into the package

The five orchestrator-facing protocol documents (`interview`, `orchestration`,
`artifact-templates`, `platforms`, `mcp-and-skills`) moved from
`skill/references/` into `packages/mcp/assets/references/` and are served
**section by section** by the new `archgen_refs` tool (`list` / `index` /
`read` / `search`).

**Why:** the references describe how to use the tools, so they must be the SAME
VERSION as the tools — and they must not be copied into every project that runs
`archgen-skill init` (56 KB per project, identical everywhere). Serving a
section costs ~1–2 KB against ~11 KB for a whole document, so the agent's
on-demand context went DOWN, not up.

`code-standards.md` stays a plain file in the skill: WORKER sub-agents read it
with their native file tools and may have no MCP server at all.

### Changed — the skill payload

The shipped skill tree is now `SKILL.md` + `references/code-standards.md` +
`archgen.config.json` — **9,190 tokens, down from 25,793**. Every `§` mark in
`SKILL.md` is an obligation ("load this section before acting"), the mode table
names the sections to load, and Hard rule 9 requires re-loading them after a
compaction.

### Added — the deterministic output became tool output

The skill keeps the **judgment** (policy, rules, when-to-use); the MCP server
owns the **deterministic output**. Four new actions, no new tools:

| Action | Replaces hand-assembly in |
|---|---|
| `archgen_plan{action:'scaffold'}` | the depth ladder's artifact set + the templates |
| `archgen_plan{action:'brief'}` | the verifier / review / survey / investigate briefs |
| `archgen_tasks{action:'contract'}` | the worker prompt contract (8 rules, assembled) |
| `archgen_setup{action:'harness_info'}` | the harness capability tables |

New canonical assets: `depth-ladder.json`, `platform-capabilities.json`,
`briefs/*.md`, `templates/*`. The artifact templates moved from prose examples
into `templates/*`, so the tool serves them and a copy can never drift.

### Added — capability skills as a tool

`archgen_skills` (match / install / installed / load / list) replaces the
skill's FETCH-SKILL prose and its JSON registry. Verified against the official
repos: the `skills` CLI installs ONE named skill non-interactively
(`npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json`) and
lands it at `<project>/.agents/skills/<slug>/SKILL.md`. No clustering — a
capability DOMAIN maps to ONE precise skill.

### Release

This release ships **three** artifacts at the same version (single-sourced from
`archgen.config.json`):

| Artifact | npm / distribution | Tag |
|---|---|---|
| `archgen-mcp` — the MCP server | npm | `vmcp-0.0.6` |
| `archgen-skill` — the CLI + the skill | npm | `vcli-0.0.6` |
| The VS Code extension | GitHub Release (`.vsix`) | `vextension-0.0.6` |

**Publish order: the MCP server first.** The CLI's installer resolves
`archgen-mcp` from the registry, so a release that advertises the MCP server
before it exists would hand users a broken bootstrap. The extension is
version-agnostic and can ship in any order.

### Fixed

- The extension's YAML port and the MCP core's parser now have a **parity
  test** over the shared corpus, so the two can never drift silently.
- Duplicate mapping keys are rejected consistently by both parsers (a plan
  file with a duplicate key is corrupt — silently taking the last value hid it).
- **Three latent template bugs**: the canonical artifact templates were prose
  examples that were never validated, and three of them carried YAML the parser
  REJECTS (`notes: >= 0` parsed as a block scalar; an unquoted
  `enum(a,b,c)` inside a flow mapping; a plain scalar containing `": "`).
  Moving them into the tool — where a test parses them — exposed and fixed all
  three.
- **The YAML-subset guidance was wrong**: flow mappings and sequences ARE
  supported (the parser accepts them and the corpus proves it). Only block
  scalars, duplicate keys and unterminated flow sequences are rejected.
- `references/platforms.md` drift corrected against the official docs
  (Antigravity's global path, Codex's legacy `~/.codex/skills/`, VS Code /
  Copilot's project path, Trae CN, and the Gemini → Antigravity transition).

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

[0.0.6]: https://github.com/akashmaurya99/archgen/releases/tag/vextension-0.0.6
[0.0.5]: https://github.com/akashmaurya99/archgen/releases/tag/vextension-0.0.5
[0.0.4]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.4
[0.0.2]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.2
[0.0.1]: https://github.com/akashmaurya99/archgen/releases/tag/v0.0.1
