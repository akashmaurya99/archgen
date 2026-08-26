# Changelog

All notable changes to the ArchGen extension are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semver.

## [Unreleased]

### Changed
- Proactive setup UX is now a board-integrated **SETUP** tab (TASKS | CODE | DOCS | SETUP) fed by the same live-update pipeline as the model: summary rows (skill / plan / up-to-date), one action card per pending step with copy-prompt delivery, and the compact "ArchGen is set up." row once resolved. The standalone *ArchGen Setup* window is deleted — notifications, the setup status-bar item and `ArchGen: Open Setup` all open the board with the SETUP tab active. A header **⋯** menu (right of the tab strip, every state including empty workspaces) exposes *Setup & updates* and *Copy install prompt* from any tab, and the empty state gains an *Open Setup & updates* bridge button.

### Fixed
- Selecting or revealing **SETUP** in a workspace with no ArchGen content rendered the stale "No ArchGen plan found" empty state instead of the setup view (the empty-state fallback short-circuited every tab), so status-bar/notification entry points read as dead buttons in exactly the empty folders where setup matters most. Render order now evaluates the SETUP tab first; opening the board with no workspace folder shows *Open a folder to use ArchGen.* instead of silently doing nothing.
- File-watcher race on freshly-scaffolded `.agents`/`.archgen` trees left setup state stale until focus or reload: deep globs like `.agents/skills/archgen/**` are registered before their directories exist, so events for files written milliseconds after `mkdir -p` chains were dropped. Root-entry watchers on `{.archgen,.agents,.claude}` now fire on scaffold creation/deletion, trigger an immediate direct filesystem re-probe plus ONE trailing follow-up (~600ms), and a throttled window-focus reconcile (≥3s) converges both setup truth and the board model even if every watch event was lost.

## [0.0.4] - 2026-08-25

### Added
- **50k-scale architecture (Map → Explore → Inspect)**: a Canvas2D MAP constellation renders the ENTIRE codegraph (50,000+ symbols, quadtree picking, pan/zoom 0.02×–4×, dirty-flag render loop — 50k dots packed in <100ms), while the DOM graph never renders more than ~300 nodes.
- **Size-tier auto-mode** in the CODE tab, chosen by the largest connected component: ≤60 symbols → radial ring; 61–300 → **file-hub dagre** (files as hub nodes, symbol counts as captions, click to drill into the file's symbol graph); >300 → file-hubs + focus-first. Graphs without a file rollup degrade gracefully to per-component flow blocks — never a giant ring.
- **Zoom LOD**: below 0.35 zoom nodes collapse to kind-colored dots, labels appear only on hubs (degree ≥5), and low-degree edges hide — the tier-flip costs one class patch per node, no structural remounts.
- Host data layer: `fileRollup()` (SQL GROUP BY file + file-pair edge coalescing), `topHubs()` (degree-ranked), `neighborhood(id, depth)` (BFS via chunked IN queries), snapshot defaults raised to 60k/150k, prepared-statement caching, and a deterministic 50k-fixture generator (`scripts/build-big-fixture.mjs`) with perf smoke tests.
- CODE tab: radial circular layout — nodes sit on a shared circle with even spacing starting at 12 o'clock, wrapped by ring pseudo-nodes (`__ring`) drawn as SVG circles with kind-colored anchor dots and **component labels above every ring/cluster**; a **Flow** toggle switches to isolated per-component dagre blocks.
- Component affordances: file nodes that would render a real focus graph get an accent border, pointer cursor and a ▸ drill glyph; files whose focus would be empty render inert — affordance and click behavior can never diverge.
- Floating focus breadcrumb (‹ All files / `<file>` · N symbols) replacing the toolbar back chip.
- `vscode:prepublish` npm hook (`npm run compile`) — vsce now always rebuilds both bundles at package time, so a vsix can never ship a stale webview bundle again.

### Changed
- Bolder default rendering for legibility at any zoom: 2px edges (3.5px highlighted, 0.75 resting opacity), 1.5px node borders, 8px kind dots; compact single-row toolbar with slimmer edge-kind chips.
- Clicking a file hub opens its focus only when it contains ≥2 interconnected symbols (empty-open guard) — affordance, guard and tests share one `openableById` set.

### Fixed
- Node overlap and arrow-tip misalignment in the CODE graph: cards are constrained to their layout box (`100% × 100%`, overflow hidden), and every edge uses explicit per-node face anchors (`sourcePosition`/`targetPosition`) derived from the radial geometry.
- React Flow attribution badge removed at the bundler root (esbuild strip plugin + build-time tripwire) instead of hidden via CSS.

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
