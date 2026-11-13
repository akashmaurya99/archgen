# archgen-mcp

The MCP server for [archgen](https://github.com/akashmaurya99/archgen) — it
owns **every** deterministic capability in the archgen workflow.

The archgen skill is orchestration guidance for an agent; this server is the
runtime it drives. One implementation, two ways in:

| Consumer | How it reaches the server |
|---|---|
| Coding agents | MCP over stdio — 8 published tools (6 domain tools + `archgen_help` + `archgen_platform`) |
| `archgen-skill init` / `install` | `archgen-mcp bootstrap` |

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
npx archgen-mcp
npx archgen-mcp --list
npx archgen-mcp doctor
```

The first serves MCP over stdio, the second lists every registered tool
(published and admin), and the third prints a health report.

Requires **Node.js >= 20** (the official MCP SDK v2 floor).

## The tools

**Published (the data plane) — what the model can call:**

| Tool | Use it for |
|---|---|
| `archgen_plan` | validate · verifier gate · dependency graph · blast radius · coverage · **profile** (evidence-based scope + per-artifact decisions) · **scaffold** (the artifact set for a scope class) · **brief** (a dispatch brief) |
| `archgen_tasks` | next wave · set status · list · resume snapshot · **contract** (the assembled worker prompt) |
| `archgen_docs` | navigate markdown artifacts: section index, one section, token map, reference integrity |
| `archgen_registry` | refresh / read the AGENTS.md features registry |
| `archgen_skills` | match / install / load external capability skills |
| `archgen_refs` | load archgen's own protocol documents — section by section |
| `archgen_help` | the full briefing for one domain |
| `archgen_platform` | this harness: skill paths, MCP config, sub-agents, CodeGraph index |

**Admin (the control plane) — reachable from the CLI, not from the model:**

| Tool | Use it for |
|---|---|
| `archgen_setup` | doctor · bootstrap · install_mcp · uninstall_mcp · harnesses |
| `archgen_codegraph` | ensure · status · wire CodeGraph + its MCP |

The default profile (`lean`) publishes the first table only. The admin tools
install software and write harness configuration, and their approval flag is
an argument the MODEL supplies — so they are not in the model's hands. The CLI
reaches the same handlers:

```bash
archgen-skill doctor
archgen-skill mcp list
archgen-skill mcp add --yes
archgen-skill mcp remove --yes
archgen-skill codegraph status
archgen-skill codegraph ensure --yes
archgen-skill codegraph wire --yes
```

The first is a health report; `mcp list` names the detected harnesses and
their config paths; `mcp add` and `mcp remove` wire and unwire the server;
`codegraph status` reports the install, the wiring and the index; `codegraph
ensure` installs the CLI if it is MISSING, wires its MCP entry and builds the
index; `codegraph wire` wires the harnesses only. Every write command prints
its plan without `--yes` and writes nothing.

`ARCHGEN_TOOL_PROFILE=full` publishes the admin tools too — for a trusted
automation run, not for a model reading an untrusted repository.

Every tool returns the same envelope:

```json
{ "ok": true, "data": { }, "error": null, "meta": { "serverVersion": "…", "skillVersion": "…", "projectRoot": "…" } }
```

`ok` says whether the **call** succeeded. A failed call carries a typed
`error.code`:

`INVALID_INPUT` · `NOT_FOUND` · `CYCLE` · `OWNERSHIP_CONFLICT` · `CONFLICT` ·
`PERMISSION_DENIED` · `UNAVAILABLE` · `TIMEOUT` · `INTERNAL`

The complete envelope schema is published once, as the MCP resource
`archgen://schema/envelope` — the per-tool output schema is the compact
`{ok}` shape, because repeating the same contract on every tool is a permanent
context tax with no information in it.

Call `archgen_help { topic: "<domain>" }` for the full briefing on any tool —
including when to call it, every action, and its gotchas.

### Fetching, not dumping

Every collection-bearing tool takes `limit` and `offset` (default 50 items) —
the bound is the caller's, and a bounded answer always reports what it left
behind. (`archgen_help` is the exception: it returns ONE briefing, so it takes
neither.) Every collection narrows to **one item**: `taskId`, `skillId`,
`file` + `section`, `harness`. A bounded answer's `meta` carries `available`
(what else exists), `more` (the call that fetches one item) and `next` (the
exact call for the next slice).

So the agent fetches what it needs instead of taking the whole set: a
reference topic is fetched **one section** at a time (`section: '*'` asks for
the whole topic deliberately), and a capability skill is fetched as its
**normative rules plus an index** — never as the file three times over.

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

`archgen-skill doctor` (or `archgen-mcp doctor`) reports a mismatch,
`bootstrap` warns before wiring, and CI refuses to ship a skill whose declared
minimum exceeds this package's version.

## The CLI facade

```bash
archgen-mcp exec archgen_plan '{"action":"validate","tasksYaml":"/abs/tasks.yaml"}'
archgen-mcp exec archgen_tasks '{"action":"next","tasksYaml":"/abs/tasks.yaml"}'
archgen-mcp bootstrap --project . --location both --yes
archgen-mcp doctor --project . --json
archgen-mcp platform --project . --json
archgen-mcp mcp-list --project . --json
archgen-mcp codegraph status --project . --json
archgen-mcp uninstall-mcp --project . --yes
```

`exec` runs the **same handlers** the MCP tools expose — there is no second
implementation of any capability, only a second way to reach it. The admin
handlers stay reachable in every profile: a profile decides what the MODEL can
see, not what the system can do.

## The CodeGraph policy

CodeGraph is a SEPARATE MCP server, and ArchGen wires it — it never
re-implements it. One asset owns five facts
(`packages/mcp/assets/codegraph-policy.json`):

| Fact | Default | Why |
|---|---|---|
| `package` | `@colbymchenry/codegraph` | one source for the CLI and the MCP entry |
| `install` | `latest` | what a FIRST-TIME install fetches — the newest published release, CodeGraph's own official install path |
| `wire` | `1.6.2` | the exact spec the MCP entry's `npx` fallback uses, so a machine with no binary still resolves a reviewed version |
| `tools` | all eight | `explore,node,search,callers,callees,impact,files,status` — the whole surface, in the agent's hands |
| `telemetry` | `off` | set as `CODEGRAPH_TELEMETRY=0` **in the MCP entry** — per process, no machine-wide write |

**An installed CodeGraph is never touched.** When the CLI is missing, the
first-time install fetches it; when it is already there, ArchGen installs
nothing, upgrades nothing and rewrites nothing — it may be pinned, it may be a
bundle install, and it is the user's to manage (`codegraph upgrade` is theirs
to run).

