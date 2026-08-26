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
> Legacy path — requires `archgen.delivery.mode` = `"spawn"` (see §14 for the default clipboard flow).
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

## 14. Clipboard delivery (default mode)
1. Fresh profile, defaults (`archgen.delivery.mode` = `clipboard`). Click ▶ on a task node.
   - ✅ No process spawns. Toast appears: *Prompt copied — paste into your agent chat and send*. Board chip shows `Copied '<id>' prompt to clipboard.`; *ArchGen* output channel logs `[delivery] intent=buildTask chars=<n>`.
2. Paste into an agent chat input (Copilot Chat / Cursor chat / any box).
   - ✅ Text is exactly `Implement task <id>: <title>. Follow the .archgen plan; only touch files you own.` — identical to what spawn mode would inject.
3. Pick **Open Chat** on VS Code with Copilot Chat signed in.
   - ✅ Native chat opens with the prompt pre-filled but NOT auto-sent. On hosts without the API: no error surfaces; channel logs `[delivery] openChat unavailable`.
4. Pick **Copy Again**.
   - ✅ Clipboard rewritten with the same prompt.
5. Set `archgen.delivery.autoFillChat` = `false`; click ▶ then **Open Chat**.
   - ✅ Only chat-input focus is attempted; no text enters the chat.
6. With the skill installed (`.agents/skills/archgen/` present), click **▶ Start Work**.
   - ✅ Clipboard receives ONE short trigger line: `Start work on <slug>.`
7. Temporarily rename `.agents/` so probes fail; click **▶ Start Work** again.
   - ✅ Clipboard receives the self-contained brief: references `.archgen/<slug>/tasks.yaml`, file_ownership globs, status updates, wave continuation — no scripts-dir path mentioned. Restore `.agents/`.
8. Set `archgen.delivery.mode` = `"spawn"` and repeat steps 1–2 of §6.
   - ✅ Byte-for-byte legacy behavior: headless spawn per task, exit-code toasts, zero clipboard writes.

## 15. Setup UX (skill missing · plan missing · outdated skill)
Setup opens as a CENTERED DIALOG inside the Task Board (⚙ button beside the ⋯ menu, ⋯ → **Setup & updates**, status-bar item, notifications) — there is no SETUP tab and no separate setup window anywhere.
1. Open a fresh workspace with **no** `.agents/skills/archgen` and **no** `.archgen/` (extension must activate via *onStartupFinished* even though `workspaceContains:.archgen` is false).
   - ✅ One info toast appears exactly once: *ArchGen skill not found in this workspace…* with **Fix now** / **Do not show again**. Status bar shows `$(cloud-download) ArchGen: install skill` (hidden when no action pending). Reloading the window does NOT repeat the toast (signature-keyed dismissal persists in workspaceState).
2. Click the status-bar item or run **ArchGen: Open Setup**.
   - ✅ The Task Board opens with the setup DIALOG centered over it: summary rows with ✓/⚠ glyphs (Skill not found · Plan not initialized · Up to date —) and an install card with **Copy prompt for my agent** plus the manual route `npx archgen-skill init` with its own Copy pill. Escape, the ✕ button, or a backdrop click closes the dialog.
3. Click **Copy prompt for my agent**, paste into any agent chat.
   - ✅ Clipboard holds the multi-line install prompt (`npx archgen-skill init`, verify SKILL.md, then GENERATE flow incl. both gates).
4. In an EMPTY workspace, run `npx archgen-skill init` from a terminal WITHOUT touching the extension (board closed or open, either way).
   - ✅ Within ~a second of the scaffold landing, state flips everywhere: the root-entry watcher on `{.archgen,.agents,.claude}` fires immediately (their parent — the workspace root — always exists), evaluateSetupNow probes the filesystem directly, and ONE trailing re-eval ~600ms after the last scaffold event absorbs files written during `mkdir -p` chains. Status-bar item switches to `$(add) … initialize plan`; reopening the setup dialog shows installed v0.0.4+ (install/update cards only — kickoff lives solely in the TASKS empty state and the notification action); output channel logs `[watch] scaffold root changed` and eventually `[setup] resolved`.
