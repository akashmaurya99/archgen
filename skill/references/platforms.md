# Platform capability matrix (August 2026)

Facts verified against official vendor docs; cells marked UNVERIFIED could not be
confirmed. The orchestrator loads ONLY the row matching Step-0 detection.

## Skill install paths

| Platform | Project path | Global path | Notes |
|---|---|---|---|
| Claude Code | `.claude/skills/<name>/` | `~/.claude/skills/<name>/` | Plugin marketplace: `/plugin install x@mkt`; skills hot-reload |
| OpenCode | `.opencode/skills/` (+ reads `.claude/`, `.agents/`) | `~/.config/opencode/skills/` (+ `~/.claude/`, `~/.agents/`) | Walks up to git root |
| Cursor | `.agents/skills/`, `.cursor/skills/` | `~/.agents/skills/`, `~/.cursor/skills/` | ≥2.4 native; also scans `.claude/`, `.codex/`; nesting OK |
| Windsurf | `.windsurf/skills/` | `~/.codeium/windsurf/skills/` | Enterprise system paths also read |
| VS Code + Copilot | `.github/skills/` (+ `.claude/`, `.agents/`) | `~/.copilot/skills/` (+ `~/.claude/`, `~/.agents/`) | Extra dirs via chat.agentSkillsLocations |
| Codex CLI | `.agents/skills/` (crawls up to repo root) | `~/.agents/skills/` (legacy `~/.codex/skills/`) | `$skill-installer` built in |
| Gemini CLI | `.gemini/skills/` or `.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` | `gemini skills install <git-url> --consent` |
| Antigravity | `<ws>/.agents/skills/` | `~/.gemini/config/skills/` | Backward-supports `.agent/skills`; name frontmatter OPTIONAL here |
| Zed | `<project>/.agents/skills/` ONLY | `~/.agents/skills/` ONLY | FLAT layout — no nesting; worktree-trust gate on project skills |
| Kiro | `.kiro/skills/` | `~/.kiro/skills/` | Custom agents need explicit `resources: ["skill://.kiro/skills/**/SKILL.md"]` |
| Trae | `.trae/skills/` (opt-in `.agents/`) | `~/.trae/skills/` | `.trae` wins collisions; CN variant separate |
| Claude Desktop | — (account-scoped) | GUI ZIP upload only | Scripts run sandboxed, NOT local shell |

Universal fallback: `.agents/skills/` project + `~/.agents/skills/` user works
across most harnesses. Primary distribution: `npx skills add <repo>` (75+ agents).

## archgen installed layout

`install.sh` / `npx archgen-skill install` maintain ONE canonical store plus
thin bridges — the skill is never copied twice:

| Path | Role |
|---|---|
| `.agents/skills/archgen/` | Canonical store — `SKILL.md`, `scripts/`, `references/`, `assets/` |
| `.claude/skills/archgen` | Optional symlink → canonical store, for Claude Code discovery |
| `CLAUDE.md` | One-line `@AGENTS.md` bridge only — no content of its own |
| `AGENTS.md` | The hub every harness reads; hosts the features registry between `<!-- archgen:features:start -->` and `<!-- archgen:features:end -->` |

The registry table (`| Feature | Status | Updated |`, one row per
`.archgen/<slug>/`) is machine-maintained by `scripts/update-agents.mjs` after
every generate/plan/wave run — never hand-edit it; edit `.archgen/` state and
re-run the script instead.

## MCP configuration

Four different top-level keys exist — NEVER assume `mcpServers`:

