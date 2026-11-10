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

**In the project root:**

```bash
npx archgen-skill init
```

Installs one canonical skill copy, wires the `archgen-mcp` server into every
detected harness, and ensures CodeGraph. Then **reload your harness** — the
tools are not available until you do.

To install into every detected harness as a global skill:

```bash
npx archgen-skill install          # symlinks; --copy for real copies
```

**Or let the agent do it.** Copy the prompt in
[`docs/agent-setup-prompt.md`](docs/agent-setup-prompt.md) and paste it into
your agent — it installs the system, verifies the install, and reports the
next wave.

**Without npm.** [`install.sh`](install.sh) is a POSIX-only installer with
zero dependencies beyond coreutils — no sudo, no network, no registry. It
exists for no-registry and air-gapped machines, for installs you want to audit
before running (it is one readable file), and as the reference implementation
the npm CLI is parity-tested against.

```bash
git clone https://github.com/akashmaurya99/archgen.git
cd archgen && ./install.sh --init      # project setup + server bootstrap
./install.sh                            # global skill, every detected harness
./install.sh --uninstall                # removes exactly what it recorded
```

On Windows use `npx archgen-skill init` — it is the cross-platform equivalent.
**Requirements:** Node.js ≥ 20. The CLI has zero npm dependencies; the MCP
server it installs depends on the official Model Context Protocol SDK.

## The `archgen-mcp` server

