# Platform capability matrix (November 2026)

Facts verified against official vendor docs (2026-11); cells marked UNVERIFIED could
not be confirmed. The capability DATA is served by
`archgen_setup{action:'harness_info'}` — this file keeps the narrative.

## Harness capabilities

**The capability data is a tool output — never read a table for it:**

```
archgen_setup { action: 'harness_info' }              # detect + return the row
archgen_setup { action: 'harness_info', harness: 'claude' }   # one harness
```

It returns, per harness: the skill install paths (project + global), the MCP
config file + top-level key + entry shape, the MCP CLI, the restart semantics and
the sub-agent dispatch capability (mechanism, parallelism, isolation). The
canonical data is `packages/mcp/assets/platform-capabilities.json` — the tool
serves it, so it can never drift from reality.

## Platform detection

Probe in order (the same order the tool uses):

`.claude/` (Claude Code) · `.cursor/` (Cursor) · `.windsurf/` (Windsurf) ·
`.opencode|opencode.json` (OpenCode) · `.github/copilot-instructions.md`
(Copilot) · `~/.codex` (Codex) · `.gemini/` (Gemini CLI/Antigravity) ·
`.kiro/` (Kiro) · `.trae/` (Trae).

First match wins. `archgen_setup{action:'harness_info'}` does the same detection
and returns the row — prefer it over probing by hand.

## archgen installed layout

`install.sh` / `npx archgen-skill install` maintain ONE canonical store plus
thin bridges — the skill is never copied twice:

| Path | Role |
|---|---|
| `.agents/skills/archgen/` | Canonical store — `SKILL.md` + `references/code-standards.md` (guidance only; the MCP server owns every capability) |
| `.claude/skills/archgen` | Optional symlink → canonical store, for Claude Code discovery |
| `CLAUDE.md` | One-line `@AGENTS.md` bridge only — no content of its own |
| `AGENTS.md` | The hub every harness reads; hosts the features registry between `<!-- archgen:features:start -->` and `<!-- archgen:features:end -->` |

The registry table (`| Feature | Status | Updated |`, one row per
`.archgen/<slug>/`) is machine-maintained by `archgen_registry{action:'update'}` after
every generate/plan/wave run — never hand-edit it; edit `.archgen/` state and
re-run the tool instead.

## MCP configuration

**The per-platform shapes are a tool output:** `archgen_setup{action:'harness_info'}`
returns each harness's config file, top-level key and entry shape.

Four different top-level keys exist — NEVER assume `mcpServers`:
`mcpServers` (claude, cursor, windsurf, gemini, antigravity, kiro, trae) ·
`servers` (vscode/copilot) · `mcp` (opencode) · `context_servers` (zed). Codex
CLI uses TOML (`[mcp_servers.<id>]`).

Remote URL fields vary per platform (`url` vs `serverUrl` vs `httpUrl`); the tool
reports the exact field. Uncertainty triggers a web-search of the current
official docs, never invention.

**Wiring is a tool call:** `archgen_setup{action:'install_mcp', approve:true}`.
Never hand-edit a harness config.

## Sub-agent dispatch capability

**Also a tool output:** `archgen_setup{action:'harness_info'}` returns the
dispatch mechanism, whether it parallelises, its limits and its isolation story.
Use it before dispatching — the fallback (self-execute) and the isolation advice
depend on it.

## Unknown platform procedure

1. WEB SEARCH: `<platform> official docs MCP configuration` and
   `<platform> agent skills install path`.
2. Prefer official vendor domains over blog posts; note the date of sources.
3. Present findings + proposed config diff to the user. [approval gate]
4. Apply, verify, and offer to append findings to this table upstream.

## Codegraph indexing scope

Current mainstream codegraph indexers extract SOURCE symbols only
(functions/classes/imports) — they do not index markdown headings, and YAML
support ranges from absent to file-level config tracking; none can graph
tasks.yaml dependencies. Generic code indexers verifiably do not extract
markdown headings or YAML task semantics, so archgen ships its own
deterministic graph tools:

- Source navigation → codegraph MCP (built automatically by Step 0 / the
  the `archgen_codegraph` bootstrap flow).
- YAML plan graphs → exclusively `archgen_plan{action:'graph'}`.
- Markdown artifact navigation → `archgen_docs`.

If the harness exposes a markdown-heading indexer (e.g. a
`codegraph_index_markdown`-style tool), prefer it for general repo docs but
still use `archgen_docs` inside `.archgen/` — it understands TASK/FR
reference semantics. Brownfield surveys prefer codegraph once present.

### Codegraph bootstrap (official CLI, no command list here)

CodeGraph = `@colbymchenry/codegraph` (npm), CLI `codegraph`, MIT, local-first,
self-contained runtime. It persists a SQLite symbol graph in `.codegraph/`,
serves it over MCP, and indexes SOURCE symbols only (scope above) — pair with
`archgen_docs` / `archgen_plan{action:'graph'}` for markdown/YAML.

**No version is pinned:** the bootstrap always takes the latest published
release and refreshes it in place. The MCP server exposes its own tool set to
the agent, so the skill does not restate the CLI's command surface — read it
from the installed CLI (`codegraph help`) or the MCP tools themselves.

> **Entry point — the `archgen_codegraph` tool.** It installs the CLI **if it
> is missing** (an installed CodeGraph is the user's to manage and is never
> upgraded behind their back), wires every DETECTED harness with the correct
> per-platform shape, and builds the project index — idempotently, with an
> approval gate before any config write. It drives the official CLI; it never
> reimplements it.
> ```
> archgen_codegraph { action: 'ensure' }   # install if missing + wire + index
> archgen_codegraph { action: 'status' }   # what is installed/wired/indexed
> ```

**Rules that matter to the agent:**
- The index is built ONCE per project; the MCP server's watcher keeps it live,
  so **never re-index** — no manual index/sync steps after the bootstrap.
- MCP configs are written only with `approve: true`; the tool returns its plan
  otherwise. A config that is not valid JSON (e.g. JSONC) is reported, never
  rewritten. Harnesses that are not installed are never touched.
- Only DETECTED harnesses get an entry. The per-platform file path, top-level
  key (`mcpServers` / `servers` / `mcp` / `context_servers`) and server entry
  live in `packages/mcp/assets/harness-mcp.json` — one source of truth.
- **Telemetry — disclose it, never claim "100% local":** it is enabled by
  default on a fresh install and reports a machine ID (`~/.codegraph/`), and the
  tool changes it only with an explicit `telemetry: 'off' | 'on'`.

Agent flow (Step 0): detect `.codegraph/` at the repo root.
- **Absent** → `archgen_codegraph{action:'ensure'}` once
  per project (standing approval from the user's install-time consent; show the
  printed plan). On decline → grep/Glob.
- **Present** → use the CodeGraph MCP tools for navigation. Never re-index.
