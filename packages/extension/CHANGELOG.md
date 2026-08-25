# Changelog

All notable changes to the ArchGen extension are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semver.

## [0.0.3] - 2026-08-25

### Added
- Extension icon (activity-bar glyph + package logo) and an ArchGen view container in the activity bar; clicking it opens the Task Board panel.
- Feature picker: multi-feature repos (`.archgen/<slug>/`) get a TASKS-header dropdown, most-recent-first, persisted per workspace; board falls back gracefully when the active feature folder disappears.
- Multi-feature model: `features[]` + `activeSlug` in the host↔webview protocol with per-slug warning prefixes.

### Changed
- `probeScriptsPath` order corrected and extended: configured → `<ws>/.agents/skills/archgen/scripts` → `<ws>/.claude/skills/archgen/scripts` → legacy bare `<ws>/skills/archgen/scripts` → `~/.agents/…` → `~/.claude/…`.
- Fixed pre-existing cross-mode fixture path bug from the monorepo restructure.
- Test suite grew 189 → 212; render budgets: status flip ≤2, feature-switch remount ≤3.

## [0.0.1] - 2026-08-25

### Added
- TASKS view: dagre left→right task DAG with the exact six-status schema enum (pending/ready/running/blocked/done/failed), running pulse ring, animated edges into running targets (capped at 50), MiniMap/Legend/Controls.
- CODE view: read-only codegraph dependency graph for colby (`codegraph.db`) and optave (`graph.db`) products, kind-colored nodes, edge-kind filter chips, client search, impact highlight, unsupported-product banner, virtualization beyond 500 nodes.
- DOCS view: markdown-it (html:false) + mermaid strict-mode rendering of `.archgen/**` markdown with per-diagram error isolation and click-through to source.
- Live updates: FileSystemWatcher on `.archgen/**` + `.codegraph/**` with 300ms coalesced debounce → rAF-batched immutable status patches (only changed nodes re-render).
- ▶ Build / Start Work: configurable harness templates (claude/opencode/codex/gemini/custom) spawned read-only via child_process; scripts-path probing; exit-code toasts.
- Enterprise polish: keyboard navigation (Tab through nodes, Enter/Space dispatches build), ARIA labels, focus-visible rings, empty state with copyable `npx archgen generate` CTA, dimmed last-good graph under a dismissible top-center error banner, "updated Ns ago" stale chip, documented perf budgets (render-count per flip ≤2, ≤50 animated edges, virtualization at >500 nodes), zero-CSP-violation console scan.
- Cross-mode check: `npm run cross-mode` asserts parser↔view-model parity against `fixtures/greenfield-demo/.archgen/demo/tasks.yaml`.