The allowlist REPLACES CodeGraph's default, so every tool wanted is named
explicitly; a name CodeGraph does not know is dropped silently.

Overrides: `ARCHGEN_CODEGRAPH_INSTALL` (what a first-time install fetches),
`ARCHGEN_CODEGRAPH_VERSION` (the pinned npx fallback version, or `latest` to
unpin), `ARCHGEN_CODEGRAPH_TOOLS`, `ARCHGEN_CODEGRAPH_TELEMETRY`.

## Safety

- The server owns a **boundary**: the directory it was started in. A tool's
  `projectRoot` argument selects a directory *inside* that boundary — it
  cannot redefine it, so a model cannot move the edge by naming a different
  root.
- The **profile** is a privilege boundary: the admin tools (install, wire,
  uninstall) are not published to the model by default.
- Every path argument is resolved against the project root and refused if it
  escapes; symlinked targets are never written through, and a symlinked
  *parent* is caught by comparing real paths.
- The artifact space is anchored to the project: a `.archgen` directory
  elsewhere on the machine is not this project's artifacts.
- MCP-config writes are approval-gated (`approve: true` / `--yes`); without
  approval the tool reports its **plan** and writes nothing.
- A config file that cannot be parsed is reported, never rewritten.
- Writes are atomic (temp file + rename): readers see old-or-new, never a
  partial file. A read-modify-write — a status update, a config merge — runs
  under an exclusive lock, so two workers cannot lose each other's change.

## License

MIT
