# Platform detection, install layout, MCP schemas

Authoritative capability data is served by `archgen_platform` from `packages/mcp/assets/platform-capabilities.json`—never restate it here.

```
archgen_platform                                    # auto-detect
archgen_platform { harness: 'claude' }              # specific harness
```

Returns: project/global skill paths, MCP config path and top-level key, restart semantics, sub-agent mechanics, and whether this project has a CodeGraph index.

## Platform detection

`archgen_platform` is the **only** source of detection order and harness capabilities — `packages/mcp/assets/platform-capabilities.json` is the authority, and this file never restates it. A harness this server does not know is a normal situation, not an error: use the **Unknown platform** procedure below.

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

`archgen_platform` is the **runtime** authority: it returns the exact config path, the URL field and the restart semantics for the harness you are on. It also returns the **key vocabulary** for that harness — the top-level key its config uses, and the field its server entry takes.

This file does not repeat that vocabulary, because a repeated list is a second source that can disagree with the one the writer uses: the keys differ per harness, and the writer reads them from the registry. **Never assume one key across harnesses** — read the harness you are on. The URL field varies with it (`url`, `serverUrl` or `httpUrl`), so read that too rather than assume one.

- **Automated wiring is an ADMIN action.** Never hand-edit a harness config: run `archgen-skill mcp add --project <dir> --location project --yes`. It prints the PLAN first and writes only with `--yes`; the same handler answers `archgen-mcp mcp-list`.
- **VS Code reads two formats.** It has a project config and a portable global one, and the global path is `$COPILOT_HOME`-relative — `archgen_platform` returns both. Global wiring uses the portable format so VS Code stable/Insiders, the Copilot CLI, and every workspace see one server.

## Sub-agent dispatch

Inspect `archgen_platform` before wave execution for the native tool, parallelism limit, worktree isolation, or sequential fallback.

## Unknown platform

1. **Web search:** `<platform> official docs MCP configuration` and `<platform> agent skills install path`; prefer vendor docs, note publication dates.
2. **Propose:** present paths and the exact config diff. `[approval gate]`
3. **Apply & verify:** the user runs the command; verify tool visibility afterwards, and offer to upstream the platform definition.

## CodeGraph indexing scope

Indexers parse **source symbols only** (functions, classes, imports)—never Markdown headings or YAML dependencies. Use the right tool:

- **Source navigation:** CodeGraph MCP tools (`.codegraph/`).
- **Task dependency graphs:** `archgen_plan{action:'graph'}`.
- **`.archgen/` Markdown navigation + FR/TASK link validation:** `archgen_docs`.

### CodeGraph bootstrap

CodeGraph (`@colbymchenry/codegraph`, MIT) keeps a local SQLite symbol graph in `.codegraph/` and serves it via MCP. `npx archgen-skill init` installs it: the CLI (only when it is missing), the MCP wiring and the project index.

```
archgen-skill codegraph status                     # install, wiring, index state (read-only)
archgen-skill codegraph ensure                     # PLAN only — nothing is written
archgen-skill codegraph ensure --yes               # install (first time only) + wire + index
archgen-skill codegraph wire --yes                 # wire the harnesses only
```

- **Index once:** built during bootstrap, kept live by the MCP file watcher—**never re-index manually**.
- **Writes need `--yes`:** the CLI install and the harness config entries are machine-level changes. The command prints the PLAN without `--yes` and writes nothing; with `--yes` it applies.
- **Install ONCE, never upgrade:** when the CodeGraph CLI is missing, the first-time install fetches the newest published release (CodeGraph's own official install path). When it is already there, ArchGen installs NOTHING and changes NOTHING — an installed CodeGraph may be pinned, may be a bundle install, and it is the user's to manage (`codegraph upgrade` is theirs to run).
- **Telemetry:** CodeGraph enables anonymous machine-ID telemetry (`~/.codegraph/`) by default; disclose it accurately (never "100% offline/no telemetry"). ArchGen's policy sets `CODEGRAPH_TELEMETRY=0` **in the MCP entry** — per process, no machine-wide write.
- **Step 0:** `.codegraph/` present → use it. Absent → run `archgen-skill codegraph ensure --yes` once per project (grep/glob fallback until then).

### §codegraph-tools — the CodeGraph surface

CodeGraph is its OWN MCP server. ArchGen never re-implements it: it wires it and tells the agent what it can call.

**By default CodeGraph exposes ONE tool** (`codegraph_explore`); the other seven exist and stay unlisted, because each listed tool costs permanent context and steers the agent toward a narrower call. ArchGen's policy (`packages/mcp/assets/codegraph-policy.json`) re-enables the full set through the MCP entry's environment:

```
CODEGRAPH_MCP_TOOLS=explore,node,search,callers,callees,impact,files,status
```

**The allowlist REPLACES the default**, so every tool wanted is named explicitly; a name CodeGraph does not know is dropped silently.

| Tool | Returns | Use it for | CLI equivalent |
|---|---|---|---|
| `codegraph_explore` | verbatim line-numbered source of the relevant symbols, grouped by file + call paths (including dynamic-dispatch hops) + blast radius | the FIRST call for almost any question: how does X work, a flow, a bug, an area to survey | `codegraph explore "<query>"` |
| `codegraph_search` | symbol LOCATIONS only (no code) | "where is X defined" — cheap and exact | `codegraph query <search> [--kind] [--json]` |
| `codegraph_node` | one symbol's body + caller/callee trail, OR a file read with line numbers | a precise read of ONE symbol or file (`includeCode`, `symbolsOnly`, `offset`/`limit`) | `codegraph node [symbol] [--file]` |
| `codegraph_callers` | who calls a symbol | a caller census for one symbol | `codegraph callers <symbol> [--json]` |
| `codegraph_callees` | what a symbol calls | a dependency census for one symbol | `codegraph callees <symbol> [--json]` |
| `codegraph_impact` | the symbols affected by changing one | before a refactor — the blast radius on its own (`--depth`) | `codegraph impact <symbol> [--depth] [--json]` |
| `codegraph_files` | the indexed file tree with language + symbol counts | a layout survey (`format`, `pattern`, `maxDepth`) | `codegraph files [--filter] [--format]` |
| `codegraph_status` | index health: files, nodes, edges, pending sync | debugging the index — skip otherwise | `codegraph status --json` |

**Routing rules (they are what keeps eight tools from being mis-picked):**

1. `explore` FIRST, for almost everything: it returns source, call paths and blast radius in one call.
2. `search` when you need the EXACT location of a symbol — a name you are not sure of, or the file that defines it. It returns locations only, so it is the cheapest way to orient.
3. `node` when you want ONE symbol's body, or one file's current source with line numbers — and when a symbol name is ambiguous, it returns every overload.
4. `callers` / `callees` for a precise question about ONE symbol ("who calls this?", "what does this call?"); use `explore` when you want the flow around it.
5. `impact` before changing a symbol's contract: the blast radius without the source.
6. `files` for a layout survey of the INDEX (faster than globbing); `status` only when the index looks wrong.
7. Do NOT re-verify a CodeGraph answer with grep — it is the index, not a hint.

**Sub-agents and harnesses without MCP** never see the MCP guidance, so the worker contract names the CLI equivalents:

```
codegraph explore "<symbol names or question>"
codegraph query <symbol>
codegraph node <symbol>
codegraph impact <symbol>
```

**Security notes:** `projectPath` accepts ANY absolute path and resolves to the nearest `.codegraph/` index — so an agent can read a DIFFERENT project's graph. Only pass a path inside the project you are working on. CodeGraph is 100% local (SQLite); the only egress is the anonymous telemetry the policy turns off per process.
