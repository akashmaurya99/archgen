# Platform capability matrix (November 2026)

Authoritative platform capability data is served dynamically by `archgen_setup{action:'harness_info'}` from `packages/mcp/assets/platform-capabilities.json`.

## Harness capabilities

Query platform capabilities directly via the tool rather than static tables:
```
archgen_setup { action: 'harness_info' }                   # auto-detect current harness
archgen_setup { action: 'harness_info', harness: 'claude' } # query specific harness
```
Returns: project & global skill paths, MCP config path, top-level JSON/TOML key, server entry schema, CLI commands, restart semantics, and sub-agent dispatch mechanics (tool name, parallelism, isolation).

## Platform detection

`archgen_setup{action:'harness_info'}` probes in this priority order (first match wins):
`.claude/` (Claude Code) $\rightarrow$ `.cursor/` (Cursor) $\rightarrow$ `.windsurf/` (Windsurf) $\rightarrow$ `.opencode` / `opencode.json` (OpenCode) $\rightarrow$ `.github/copilot-instructions.md` (Copilot) $\rightarrow$ `~/.codex` (Codex) $\rightarrow$ `.gemini/` (Gemini CLI / Antigravity) $\rightarrow$ `.kiro/` (Kiro) $\rightarrow$ `.trae/` (Trae).

## archgen installed layout

`npx archgen-skill install` maintains a single canonical store with lightweight bridges:

| Path | Role |
|---|---|
| `.agents/skills/archgen/` | Canonical store: `SKILL.md` + `references/code-standards.md` |
| `.claude/skills/archgen` | Optional symlink $\rightarrow$ canonical store for Claude Code discovery |
| `CLAUDE.md` | Single-line `@AGENTS.md` pointer |
| `AGENTS.md` | Cross-harness hub hosting the feature registry between `<!-- archgen:features:start -->` and `<!-- archgen:features:end -->` |

Never hand-edit the `AGENTS.md` registry table (`| Feature | Status | Updated |`); update it exclusively via `archgen_registry{action:'update'}`.

## MCP configuration

Query `archgen_setup{action:'harness_info'}` for exact per-platform MCP schemas:
- **Top-level keys vary:**
  - `mcpServers`: Claude Code, Cursor, Windsurf, Gemini CLI, Antigravity, Kiro, Trae
  - `servers`: VS Code (the `.vscode/mcp.json` workspace format)
  - `mcp.servers.<id>`: OpenCode (nested under `mcp.servers`, never flat `mcp.<id>`)
  - `context_servers`: Zed
  - `[mcp_servers.<id>]`: Codex CLI (TOML)
- **VS Code reads TWO formats.** The VS Code format is `servers` in
  `.vscode/mcp.json`; the PORTABLE format is `mcpServers` in the Copilot
  user's `mcp-config.json` — `$COPILOT_HOME/mcp-config.json`, or
  `~/.copilot/mcp-config.json`. Copilot harness sessions read the portable
  format directly, and `COPILOT_HOME` REPLACES the default (VS Code checks
  only one of the two). The global wiring therefore goes to the Copilot home
  in the portable format, so VS Code stable, VS Code Insiders, the Copilot
  CLI and every workspace see the same server.
- **Remote URL keys vary:** `url` vs `serverUrl` vs `httpUrl` (check `harness_info`).
- **Automated wiring:** Use `archgen_setup{action:'install_mcp', approve:true}` rather than hand-editing config files.

## Sub-agent dispatch capability

Always inspect `archgen_setup{action:'harness_info'}` before wave execution to determine the native sub-agent tool, parallel execution limits, worktree isolation requirements, or whether to fall back to sequential main-agent execution.

## Unknown platform procedure

1. **Web search:** `<platform> official docs MCP configuration` and `<platform> agent skills install path` (prioritize official vendor docs; note publication dates).
2. **Propose:** Present discovered paths and exact config diff to the user. `[approval gate]`
3. **Apply & verify:** Write approved config, verify tool availability, and offer to upstream the platform definition.

## Codegraph indexing scope

Mainstream codegraph indexers parse **source-code symbols only** (functions, classes, imports)—never Markdown headings or YAML task dependencies. Use the dedicated tool for each artifact class:
- **Source code navigation:** CodeGraph MCP tools (`.codegraph/`).
- **YAML task dependency graphs:** `archgen_plan{action:'graph'}`.
- **`.archgen/` Markdown navigation & FR/TASK link validation:** `archgen_docs`.

### Codegraph bootstrap (official CLI, no command list here)

CodeGraph (`@colbymchenry/codegraph`, MIT) maintains a local SQLite symbol graph in `.codegraph/` and serves it via MCP.
- **Entry point:**
  ```
  archgen_codegraph { action: 'ensure' } # install CLI if missing + wire detected harnesses + index
  archgen_codegraph { action: 'status' } # check install, wiring, and index state
  ```
- **Operational rules:**
  - **Index once:** Built during bootstrap and kept live by the MCP file watcher—**never re-index manually**.
  - **Safe config writes:** Non-bootstrap config edits require `approve: true`, touch only detected harnesses (`packages/mcp/assets/harness-mcp.json`), and never overwrite invalid JSON/JSONC or upgrade an existing user-installed CLI.
  - **Telemetry disclosure:** CodeGraph enables anonymous machine-ID telemetry (`~/.codegraph/`) by default; disclose this accurately (never claim "100% offline/no telemetry") and pass `telemetry: 'off' | 'on'` only when requested.
- **Step 0 flow:** If `.codegraph/` is present, use CodeGraph MCP tools. If absent, run `archgen_codegraph{action:'ensure'}` once per project (fallback to grep/glob if declined).