Every deterministic capability lives in one MCP server, **`archgen-mcp`**,
published to npm as [`archgen-mcp`](https://www.npmjs.com/package/archgen-mcp)
and spoken over stdio by any MCP client.

The agent calls it over MCP; the installer calls `archgen-mcp bootstrap`. One
implementation, two ways in, so the two can never disagree.

| Tool | Does |
| --- | --- |
| `archgen_plan` | validate · verify · graph · impact · coverage · **profile** (evidence-based scope + per-artifact decisions) · scaffold · brief |
| `archgen_tasks` | next wave · set status · list · resume snapshot · worker contract |
| `archgen_docs` | index · digest · section · refs · map · validate the user's artifacts |
| `archgen_registry` | refresh or read the `AGENTS.md` features registry |
| `archgen_codegraph` | install, wire and index CodeGraph |
| `archgen_setup` | doctor · bootstrap · install/remove MCP · list harnesses · harness info |
| `archgen_skills` | match · install · load · digest the capability-skill registry |
| `archgen_refs` | load archgen's own protocol documents, section by section |
| `archgen_help` | the full briefing for one tool domain |

Every result is a typed envelope: `{ ok, data, error, meta }`. A failure is
data, not a crash — `error.code` is one of `INVALID_INPUT`, `NOT_FOUND`,
`CYCLE`, `OWNERSHIP_CONFLICT`, `CONFLICT`, `PERMISSION_DENIED`, `UNAVAILABLE`,
`TIMEOUT`, `INTERNAL`.

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

Nothing is written until three gates pass, in order, and never skipped — even
for a SMALL scope. Gate depth scales with the profile, while the deterministic
floor always runs. **The floor comes first**: `archgen_plan{action:'verify'}`
is driven to `APPROVE` by the orchestrator — ownership overlap, the mirrored
test tree, matrix citations, PRD requirement coverage, **the recorded profile
decisions**, decision files, declared paths, wave labels — before any gate
agent is dispatched, so the agent never spends a round on arithmetic. Every
finding carries a stable **code**, so fixes batch by code and file and CI
counts classes. The **verifier gate** then judges what the tools cannot, from
rendered maps and a plan snapshot (so a stale brief is caught, not judged):
every artifact has a consumer, every reuse names a real host path, every
omission has a recorded reason, every matrix row cites an acceptance that
verifies it. Findings are **BLOCKING**, **NIT** (cosmetic) or **OBSERVATION**
(a capability nobody asked for) — the verifier may not invent requirements. The
gate runs **at most two rounds**: round 1 exhaustive, round 2 a delta
re-check, and what remains escalates to the user. The **plan review** then
checks scope fit and minimalism, and the **user gate** presents the
create/reuse/omit artifact list, the wave summary and the ownership map before
asking for approval.

## Token footprint

Measured, not guessed. `npm run test:budget` reports it, and CI fails if the
always-on footprint exceeds 11,800 tokens.

**Every session pays this much, and no more:**

| | Tokens |
| --- | ---: |
| `skill/SKILL.md` | 6,443 |
| MCP tool catalog (9 tools) | 5,056 |
| **Always-on total** | **11,499** — 35% of a 32k window |

**Everything else is pulled per section, on demand.** The five protocol
references are 15,237 tokens *in total*, but a typical section is **243
tokens** — the agent loads the one it needs, never the file:

| On demand | In total | What is actually read |
| --- | ---: | --- |
| A protocol reference | 15,237 | one section — **243 tokens** |
| A capability skill's rules | — | **~160 tokens** |
| A dispatch brief | 3,886 | the one being dispatched |
| An artifact template | 2,596 | the one being scaffolded |

Nothing is ever read whole. `digest` returns section anchors, `archgen_refs`
and `archgen_skills` serve one section at a time, and a dispatch brief arrives
with the evidence map, the dependency graph, the reference-integrity result and
the mechanical floor already rendered — so the agent pulls what it needs and
never re-reads a plan.

What makes that hold is **behaviour**, not shorter prompts: the deterministic
floor proves the mechanical facts before an agent is dispatched, one exhaustive
gate pass instead of a discovery loop, one agent per task instead of one per
lookup, a worker contract that already carries the capability skill's rules and
the edge cases it owes, and a hard cap of three parallel sub-agents. Shrinking
a prompt to save tokens costs a whole extra round — making the first answer
complete does not.

## Repository layout

| Path | What | Distributed as |
| --- | --- | --- |
| [`skill/`](skill/) | The agent skill — `SKILL.md` + `references/code-standards.md` (guidance only; the server owns every capability) | vendored into npm |
| [`packages/cli/`](packages/cli/) | `archgen-skill init` / `install` / `doctor` / `uninstall` | npm: [`archgen-skill`](https://www.npmjs.com/package/archgen-skill) |
| [`packages/mcp/`](packages/mcp/) | The `archgen-mcp` server — every deterministic capability | npm: [`archgen-mcp`](https://www.npmjs.com/package/archgen-mcp) |
| [`schemas/`](schemas/) | Task-file JSON schema + architecture conventions | repo contract |
| [`fixtures/`](fixtures/) | Deterministic E2E drivers + shared YAML corpus | repo-only |
| [`internal/`](internal/) | QA tooling (token budget, version gates) — never shipped | repo-only |
| [`docs/`](docs/) | Architecture walkthrough · agent setup prompt · release process | repo-only |

## Development

```sh
npm run setup   # once — installs the MCP server's dependencies
npm test        # internal + MCP + CLI suites (the set CI runs)
```

The deterministic end-to-end drivers make **no LLM calls** and drive the real
MCP tool surface, so a broken tool fails the fixtures:

```sh
npm run test:fixtures
```

| Fixture | What it proves |
| --- | --- |
| [`greenfield-demo`](fixtures/greenfield-demo/) | The full GENERATE → gates → wave-walk → clean-tree flow |
| [`brownfield-demo`](fixtures/brownfield-demo/) | Survey-first planning against an existing codebase |
| [`verifier-negative`](fixtures/verifier-negative/) | The gate actually rejects cycles, overlaps and unknown refs |
| [`tool-matrix`](fixtures/tool-matrix/) | **Every action of every tool**, through the real MCP binary |

### Cutting a release

```sh
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
| [docs/architecture.md](docs/architecture.md) | Dual-mode design, gates, wave mechanics, platform detection |
| [docs/ci.md](docs/ci.md) | The plan gate as a build gate — `archgen-mcp exec … --fail-on verdict:ISSUES` |
| [docs/agent-setup-prompt.md](docs/agent-setup-prompt.md) | Copy-paste prompt: install archgen and verify it |
| [docs/releasing.md](docs/releasing.md) | Cutting CLI + MCP server releases |
| [skill/SKILL.md](skill/SKILL.md) | The full skill contract the agents execute |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE) © ArchGen contributors
