# ArchGen Extension

A VS Code extension (works in Cursor/Windsurf and other VS Code forks) that turns your `.archgen/` folder into living pictures:

- **TASKS** — a task board drawn as a dependency graph where running tasks pulse, done tasks glow green, failed ones red.
- **CODE** — a map of your code's real dependencies read straight from the codegraph SQLite index.
- **DOCS** — rendered docs with mermaid diagrams, click-through to source.

The extension is strictly a **window**: it reads files and (in a later milestone) spawns your agent CLI — it never edits anything itself. Uninstalling it loses nothing.

## Status

Waves 1–3 of the [execution plan](../../docs/) are implemented: scaffold, design tokens, `.archgen` parsers, codegraph reader, status store, watcher pipeline, webview shell. DAG canvas, build button, docs rendering, code-graph view, polish and packaging land in waves 4–6.

## Native module decision (SQLite)

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

Packaging: `better-sqlite3` stays **external** in the esbuild host bundle and ships as a native module per the [VS Code bundling guide](https://code.visualstudio.com/api/working-with-extensions/bundling-extension).

**No webview-ui-toolkit**: the library is archived by Microsoft; the UI is React 18 + `@xyflow/react` v12 only.

## Development

```bash
npm install
npm run compile      # dist/extension.js (host cjs) + media/webview/main.js (iife es2020)
npm run typecheck    # tsc --noEmit, strict
npm test             # vitest: corpus parity, parsers, store batching, codegraph FTS, tokens WCAG, watcher debounce, webview shell
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

### Codegraph products

| Detection | Product | Support |
| --- | --- | --- |
| `<ws>/.codegraph/codegraph.db` | colby | ✅ read-only (nodes/edges/files/nodes_fts FTS5) |
| `<ws>/.codegraph/graph.db` | optave | ✅ read-only (+confidence columns tolerated) |
| `~/.codegraph/graph.db` (global) | — | ❌ typed `UnsupportedProductError` → UI banner |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `archgen.harness.default` | `claude` | Agent harness invoked by the ▶ build button (wave 5). |
| `archgen.harness.templates` | claude template | Command templates per harness; placeholders `{{prompt}}`, `{{task}}`. |

## Guardrails

- No extension-side mutation of any repo file (display + spawn only).
- No agent runtime / LLM calls inside the extension.
- No JetBrains target. No telemetry. No marketplace publishing automation.
- No RocksDB parsing (codegraph-ai product shows the unsupported banner).
- The webview performs ZERO direct fs/network IO — all IO is host-side.