| Platform | File(s) | Key | stdio fields | Remote URL field | CLI add? |
|---|---|---|---|---|---|
| Claude Code | `.mcp.json` (project) / `~/.claude.json` (local/user) | `mcpServers` | command,args[,env] type:"stdio" | `url`+headers type:"http"/"sse" | `claude mcp add --scope project\|local\|user --transport stdio\|http\|sse` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\` (Win) / `~/.config/Claude/` (Linux) | `mcpServers` | command,args,env | UI Connectors preferred; file `url` UNVERIFIED | none |
| OpenCode | `opencode.json(c)` / `~/.config/opencode/opencode.json(c)` | **`mcp`** | type:"local", **command:[array]**, environment{} | type:"remote", `url`, headers | `opencode mcp add` (interactive only) |
| Cursor | `.cursor/mcp.json` / `~/.cursor/mcp.json` | `mcpServers` | command,args,env,cwd | `url`+headers (`${env:VAR}` interp.) | none (deep-links UNVERIFIED) |
| VS Code Copilot | `.vscode/mcp.json` / profile mcp.json / portable `.mcp.json` | **`servers`** (+inputs[]) | type:"stdio",command,args,env | type:"http"/"sse", url, headers | `copilot mcp add`; palette "MCP: Add Server" |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (global only) | `mcpServers` | command,args,env | **`serverUrl`** OR `url` + headers | none (Marketplace UI/deeplink) |
| Codex CLI | `~/.codex/config.toml` / project `.codex/config.toml` (trust-gated) | `[mcp_servers.<id>]` TOML | command,args,env,cwd | `url`, bearer_token_env_var, http_headers | `codex mcp add <n> --url \| -- cmd args` |
| Gemini CLI | `~/.gemini/settings.json` / `.gemini/settings.json` | `mcpServers` | command,args,env,cwd,trust | `httpUrl`(HTTP)/`url`(SSE)+headers | `gemini mcp add -s user\|project -t stdio\|sse\|http` |
| Antigravity | `~/.gemini/config/mcp_config.json` / `.agents/mcp_config.json` | `mcpServers` | command,args,env,cwd | **`serverUrl` MANDATORY — `url` rejected** + headers/oauth | none (`/mcp` overlay manager) |
| Zed | `~/.config/zed/settings.json` / `.zed/settings.json` | **`context_servers`** | command,args,env | `url`+headers (OAuth auto-prompt) | none (Settings UI writes file) |
| Kiro | `.kiro/settings/mcp.json` / `~/.kiro/settings/mcp.json` | `mcpServers` | command,args,env,disabled,autoApprove | `url`+headers+oauth | `/mcp add` (CLI session) |
| Trae IDE | `.trae/mcp.json` | `mcpServers` | command,args,env | url + type:"sse"/"http" | none (UI manual add) |

Restart semantics: full restart needed = Claude Desktop, Windsurf, Zed.
Hot-reload = Kiro, Gemini, Codex. Approval prompt on first detection =
Claude Code project-scope servers.

## Sub-agent dispatch capability

| Harness | Native mechanism | Parallel background | Isolation for parallel edits |
|---|---|---|---|
| Claude Code | `Agent` tool + subagent_type; `.claude/agents/*.md` | Yes (default since v2.1.198; cap ~20) | BEST: `isolation: worktree` frontmatter; `/batch` |
| OpenCode | task/subagent tool + subagent_type | Yes (fg + background) | None in core → use file-ownership discipline or team-mode plugin worktrees |
| Codex CLI | model-mediated `spawn_agent`; max_depth=1 | Yes but children can't nest | None → prefer top-level parallel `codex exec` + manual git worktrees |
| Gemini CLI | subagents-as-tools; `@agent-name` | Yes BUT strictly hub-and-spoke (no nested calls) | None → restrict parallel workers to read-only roles unless given external worktrees |
| Cursor | Subagents w/ `is_background` frontmatter; `/multitask` | Yes | Opt-in per-subagent worktree or cloud VM |
| Antigravity | `invoke_subagent` (async by design); `/fork` | Yes | `/fork` workspace separation; per-subagent worktrees UNVERIFIED |

## Headless invocation templates (fallback workers)

```
claude    claude -p "<prompt>" --output-format json --permission-mode acceptEdits
opencode  opencode run "<prompt>" --auto --format json
codex     codex exec --sandbox workspace-write --json -o <out-file> "<prompt>"
gemini    gemini --output-format json "<prompt>"
agy       agy -p --output-format json --print-timeout 15m "<prompt>"
```

Completion signal = process exit (Claude documents 0/non-zero contract).
NEVER pass secrets as arguments. Feature-detect old binaries via `--version`.

## Unknown platform procedure

1. WEB SEARCH: `<platform> official docs MCP configuration` and
   `<platform> agent skills install path`.
2. Prefer official vendor domains over blog posts; note the date of sources.
3. Present findings + proposed config diff to the user. [approval gate]
4. Apply, verify, and offer to append findings to this table upstream.
