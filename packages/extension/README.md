# ArchGen Extension

A VS Code extension (works in Cursor/Windsurf and other VS Code forks) that turns your `.archgen/` folder into living pictures:

- **TASKS** — a task board drawn as a dependency graph where running tasks pulse, done tasks glow green, failed ones red.
- **CODE** — a map of your code's real dependencies read straight from the codegraph SQLite index.
- **DOCS** — rendered docs with mermaid diagrams, click-through to source.
- **▶ Build / Start Work** — copies the composed prompt to your clipboard for any agent chat (Copilot Chat, Cursor, Cascade, terminal CLIs…) with best-effort pre-fill of native chat inputs; legacy headless CLI dispatch (`claude`/`opencode`/`codex`/`gemini`/custom) remains available via `archgen.delivery.mode`.

The extension is strictly a **window**: it reads files and hands prompts to your agent — clipboard-first by default, optional headless spawn — and never edits anything itself. Uninstalling it loses nothing.

## Features

| Area | What you get |
| --- | --- |
| Task DAG | dagre left→right layout; exact six-status enum `pending · ready · running · blocked · done · failed` (no cancelled exists); running pulse ring; edges animate only into running targets; MiniMap + Legend + zoom Controls. |
| Multi-feature repos | A **feature picker** in the TASKS tab header lists every `.archgen/<slug>/` feature (most-recently-modified first). The choice persists per workspace (`workspaceState`), and the default is the most-recent feature. |
| Live updates | FileSystemWatcher on `.archgen/**` and `.codegraph/**`, 300 ms coalesced debounce → rAF-batched immutable patches; only changed nodes re-render. |
| Keyboard + ARIA | Tab walks task nodes; **Enter/Space** on a focused node dispatches ▶ build; nodes announce `task <id>: <title>, status <status>`; visible focus rings from the theme's focus border. |
| States | Empty state with copyable `npx archgen-skill init` install CTA; errors keep the last-good graph mounted (dimmed) under a dismissible top-center banner; "updated Ns ago" stale chip. |
| Docs | markdown-it (`html:false`) + mermaid strict mode; per-diagram error isolation; open-in-editor click-through. |
| Code graph | colby/optave SQLite indexes read **read-only**; kind colors; edge-kind filter chips; search; impact highlight; unsupported-product banner. |

## Performance budgets (enforced by tests)

| Budget | Value | Where proven |
| --- | --- | --- |
| Re-renders per status flip | ≤ 2 for the changed node (expected exactly 1), 0 for untouched nodes | `test/polish-perf.test.tsx` render-count spy |
| Animated edges | ≤ 50 (`MAX_ANIMATED_EDGES`); 60 running targets → exactly 50 animated | same file |
| Virtualization switch | `onlyRenderVisibleElements` ON above 500 nodes (verified at 500/501) | same file + `data-virtualized` attr |
| CSP violations | ZERO across tab switches (jsdom console capture + `securitypolicyviolation` events) | same file; workbench confirmation in MANUAL-TEST.md §12 |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `archgen.harness.default` | `claude` | Agent harness invoked by the ▶ build button: `claude \| opencode \| codex \| gemini \| custom`. |
| `archgen.harness.templates` | see below | Command template per harness. Placeholders: `{{prompt}}`, `{{task}}`, `{{outfile}}`. |
| `archgen.scriptsPath` | *(empty)* | Explicit path to the archgen scripts dir (`next-tasks.mjs`, `set-status.mjs`). Probed in order: this setting → `<ws>/.agents/skills/archgen/scripts` → `<ws>/.claude/skills/archgen/scripts` → `<ws>/skills/archgen/scripts` → `~/.agents/skills/archgen/scripts` → `~/.claude/skills/archgen/scripts`. A typed UI error appears when none resolve. |
| `archgen.delivery.mode` | `clipboard` | How ▶ Build This Task / ▶ Start Work deliver work: `clipboard` copies the composed prompt for you to paste into any agent chat (works everywhere); `spawn` runs the legacy headless CLI harness. |
| `archgen.delivery.autoFillChat` | `true` | After copying, best-effort pre-fill of the IDE's native chat input (ignored where unsupported). |

### Harness template examples

```jsonc
{
  "archgen.harness.templates": {
    // default claude: non-interactive print mode, edits auto-accepted
    "claude":   "claude -p \"{{prompt}}\" --output-format json --permission-mode acceptEdits",
    // opencode headless run
    "opencode": "opencode run \"{{prompt}}\" --auto --format json",
    // codex exec sandboxed to the workspace, JSON events, transcript to {{outfile}}
    "codex":    "codex exec --sandbox workspace-write --json -o \"{{outfile}}\" \"{{prompt}}\"",
    // gemini CLI
    "gemini":   "gemini --output-format json \"{{prompt}}\"",
    // custom: any command line; {{task}} gives the bare task id
    "custom":   "my-agent run --task {{task}} --notes \"{{prompt}}\""
  }
}
```

