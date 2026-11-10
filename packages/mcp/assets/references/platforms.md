# Platform detection, install layout, MCP schemas

Authoritative capability data is served by `archgen_setup{action:'harness_info'}` from `packages/mcp/assets/platform-capabilities.json`—never restate it here.

```
archgen_setup { action: 'harness_info' }                    # auto-detect
archgen_setup { action: 'harness_info', harness: 'claude' } # specific harness
```

Returns: project/global skill paths, MCP config path and top-level key, server entry schema, CLI commands, restart semantics, and sub-agent mechanics (tool, parallelism, isolation).

## Platform detection

`archgen_setup{action:'harness_info'}` is the **only** source of detection order and harness capabilities — `packages/mcp/assets/platform-capabilities.json` is the authority, and this file never restates it. A harness this server does not know is a normal situation, not an error: use the **Unknown platform** procedure below.

## Installed layout

`npx archgen-skill install` maintains one canonical store plus lightweight bridges:

| Path | Role |
|---|---|
| `.agents/skills/archgen/` | Canonical store: `SKILL.md` + `references/code-standards.md` |
| `.claude/skills/archgen` | Optional symlink → canonical store for Claude Code discovery |
| `CLAUDE.md` | Single-line `@AGENTS.md` pointer |
| `AGENTS.md` | Cross-harness hub hosting the feature registry between `<!-- archgen:features:start -->` and `<!-- archgen:features:end -->` |

Never hand-edit the registry table (`| Feature | Status | Updated |`); use `archgen_registry{action:'update'}`.

## MCP configuration

`archgen_setup{action:'harness_info'}` is the **runtime** authority: it returns the exact config path, the URL field and the restart semantics for the harness you are on. This file documents the **key vocabulary** once, so you can read a config file by eye — `harness_info` confirms which one applies.

- **Top-level keys:** `mcpServers` (Claude Code, Cursor, Windsurf, Gemini CLI, Antigravity, Kiro, Trae) · `servers` (VS Code `.vscode/mcp.json`) · `mcp.servers.<id>` (OpenCode — nested, never flat `mcp.<id>`) · `context_servers` (Zed) · `[mcp_servers.<id>]` (Codex TOML).
- **Remote URL keys vary:** `url`, `serverUrl`, or `httpUrl` — check `harness_info`.
- **VS Code reads two formats.** `.vscode/mcp.json` uses `servers`; the portable `mcp-config.json` uses `mcpServers` and lives at `$COPILOT_HOME/mcp-config.json` (or `~/.copilot/mcp-config.json`). `COPILOT_HOME` replaces the default. Global wiring uses the portable format so VS Code stable/Insiders, the Copilot CLI, and every workspace see one server.
- **Automated wiring:** `archgen_setup{action:'install_mcp', approve:true}`—do not hand-edit.

## Sub-agent dispatch

Inspect `harness_info` before wave execution for the native tool, parallelism limit, worktree isolation, or sequential fallback.

## Unknown platform

1. **Web search:** `<platform> official docs MCP configuration` and `<platform> agent skills install path`; prefer vendor docs, note publication dates.
2. **Propose:** present paths and the exact config diff. `[approval gate]`
3. **Apply & verify:** write approved config, verify tool visibility, offer to upstream the platform definition.

## CodeGraph indexing scope

Indexers parse **source symbols only** (functions, classes, imports)—never Markdown headings or YAML dependencies. Use the right tool:

- **Source navigation:** CodeGraph MCP tools (`.codegraph/`).
- **Task dependency graphs:** `archgen_plan{action:'graph'}`.
- **`.archgen/` Markdown navigation + FR/TASK link validation:** `archgen_docs`.

### CodeGraph bootstrap

CodeGraph (`@colbymchenry/codegraph`, MIT) keeps a local SQLite symbol graph in `.codegraph/` and serves it via MCP.

```
archgen_codegraph { action: 'ensure', approve: true } # install CLI if missing + wire harnesses + index
archgen_codegraph { action: 'status' } # install, wiring, index state
```

- **Index once:** built during bootstrap, kept live by the MCP file watcher—**never re-index manually**.
- **Safe config writes:** `approve: true` is required for every write — the CLI install, the harness config entries, and the telemetry setting. Without it the call returns the PLAN and writes nothing.
- **Telemetry:** CodeGraph enables anonymous machine-ID telemetry (`~/.codegraph/`) by default; disclose it accurately (never "100% offline/no telemetry") and pass `telemetry: 'off' | 'on'` only when requested — and only alongside `approve: true`, because it is a machine-wide setting.
- **Step 0:** `.codegraph/` present → use it. Absent → `archgen_codegraph{action:'ensure', approve:true}` once per project (grep/glob fallback if declined).
