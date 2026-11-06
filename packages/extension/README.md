# ArchGen

**Read-only visualization of your `.archgen/` folder: live task DAG, code dependency graph, and rendered docs.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/akashmaurya99/archgen/blob/main/LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.90-239cd0)](https://code.visualstudio.com)

ArchGen renders the plans produced by the [archgen](https://github.com/akashmaurya99/archgen)
skill — an architecture contract plus a dependency-ordered task graph — as live,
interactive views in your editor. Watch tasks move through the pipeline, inspect
your code's real dependencies, read the docs, and hand work to any coding agent
with one click.

## Privacy & guarantees

ArchGen is a **window** over your repository:

- **Never edits your artifacts.** It reads `.archgen/` files and your codegraph index; all plan, task and code writes are done by your agent. Uninstalling loses nothing.
- **Writes only its own runtime state.** It creates `.archgen/.runtime/` — a heartbeat (`bridge.json`) and per-command acknowledgements (`ack/<id>.json`) — which is how the archgen MCP server knows the extension is alive and whether a UI command took effect. Nothing else in your workspace is touched.
- **No telemetry.** No data leaves your machine.
- **No LLM calls.** The extension contains no agent runtime — it composes prompts and hands them to the agent you already use.
- Codegraph indexes are opened read-only.

## Features

| View | What you get |
| --- | --- |
| **TASKS** | The task board drawn as a dependency DAG: running tasks pulse, done is green, failed is red; minimap, legend, and zoom controls. |
| **CODE** | Your code's real dependencies, read from the codegraph SQLite index — search, edge-kind filters, impact highlighting. |
| **DOCS** | Rendered architecture docs with mermaid diagrams and click-through to source. |
| **▶ Build / Start Work** | Copies the composed prompt to your clipboard for any agent chat, with best-effort pre-fill of the native chat input. Optional headless CLI dispatch via `archgen.delivery.mode`. |

Also included: a feature picker for repos with multiple `.archgen/<slug>/`
features, live updates as files change, and keyboard navigation (Tab to a task,
Enter/Space to build it).

### Agent-driven UI

The archgen MCP server can drive this extension. When an agent calls
`archgen_ui`, the board reacts in real time:

| Action | Effect |
| --- | --- |
| `reveal_task` | focuses the board on one task node |
| `select_feature` | switches the board to another `.archgen/<slug>/` feature |
| `open_doc` | opens a document in the DOCS tab |
| `focus` | brings a view (board / tasks / docs / codegraph) forward |
| `refresh` | forces a model re-push |

The channel is a filesystem command queue under `.archgen/.runtime/` — the
extension advertises what it can do in `bridge.json` and answers each command
with an acknowledgement. Commands are allowlisted, scoped to this workspace,
expire after five seconds, and are safe to replay. If the extension is closed,
the tool reports `available: false` — the agent's work continues unaffected.

## Installation

- **VS Code Marketplace** — search for "ArchGen" (publisher `archgen`) in the Extensions view and install.
- **From a `.vsix`** — download the latest release from [GitHub Releases](https://github.com/akashmaurya99/archgen/releases), then run *Extensions: Install from VSIX…*

## Usage

1. Open the **ArchGen** activity-bar icon (or run *ArchGen: Open Task Board*). The activity bar shows glanceable progress, status-grouped tasks, and quick-open docs.
2. Switch between the **TASKS**, **CODE**, and **DOCS** tabs on the board.
3. Click ▶ on any task to copy its build prompt, or ▶ **Start Work** for the full execution prompt — then paste it into your agent chat.

## Requirements

- VS Code ≥ 1.90 (or a fork — see below).
- A `.archgen/` folder produced by the archgen skill (`npx archgen-skill init`, then generate an architecture).
- For the CODE view: a codegraph SQLite index in the workspace — `.codegraph/codegraph.db` (colby) or `.codegraph/graph.db` (optave). Other codegraph products are not read; the CODE tab shows an explicit unsupported banner instead.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `archgen.harness.default` | `claude` | Agent harness invoked by the ▶ build button: `claude` \| `opencode` \| `codex` \| `gemini` \| `custom`. |
| `archgen.harness.templates` | built-in templates | Command template per harness. Placeholders: `{{prompt}}`, `{{task}}`, `{{outfile}}`. |
| `archgen.skillPath` | *(empty)* | Explicit path to the installed archgen **skill** directory. When empty, probed in order: `<workspace>/.agents/skills/archgen`, `<workspace>/.claude/skills/archgen`, `<workspace>/skills/archgen`, `~/.agents/skills/archgen`, `~/.claude/skills/archgen`. The skill ships no code — the MCP server (`archgen-mcp`) owns every capability. |
| `archgen.delivery.mode` | `clipboard` | How ▶ delivers work: `clipboard` copies the composed prompt to paste into any agent chat (works everywhere); `spawn` runs the headless CLI harness and requires a [trusted workspace](https://code.visualstudio.com/api/extension-guides/workspace-trust) — it is refused with a warning otherwise. |
| `archgen.delivery.autoFillChat` | `true` | After copying, best-effort pre-fill of the IDE's native chat input (ignored where unsupported). |

`spawn` mode dispatches the harness templates, e.g.:

```jsonc
"archgen.harness.templates": {
  "claude":   "claude -p \"{{prompt}}\" --output-format json --permission-mode acceptEdits",
  "opencode": "opencode run \"{{prompt}}\" --auto --format json",
  "codex":    "codex exec --sandbox workspace-write --json -o \"{{outfile}}\" \"{{prompt}}\"",
  "gemini":   "gemini --output-format json \"{{prompt}}\""
}
```

## Supported editors

VS Code ≥ 1.90, Cursor, Windsurf, and VSCodium — the extension targets only
stable webview APIs, so it behaves the same in each.

## License

[MIT](https://github.com/akashmaurya99/archgen/blob/main/LICENSE) © ArchGen contributors