5. Keep the setup dialog open and run `npx archgen-skill update` (or touch files inside `.agents/skills/archgen/`).
   - ✅ Deep-glob watchers keep intra-tree content changes flowing: the update card disappears once the stamp reaches the extension version — no reload, no focus change needed.
6. Worst-case convergence: alt-tab AWAY, run `npx archgen-skill init` in an EXTERNAL terminal (pretend every watcher event was lost), alt-tab back.
   - ✅ The window-focus reconcile (min interval ~3s) runs BOTH the setup probe and a forced board-model push: setup truth and the TASKS board converge with zero delivered watch events.
7. With skill present but no `.archgen/`: trigger the proactive toast (fresh signature or cleared dismissal) and click **Initialize…**.
   - ✅ InputBox asks for a one-line idea (cancel-safe; empty ⇒ generic kickoff prompt). Composed kickoff lands on the clipboard referencing `.agents/skills/archgen/SKILL.md`, the idea, and GENERATE-mode gates. The setup dialog itself shows NO plan card — its summary rows still report the missing plan truthfully.
8. Simulate legacy/outdated skill: remove `.archgen-version` from the skill root (or write `9.9.9` then restore an older value); reload.
   - ✅ Toast variant mentions the old version (or unknown legacy) and everything still works — plan/board features unaffected (update = recommended, never blocking). The update card shows the version-aware body (*The installed skill predates version stamping…* for legacy, *Installed skill vX is older than this extension (vY)* otherwise), the reassurance line "Everything keeps working on older versions — updating is recommended.", and manual route `npx archgen-skill update`.
9. Stamp newer than the extension (`9.9.9`).
   - ✅ No warning anywhere; up-to-date row reads ✓ yes; with every action resolved the setup dialog renders the compact "ArchGen is set up." row instead of cards.
10. Dismiss a toast with **Do not show again**; reload.
    - ✅ That action+version signature never toasts again (persisted in workspaceState); the setup dialog remains reachable via the ⚙ button / status bar / command and keeps showing live truth.
11. Late-open proof: complete `npx archgen-skill init` in a workspace where the Task Board has NEVER been opened (or close the board tab first), then open the board and click **⚙**.
    - ✅ Without any focus change or reload, the TASKS empty state shows the ready variant (**Ready to build.** + **Copy kickoff prompt**) and the setup dialog opens already state-aware — the board replays the setup snapshot during its ready handshake.
12. In that ready empty state, click **Copy kickoff prompt**.
    - ✅ A centered modal opens INSIDE the Task Board itself (no top-center native quick-input jump): title *Describe your idea*, one-line input auto-focused, hint *(optional — empty gives you a generic interview kickoff)*. Type an idea (or leave blank) and press Enter or **Copy prompt** → clipboard receives the composed kickoff referencing `.agents/skills/archgen/SKILL.md` and GENERATE-mode gates (verifier + approval). **Cancel**, Escape, or clicking the backdrop closes silently with no clipboard write. Non-board entry points (the notification's *Initialize…* action) keep the native InputBox.
13. From the sidebar's DOCS tree, click any document row (board closed or already open — try both).
    - ✅ The Task Board opens (or comes forward) on the DOCS tab with THAT document rendered; with the board already open the switch happens immediately. A cold board replays the request after its ready handshake, so the document never posts into an unmounted webview.
14. From ANY board state (empty workspace included), click the **⚙** button beside the **⋯** menu at the right edge of the tab strip — or choose **⋯ → Setup & updates**.
    - ✅ The centered setup dialog opens (and the menu closes); **Copy install prompt** copies without leaving the current view; clicking elsewhere dismisses the menu. With no folder open, entry points show *Open a folder to use ArchGen.* instead of doing nothing.
