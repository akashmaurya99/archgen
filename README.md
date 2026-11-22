<div align="center">

# archgen

**Conversational architecture generation & autonomous task execution for coding agents.**

[![CI](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml/badge.svg)](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Describe what you want to build. archgen interviews you — or surveys your
existing codebase — produces an architecture contract and a dependency-ordered
task graph, has the plan verified, then executes it wave by wave through
sub-agents.

Works as an agent skill for **Claude Code · OpenCode · Cursor · Codex · Gemini CLI ·
Antigravity** — and any agentskills.io-compatible harness.

</div>

---

## Contents

| | |
| --- | --- |
| [What archgen does](#what-archgen-does) | The guarantees, and the mechanism behind each |
| [Install](#install) | Project, global, and air-gapped installs |
| [How it is deployed](#how-it-is-deployed) | The data plane the model sees, the control plane the CLI owns |
| [Usage](#usage) | What you say, and what runs |
| [The gates](#the-gates) | Why nothing is written before you approve it |
| [Code intelligence](#code-intelligence) | CodeGraph: the whole surface, installed once |
| [Token footprint](#token-footprint) | What a session actually pays |
| [Repository layout](#repository-layout) | Where everything lives |
| [Development](#development) | Running the gates, the fixtures, a release |
| [Documentation](#documentation) | The rest of the docs |

## What archgen does

AI coding agents fail at scale for predictable reasons: plans with hidden
cycles, workers editing the same files, tasks without objective acceptance
criteria, and no human checkpoint before execution. archgen turns each of
these into a structural guarantee rather than a hope.

| Guarantee | Mechanism |
| --- | --- |
| Plans are valid before work starts | Verifier gate — cycles, dangling refs, ownership overlaps, plan↔task coverage |
| You approve before code is written | Explicit user gate, after verifier approval |
| Parallel workers never collide | Disjoint `file_ownership` globs enforced per wave, plus a 3-agent parallel cap |
| Task order is always correct | Topological waves from `depends_on`; chains stay sequential |
| Failures never cascade silently | Failed tasks exclude downstream into `blockedByFailure`, surfaced to you |
| Capability skills are actually applied | A matched skill's normative rules travel inside the worker prompt |
| Every artifact is reviewable | Everything lives in one `.archgen/<slug>/` folder, versioned by git |

## Install

### In a project

```bash
npx archgen-skill init
```

This installs one canonical skill copy, wires the `archgen-mcp` server into
every detected harness, and ensures CodeGraph. **Reload your harness
afterwards** — the tools are not available until you do.

By default the skill is wired into your global harness directories. To make
the project carry its own committed MCP configuration instead, add
`--location-project`.

### As a global skill

```bash
npx archgen-skill install
```

This links the skill into every detected harness directory. Pass `--copy` for
real copies instead of symlinks.

### Without npm

[`install.sh`](install.sh) is a POSIX-only installer with zero dependencies
beyond coreutils — no sudo, and no npm or registry for the skill itself (it
copies the tree in the repository). It exists for no-registry and air-gapped
machines, for installs you want to audit before running (it is one readable
file), and as the reference implementation the npm CLI is parity-tested
against. The optional server bootstrap it runs at the end **does** need Node
and the npm registry — skip it with `--no-mcp --no-codegraph` on an offline
machine.

```bash
git clone https://github.com/akashmaurya99/archgen.git
cd archgen
./install.sh --init
./install.sh
./install.sh --uninstall
```

The three commands are, in order: project setup with the server bootstrap,
a global install for every detected harness, and an uninstall that removes
exactly what was recorded.

On Windows use `npx archgen-skill init` — it is the cross-platform equivalent.

**Requirements:** Node.js ≥ 20. The CLI has zero npm dependencies; the MCP
server it installs depends on the official Model Context Protocol SDK.

### Let the agent do it

Copy the prompt in
[`docs/agent-setup-prompt.md`](docs/agent-setup-prompt.md) and paste it into
your agent — it installs the system, verifies the install, and reports the
next wave.

## How it is deployed

Two planes, one implementation.

| Plane | Who | What it can do |
| --- | --- | --- |
| **Data plane** | the model, over MCP | plan, verify, execute, navigate artifacts, read the runtime facts |
| **Control plane** | the CLI or CI | install packages, wire harness configs, change machine state |

The admin tools (`archgen_setup`, `archgen_codegraph`) live on the control
plane: in the default `lean` profile they are **not published to the model**
at all, so their schemas never enter its context and the model cannot call
them. The CLI reaches the same handlers, and every write command prints its
plan first and writes only with `--yes`.

### The tools the model sees

| Tool | Does |
| --- | --- |
| `archgen_plan` | validate · verify · graph · impact · coverage · **profile** (evidence-based scope + per-artifact decisions) · scaffold · brief |
| `archgen_tasks` | next wave · set status · list · resume snapshot · worker contract |
| `archgen_docs` | index · digest · section · refs · map · validate the user's artifacts |
| `archgen_registry` | refresh or read the `AGENTS.md` features registry |
| `archgen_skills` | match · install · load · digest the capability-skill registry |
| `archgen_refs` | load archgen's own protocol documents, section by section |
| `archgen_help` | the full briefing for one tool domain |
| `archgen_platform` | this harness: skill paths, MCP config, sub-agents, CodeGraph index |

### The commands an operator runs

```bash
archgen-skill doctor
archgen-skill mcp list
archgen-skill mcp add --yes
archgen-skill mcp remove --yes
archgen-skill codegraph status
archgen-skill codegraph ensure --yes
archgen-skill codegraph wire --yes
```

Without `--yes` every command prints the plan and writes nothing.

`ARCHGEN_TOOL_PROFILE=full` publishes the admin tools to the model as well.
Use it for a trusted automation run, not for a model reading an untrusted
repository.

Every result is a typed envelope: `{ ok, data, error, meta }`. A failure is
data, not a crash — `error.code` is one of `INVALID_INPUT`, `NOT_FOUND`,
`CYCLE`, `OWNERSHIP_CONFLICT`, `CONFLICT`, `PERMISSION_DENIED`, `UNAVAILABLE`,
`TIMEOUT`, `INTERNAL`. The full envelope schema is published once, as the MCP
resource `archgen://schema/envelope`.

## Usage

Open your project in any supported agent and talk naturally.

| You say | What runs |
| --- | --- |
| *"generate architecture for a booking platform"* | Interview → artifacts → both gates |
| *"add rate-limiting to my API server"* | Survey existing code first, then plan + gates |
| *"start work"* | Autonomous wave execution until done or blocked |
| *"investigate this recurring timeout"* | Root-cause protocol — no patch-fixes without a root cause |
| *"roll back the auth changes"* | Impact analysis → reverse-order revert plan → approval |
| *"fetch the design skill"* | Capability-skill registry: match, install, apply |

## The gates

Nothing is written until three gates pass, in order, and never skipped — even
for a SMALL scope. Gate depth scales with the profile, while the deterministic
floor always runs.

**The floor comes first.** `archgen_plan{action:'verify'}` is driven to
`APPROVE` by the orchestrator — ownership overlap, the mirrored test tree,
matrix citations, PRD requirement coverage, the recorded profile decisions,
decision files, declared paths, wave labels — before any gate agent is
dispatched, so the agent never spends a round on arithmetic. Every finding
carries a stable **code**, so fixes batch by code and file and CI counts
classes.

**The verifier gate** then judges what the tools cannot, from rendered maps
and a plan snapshot (so a stale brief is caught, not judged): every artifact
has a consumer, every reuse names a real host path, every omission has a
recorded reason, every matrix row cites an acceptance that verifies it.
Findings are **BLOCKING**, **NIT** (cosmetic) or **OBSERVATION** (a capability
nobody asked for) — the verifier may not invent requirements. The gate runs
**at most two rounds**: round 1 exhaustive, round 2 a delta re-check, and what
remains escalates to the user.

**The plan review** then checks scope fit and minimalism, and **the user gate**
presents the create/reuse/omit artifact list, the wave summary and the
ownership map before asking for approval.

The whole gate chain is also a build gate:

```bash
npx archgen-mcp exec archgen_plan '{"action":"verify","tasksYaml":".archgen/<slug>/tasks.yaml","planDir":".archgen/<slug>/plans"}' --fail-on verdict:ISSUES
```

## Code intelligence

CodeGraph is a separate MCP server that answers code questions from a local
symbol graph. archgen installs it, wires it, and tells the agent how to use
it — it never re-implements it.

| Tool | Use it for |
| --- | --- |
| `codegraph_explore` | the first call for almost anything: source + call paths + blast radius, in one call |
| `codegraph_search` | exact symbol locations, without the source |
| `codegraph_node` | one symbol's body, or one file's current source with line numbers |
| `codegraph_callers` / `codegraph_callees` | a precise question about one symbol |
| `codegraph_impact` | what a change to one symbol reaches |
| `codegraph_files` | a layout survey of the index |
| `codegraph_status` | index health, when the index looks wrong |

ArchGen publishes only `codegraph_explore` by default; the other seven remain
available through explicit configuration or the CLI when a narrow operation is
cheaper. The policy ships **routing rules** for choosing among them without
turning eight tools into eight guesses. Sub-agents and harnesses without MCP
use the CLI equivalents instead:
`codegraph explore`, `codegraph query`, `codegraph node`, `codegraph impact`.

The policy lives in one file
([`packages/mcp/assets/codegraph-policy.json`](packages/mcp/assets/codegraph-policy.json)):

| Fact | Default | Why |
| --- | --- | --- |
| `package` | `@colbymchenry/codegraph` | one source for the CLI and the MCP entry |
| `install` | `latest` | what a **first-time** install fetches — the newest published release |
| `wire` | `1.6.2` | the exact spec the MCP entry's `npx` fallback uses |
| `tools` | `explore` | the high-signal default; opt into specialized tools explicitly |
| `telemetry` | `off` | `CODEGRAPH_TELEMETRY=0` in the MCP entry — per process, no machine-wide write |

An installed CodeGraph is never upgraded or rewritten: it may be pinned, it
may be a bundle install, and it is the user's to manage.

## Token footprint

Measured, not guessed. `npm run test:budget` reports it, and CI fails if the
always-on footprint exceeds 18,000 tokens.

| | Tokens |
| --- | ---: |
| `skill/SKILL.md` (loaded on trigger) | 3,009 |
| Generated `AGENTS.md` instructions | 381 |
| MCP tool catalog — the real `tools/list` payload | 6,114 |
| CodeGraph's own tools (explore-only default) | 563 |
| **Repo baseline** | **10,067** — 31% of a 32k window (was 17,937) |

Legacy MCP results use minified JSON. Verified structured clients may set
`ARCHGEN_MCP_RESULT_MODE=structured` to keep the full envelope in
`structuredContent` with a short success summary; errors always keep full JSON.

The catalog is measured over the REAL protocol, not a projection: the budget
tool speaks JSON-RPC to the real binary and measures what `tools/list`
returns. The earlier measurement (name + description + input schema only)
under-counted by a third, because it never saw the output schema or the
annotations.

**Everything else is pulled per section, on demand.** The five protocol
references are 21,501 tokens *in total*, but a typical section is **291
tokens** — the agent loads the one it needs, never the file:

| On demand | In total | What is actually read |
| --- | ---: | --- |
| A protocol reference | 21,501 | one section — **291 tokens** |
| A capability skill's rules | — | **~160 tokens** |
| A dispatch brief | 4,119 | the one being dispatched |
| Artifact templates (8 scope variants) | 2,761 | one scope only; task skeletons are **126–588 tokens** |

Task scaffolds match SMALL/MEDIUM/LARGE depth. Pass `testLayout:'colocated'` for host-native colocated tests; mirrored remains the compatible default.

Typical artifact counts are **2 files for SMALL** (`tasks.yaml` + plan with embedded survey/profile), **3–4 for MEDIUM**, and **4–6 for LARGE**. Complex brownfield work adds `codebase-map.md`; PRDs require `product-facing`; architecture requires real contracts; `docs/topology.md` requires non-obvious topology and an architecture source. Existing host documents are reused, and ADRs/waivers appear only for actual decisions.

Whole topics are never required by the default routes. `digest` returns section anchors, `archgen_refs`
and `archgen_skills` serve one section at a time, and a dispatch brief arrives
with the evidence map, the dependency graph, the reference-integrity result,
the mechanical floor and the traceability maps already rendered — so the agent
pulls what it needs and never re-reads a plan.

What makes that hold is **behaviour**, not shorter prompts: the deterministic
floor proves the mechanical facts before an agent is dispatched, one exhaustive
gate pass instead of a discovery loop, one agent per task instead of one per
lookup, a worker contract that already carries the capability skill's rules
and the edge cases it owes, and a hard cap of three parallel sub-agents.
Shrinking a prompt to save tokens costs a whole extra round — making the
first answer complete does not.

**The savings came from structure, never from cutting the agent's aids.** The
skill keeps every rule, every rationale and every failure hint it had; what
changed is that the model no longer carries a privileged tool it may not use,
and the protocol no longer repeats the same output schema on every tool.

## Repository layout

| Path | What | Distributed as |
| --- | --- | --- |
| [`skill/`](skill/) | The agent skill — `SKILL.md` + `references/code-standards.md` (guidance only; the server owns every capability) | vendored into npm |
| [`packages/cli/`](packages/cli/) | `archgen-skill init` / `install` / `doctor` / `uninstall` / `update` / `restore` / `migrate` / `mcp` / `codegraph` — the CONTROL PLANE | npm: [`archgen-skill`](https://www.npmjs.com/package/archgen-skill) |
| [`packages/mcp/`](packages/mcp/) | `archgen-mcp` — the server that owns every deterministic capability | npm: [`archgen-mcp`](https://www.npmjs.com/package/archgen-mcp) |
| [`packages/mcp/schemas/`](packages/mcp/schemas/) | The task-file JSON schema (`tasks.schema.json`) | npm: `archgen-mcp` |
| [`schemas/`](schemas/) | The architecture.yaml conventions (normative shape) | repo-only |
| [`fixtures/`](fixtures/) | Deterministic E2E drivers + shared YAML corpus | repo-only |
| [`internal/`](internal/) | QA tooling (the gates) — never shipped | repo-only |
| [`docs/`](docs/) | The folder index · architecture walkthrough · the CI gate · agent setup prompt · release process | repo-only |

Both packages split their source **by domain**, and both split their tests the
same way, so a test lives in the folder of the code it tests.

```
packages/mcp/src/core/            packages/cli/lib/
├── protocol/  the vocabulary      ├── fs-paths.js   lstatSafe · relJoin
│              every tool speaks   ├── block.js     the managed-block format
├── plan/      the plan of record  ├── store.js     the store layout
├── docs/      briefs + contracts  └── …            one command each
├── skill/     capability skills
├── harness/   MCP + platform wiring
└── fs/        the only layer that touches disk
```

`protocol/` and `fs/` are the bottom layers: neither imports anything above
it. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full map.

### The gates

`internal/tools/` holds the repository's own gates, grouped by what they are
for — `lint/` (a defect fails the build), `release/`, `budget/`, `safety/`.
They are repo-only and never shipped.

| Gate | What it proves |
| --- | --- |
| `test:versions` | The version lives in exactly one place, and every derived surface agrees |
| `test:contract` | The skill's declared minimum server version is satisfiable by this release |
| `test:teaching` | Every failure site teaches the agent its next call |
| `test:structure` | The repository's shape is clean — no binary files, no nested dependencies, no headerless sources, no duplicated helpers, no broken imports |
| `test:budget` | The always-on context (skill + tool catalog) fits its ceiling |
| `test:immutable` | The suites never mutate the repository |

## Development

Install the MCP server's dependencies once, then run the suite CI runs:

```bash
npm run setup
npm test
```

The deterministic end-to-end drivers make **no LLM calls** and drive the real
MCP tool surface, so a broken tool fails the fixtures:

```bash
npm run test:fixtures
```

| Fixture | What it proves |
| --- | --- |
| [`greenfield-demo`](fixtures/greenfield-demo/) | The full GENERATE → gates → wave-walk → clean-tree flow |
| [`brownfield-demo`](fixtures/brownfield-demo/) | Survey-first planning against an existing codebase |
| [`verifier-negative`](fixtures/verifier-negative/) | The gate actually rejects cycles, overlaps and unknown refs |
| [`tool-matrix`](fixtures/tool-matrix/) | **Every action of every tool**, through the real MCP binary |

### Cutting a release

```bash
npm run release:prepare <version>
```

One command: it bumps the canonical version, propagates it to every derived
surface, regenerates both lockfiles, and runs **every gate**. It never
publishes and never tags — that stays a deliberate, one-tag-at-a-time human
action. The version lives in exactly one file (`archgen.config.json`), and
`npm run test:versions` proves it.

See [docs/releasing.md](docs/releasing.md) for the full checklist.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/README.md](docs/README.md) | The index of the `docs/` folder |
| [docs/architecture.md](docs/architecture.md) | The two planes, the gates, wave mechanics, platform detection |
| [docs/ci.md](docs/ci.md) | The plan gate as a build gate — `archgen-mcp exec … --fail-on verdict:ISSUES` |
| [docs/agent-setup-prompt.md](docs/agent-setup-prompt.md) | Copy-paste prompt: install archgen and verify it |
| [docs/releasing.md](docs/releasing.md) | Cutting CLI + MCP server releases |
| [skill/SKILL.md](skill/SKILL.md) | The full skill contract the agents execute |
| [SECURITY.md](SECURITY.md) | The privilege boundary, the CodeGraph policy, how to report a vulnerability |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE) © ArchGen contributors