Spawn rules: `child_process.spawn` with `cwd` = workspace root; stdout tail streams to the *ArchGen* output channel; exit code 0 → info toast, non-zero → error toast. The spawned agent updates task status itself via `set-status.mjs` — the extension never writes repo state.

## Codegraph product support matrix

| Detection | Product | Support |
| --- | --- | --- |
| `<ws>/.codegraph/codegraph.db` | colby | ✅ read-only (nodes/edges/files/nodes_fts FTS5) |
| `<ws>/.codegraph/graph.db` | optave | ✅ read-only (+confidence columns tolerated) |
| `~/.codegraph/graph.db` (global home) | — | ❌ typed `UnsupportedProductError` → explicit **unsupported banner** in the CODE tab (no partial graph, no crash) |
| RocksDB-style indexes (codegraph-ai) | — | ❌ unsupported banner (never parsed) |

## Native module note (SQLite)

**Chosen: `better-sqlite3` (native) as primary driver + `node:sqlite` feature-detected fallback.** Not sql.js/WASM-primary.

Why:

- Codegraph reads are synchronous, read-only, small-result queries; the native binding is the fastest and simplest path.
- sql.js would force async handoff, manual persistence plumbing, and ship a WASM blob inside the vsix for no benefit.
- The database is opened with `{ readonly: true }` — the extension structurally cannot mutate an index.
- If the native binding fails to load (Electron ABI mismatch before rebuild), `src/host/codegraph.ts` falls back to `require('node:sqlite')` (`DatabaseSync`, Node ≥ 22.5 / Electron ≥ 33 runtimes) automatically. Only when NO driver can open the detected DB does a typed `UnsupportedProductError` reach the UI banner.

Supported matrix:

| Context | Requirement |
| --- | --- |
| VS Code desktop ≥ 1.90 | `npx electron-rebuild -f -w better-sqlite3` against the profile's Electron ABI (devDep `@electron/rebuild`); or rely on the node:sqlite fallback on Electron ≥ 33 |
| Node-based (vitest, CLI smoke) | plain `npm install` — prebuilds cover Node 20/22/24 on darwin-arm64/darwin-x64/linux-x64/win32-x64 |

Packaging: `better-sqlite3` stays **external** in the esbuild host bundle; the vsix ships only its runtime chain (`lib/` JS + `prebuilds/*.node`) per `.vscodeignore` — see the `//` decision block in `package.json`. Note `vsce package --no-dependencies` would skip node_modules entirely and DROP the native binding, so `npm run package` runs plain `vsce package`; the `.vscodeignore` whitelist (`node_modules/**` excluded, better-sqlite3 runtime re-included) keeps the vsix at ~1.6 MB.

**No webview-ui-toolkit**: the library is archived by Microsoft; the UI is React 18 + `@xyflow/react` v12 only.

## Development

```bash
npm install
npm run compile      # dist/extension.js (host cjs) + media/webview/main.js (iife es2020)
npm run typecheck    # tsc --noEmit, strict
npm test             # vitest: corpus parity, parsers, store batching, codegraph FTS, tokens WCAG,
                     #          watcher debounce, webview shell, a11y/polish, perf budgets, CSP scan
npm run cross-mode   # parser↔view-model parity vs fixtures/greenfield-demo/.archgen/demo/tasks.yaml
npm run package      # npx @vscode/vsce package --no-dependencies → archgen-extension-<version>.vsix
npm run watch        # dual-context incremental builds
npm run build:fixture-db   # regenerate committed test/fixtures/*.db via DDL
```

### Dual-context build

| Bundle | Format | Platform | Target | Externals |
| --- | --- | --- | --- | --- |
| `dist/extension.js` | cjs | node | node20 | `vscode`, `better-sqlite3` |
| `media/webview/main.js` | iife | browser | es2020 | none (fully bundled) |

Removing `'vscode'` from the host externals MUST fail the build with `Could not resolve "vscode"` — that is the guard proving host-only modules never leak into browser bundles.

### Shared YAML corpus

`fixtures/yaml-corpus/` (repo root) is consumed by BOTH parser implementations:

- `skills/archgen/scripts/lib/yaml.mjs` via `skills/archgen/scripts/test/corpus.test.mjs` (node:test)
- `extension/src/host/readers/yaml.ts` (faithful TS port) via `extension/test/corpus.test.ts` (vitest)

Both assert identical `data`, identical `comments`, identical error behavior against the `*.expected.json` siblings. Never adjust expected outputs unilaterally — fix both sides together.

## QA

Manual workbench protocol with expected outcomes per step: see `MANUAL-TEST.md`. Release history: see `CHANGELOG.md`.

## Guardrails

- No extension-side mutation of any repo file (display + spawn only).
- No agent runtime / LLM calls inside the extension.
- No JetBrains target. No telemetry. No marketplace publishing automation.
- No RocksDB parsing (codegraph-ai product shows the unsupported banner).
- The webview performs ZERO direct fs/network IO — all IO is host-side.
