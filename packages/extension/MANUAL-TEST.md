# ArchGen Extension — Manual QA Protocol

Step-by-step workbench verification. Every step lists the **expected outcome**.
Automated coverage (vitest) already proves parsers, store batching, DAG rules,
a11y labels, perf budgets and a zero-CSP console scan in jsdom; this protocol
covers what only a real VS Code workbench can prove (native ABI, watchers,
spawns, theme vars, serializer). The workbench-level CROSS-MODE CHECK (§9) is
the deferred half of todo 13 — the CLI-level parity half runs automatically via
`npm run cross-mode`.

Setup: `npm install && npm run compile && npm test` must be green first.

---

## 1. Activation + panel open
1. Open a workspace containing `.archgen/` (e.g. `fixtures/greenfield-demo` after running `archgen-skill generate`, or any repo with `.archgen/demo/tasks.yaml`).
2. Run **ArchGen: Open Task Board** from the command palette.
   - ✅ Panel opens beside the editor; TASKS tab active; task nodes render as a left→right dependency graph; no error banner.

## 2. Empty state
1. Open an empty folder (no `.archgen/`).
2. Run **ArchGen: Open Task Board**.
   - ✅ "No ArchGen plan found" state shows the `archgen-skill generate` hint and a copyable `npx archgen-skill generate` pill; clicking **Copy** puts the command on the clipboard and the button reads `Copied!`.

## 3. Status matrix + pulse
1. Hand-edit statuses in `.archgen/**/tasks.yaml` to cover all six: pending, ready, running, blocked, done, failed. Save.
   - ✅ Within ~0.5s of save: pending gray-muted · ready blue outline · running amber with pulsing ring · blocked yellow dashed/hollow · done green · failed red. No seventh status exists anywhere.
2. Check edges: edge into the running node animates (marching dashes); failed target red stroke; blocked target dashed-static.
   - ✅ Exactly that; with >50 running targets at most 50 edges animate (perf cap).

## 3b. Feature picker (multi-feature repos)
1. Open a workspace with two or more `.archgen/<slug>/` folders (e.g. copy `greenfield-demo` to a second slug).
   - ✅ A feature dropdown appears in the TASKS header listing every slug, most-recently-modified first; the active feature's DAG renders.
2. Switch the dropdown to the other feature.
   - ✅ Board swaps to that slug's graph within the render budget; selection survives closing/reopening VS Code (persisted per workspace); screen reader announces "Select ArchGen feature (currently \<slug\>)".
3. Delete one feature folder and save any remaining file.
   - ✅ Picker drops the vanished slug; if it was active, the board falls back to the most-recent remaining feature.
4. Single-feature workspace.
   - ✅ No picker rendered (zero chrome when there is nothing to choose).

## 4. Keyboard navigation + ARIA
1. Tab into the canvas from the tab bar.
   - ✅ Each task node is reachable in tab order; a visible focus ring (theme focus border color) appears on the focused node only.
2. Focus a node and press Enter, then Space.
   - ✅ Each keypress dispatches the harness for that task (see §6 toast/output); screen reader announces "task \<id\>: \<title\>, status \<status\>".

## 5. Live updates (watcher)
1. With the board visible, change one task's status in tasks.yaml and save.
   - ✅ Only that node flips class (no full-canvas flicker); stale chip resets to "updated 0s ago" and counts up each second.
2. Hide the panel, make 3 rapid saves, re-show it.
   - ✅ One refresh on reveal; final state correct; no duplicated dispatches.

## 6. ▶ Build / Start Work (harness spawn)
1. Set `archgen.scriptsPath` to a dir with stub scripts (`next-tasks.mjs` printing `{"waves":[["TASK_A"]]}`, `set-status.mjs` no-op).
2. Click ▶ on a node; then click **▶ Start Work**.
   - ✅ Node dispatch spawns the configured harness with cwd = workspace root; stdout tail appears in the *ArchGen* output channel; exit 0 → info toast, non-zero → error toast. The extension itself never writes repo files.

## 7. DOCS panel
1. Open DOCS tab; select a markdown file containing two valid mermaid diagrams and one broken.
   - ✅ Two diagrams render as SVG; the broken one becomes an inline error box; rest of doc stays rendered. Raw HTML in the md is escaped (view source via DevTools: no `<img onerror>` element).

## 8. CODE panel
1. Open a workspace with `.codegraph/codegraph.db` (colby) or `graph.db` (optave).
   - ✅ Graph renders; kind filter chips toggle edge families; search narrows nodes; selecting a node dims non-neighbors and shows "<id>: N direct dependents".
2. Open a workspace whose only index is `~/.codegraph/graph.db` (global home).
   - ✅ Explicit unsupported-product banner, no crash, no partial graph.

## 9. CROSS-MODE CHECK (greenfield-demo)
- CLI level (automated): `npm run cross-mode`
  - ✅ Prints `✓ cross-mode parity: 6 nodes, ids [SCAFFOLD/SHARED/API/WEB/DOCS/VERIFY], edges 8, statuses pending×6`.
- Workbench level (deferred manual drive): open `~/Projects/archgen/fixtures/greenfield-demo` as the workspace
  - ✅ TASKS tab renders exactly 6 nodes SCAFFOLD/SHARED/API/WEB/DOCS/VERIFY with the template's depends_on edges (8), all pending. Capture screenshot to evidence.

## 10. Theme adaptation
1. Switch editor theme Dark ↔ Light ↔ High Contrast.
   - ✅ Board recolors live through `--vscode-*` variables; data-theme attribute flips; contrast stays readable; pulse ring uses theme yellow.

## 11. Serializer restore
1. With the board open, run **Developer: Reload Window**.
   - ✅ Board restores automatically (same view state/tab) without rerunning the command.

## 12. CSP hygiene (workbench confirmation)
1. Help → Toggle Developer Tools → Console; walk all tabs, flip statuses, render docs.
   - ✅ Zero "Content Security Policy" violation reports (jsdom-level zero-violation assertion lives in `test/polish-perf.test.tsx`).

## 13. VSIX install into clean profile
1. `npm run package` (plain `vsce package`; `--no-dependencies` would drop the externalized better-sqlite3 binding — see package.json `//` note) → `archgen-extension-0.1.0.vsix`.
2. `code --extensions-dir /tmp/clean-ext --user-data-dir /tmp/clean-data --install-extension archgen-extension-0.1.0.vsix`, then launch with those dirs.
   - ✅ Extension installs and activates; codegraph read works (better-sqlite3 prebuild loads, or node:sqlite fallback on Electron ≥ 33).
