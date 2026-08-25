# Changelog

All notable changes to the ArchGen extension are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); semver.

## [0.1.0] - 2026-08-25

### Added
- TASKS view: dagre left→right task DAG with the exact six-status schema enum (pending/ready/running/blocked/done/failed), running pulse ring, animated edges into running targets (capped at 50), MiniMap/Legend/Controls.
- CODE view: read-only codegraph dependency graph for colby (`codegraph.db`) and optave (`graph.db`) products, kind-colored nodes, edge-kind filter chips, client search, impact highlight, unsupported-product banner, virtualization beyond 500 nodes.
- DOCS view: markdown-it (html:false) + mermaid strict-mode rendering of `.archgen/**` markdown with per-diagram error isolation and click-through to source.
- Live updates: FileSystemWatcher on `.archgen/**` + `.codegraph/**` with 300ms coalesced debounce → rAF-batched immutable status patches (only changed nodes re-render).
- ▶ Build / Start Work: configurable harness templates (claude/opencode/codex/gemini/custom) spawned read-only via child_process; scripts-path probing; exit-code toasts.
- Enterprise polish: keyboard navigation (Tab through nodes, Enter/Space dispatches build), ARIA labels, focus-visible rings, empty state with copyable `npx archgen generate` CTA, dimmed last-good graph under a dismissible top-center error banner, "updated Ns ago" stale chip, documented perf budgets (render-count per flip ≤2, ≤50 animated edges, virtualization at >500 nodes), zero-CSP-violation console scan.
- Cross-mode check: `npm run cross-mode` asserts parser↔view-model parity against `fixtures/greenfield-demo/.archgen/demo/tasks.yaml`.
