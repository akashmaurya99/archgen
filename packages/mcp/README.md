# archgen-mcp

The MCP server for [archgen](https://github.com/akashmaurya99/archgen) — it
owns **every** deterministic capability in the archgen workflow.

The archgen skill is orchestration guidance for an agent; this server is the
runtime it drives. One implementation, three ways in:

| Consumer | How it reaches the server |
|---|---|
| Coding agents | MCP over stdio — 10 domain tools |
| `archgen-skill init` / `install` | `archgen-mcp bootstrap` |
| The VS Code extension | `archgen-mcp exec <tool> '<json>'` |

## Install

The archgen installer wires this server into every detected harness for you:

```bash
npx archgen-skill init
```

That installs the skill, writes the `archgen` MCP entry into each detected
harness's own config (with the correct per-platform file and top-level key),
and ensures CodeGraph.

To run it by hand:

```bash
npx archgen-mcp            # serve MCP over stdio
npx archgen-mcp --list     # list the tools
npx archgen-mcp doctor     # health report
```

Requires **Node.js >= 20** (the official MCP SDK v2 floor).

## The tools

| Tool | Use it for |
|---|---|
| `archgen_plan` | validate · verifier gate · dependency graph · blast radius · coverage · **scaffold** (the artifact set for a scope class) · **brief** (a dispatch brief) |
| `archgen_tasks` | next wave · set status · list · resume snapshot · **contract** (the assembled worker prompt) |
| `archgen_docs` | navigate markdown artifacts: section index, one section, token map, reference integrity |
| `archgen_registry` | refresh / read the AGENTS.md features registry |
| `archgen_codegraph` | install + wire + index CodeGraph and its MCP |
| `archgen_setup` | doctor · bootstrap servers · install/remove the MCP · list harnesses · **harness_info** (a platform's capabilities) |
| `archgen_ui` | drive the VS Code extension in real time |
| `archgen_skills` | match / install / load external capability skills |
| `archgen_refs` | load archgen's own protocol documents — section by section |
| `archgen_help` | the full briefing for one domain |

Every tool returns the same envelope:

```json
{ "ok": true, "data": { }, "error": null, "meta": { "serverVersion": "…", "skillVersion": "…", "projectRoot": "…" } }
```

`ok` says whether the **call** succeeded. A failed call carries a typed
`error.code`:

`INVALID_INPUT` · `NOT_FOUND` · `CYCLE` · `OWNERSHIP_CONFLICT` · `CONFLICT` ·
`PERMISSION_DENIED` · `UNAVAILABLE` · `TIMEOUT` · `INTERNAL`

Call `archgen_help { topic: "<domain>" }` for the full briefing on any tool —
including when to call it, every action, and its gotchas.

### The judgment / output split

The archgen **skill** carries the judgment (policy, rules, when-to-use). This
server carries the **deterministic output** — the artifact sets, the skeletons,
the dispatch briefs, the assembled worker prompt, the harness capability tables.

The five orchestrator-facing protocol documents also live **here**, in
`assets/references/`, and are served section-by-section by `archgen_refs`:

```
archgen_refs { action: 'index', topic: 'orchestration' }
archgen_refs { action: 'read', topic: 'orchestration', section: 'dispatch--wave-execution' }
```

They live here so they are always the same version as the tools they describe.
One exception stays in the skill as a plain file: `code-standards.md`, because
WORKER sub-agents read it with their native file tools and may have no MCP
server at all.

### The capability contract

The skill declares the server version it needs:

```yaml
metadata:
  requires:
    archgen_mcp: ">=x.y.z"
```

`archgen_setup { action: 'doctor' }` reports a mismatch, `bootstrap` warns
before wiring, and CI refuses to ship a skill whose declared minimum exceeds
this package's version.

## The CLI facade

```bash
archgen-mcp exec archgen_plan '{"action":"validate","tasksYaml":"/abs/tasks.yaml"}'
archgen-mcp exec archgen_tasks '{"action":"next","tasksYaml":"/abs/tasks.yaml"}'
archgen-mcp bootstrap --project . --location both --yes
archgen-mcp doctor --project . --json
archgen-mcp uninstall-mcp --project . --yes
```

`exec` runs the **same handlers** the MCP tools expose — there is no second
implementation of any capability, only a second way to reach it.

## Safety

- Every path argument is resolved against the project root and refused if it
  escapes; symlinked targets are never written through.
- MCP-config writes are approval-gated (`approve: true` / `--yes`); without
  approval the tool reports its **plan** and writes nothing.
- A config file that cannot be parsed is reported, never rewritten.
- Writes are atomic (temp file + rename): readers see old-or-new, never a
  partial file.
- UI commands are allowlisted, workspace-scoped, expiring, and idempotent.

## License

MIT
