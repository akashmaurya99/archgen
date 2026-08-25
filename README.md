<div align="center">

# archgen

**Conversational architecture generation & autonomous task execution for coding agents.**

[![CI](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml/badge.svg)](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Describe what you want to build. archgen interviews you (or surveys your existing
codebase), produces an architecture contract plus a dependency-ordered task graph,
verifies the plan, then executes it wave-by-wave through sub-agents.

Works as an agent skill for **Claude Code · OpenCode · Cursor · Codex · Gemini CLI ·
Antigravity** — and any agentskills.io-compatible harness.

</div>

---

## Why archgen

AI coding agents fail at scale for predictable reasons: plans with hidden cycles,
workers editing the same files, tasks without objective acceptance criteria, and no
human checkpoint before execution. archgen makes each of these a *structural*
guarantee rather than a hope:

| Guarantee | Mechanism |
| --- | --- |
| Plans are valid before work starts | Verifier gate — cycles, dangling refs, ownership overlaps, plan↔task coverage |
| You approve before code is written | Explicit user gate after verifier approval |
| Parallel workers never collide | Disjoint `file_ownership` globs enforced per wave |
| Task order is always correct | Topological waves from `depends_on`; chains stay sequential |
| Failures never cascade silently | Failed tasks exclude downstream into `blockedByFailure`, surfaced to you |
| Every artifact is reviewable | Everything lives in one `.archgen/<slug>/` folder, versioned by git |

## How it works

```text
 interview (greenfield)  ·  survey (brownfield)
              │
              ▼
   .archgen/<slug>/  ── architecture.yaml · docs · ADRs · plans · tasks.yaml
              │
              ▼
   VERIFIER GATE ──issues──► fix & re-verify
              │ APPROVE
              ▼
   USER GATE ────reject───► revise
              │ approve
              ▼
   WAVES ── topological order · one sub-agent per task · disjoint ownership
              │
              ▼
   final report: done / failed / blocked · commits · follow-ups
```

## Installation

**Prepare a project** (installs ONE canonical skill copy + harness bridges —
never duplicates; existing files are preserved and upgraded in place):

```bash
npx archgen-skill init
```

**Or install globally** into every detected harness:

```bash
npx archgen-skill install          # symlinks; --copy for real copies
```

Prefer shell? Clone this repo and run `./install.sh` (same behavior, plus
`--init [dir]`, `--project <dir>`, `--uninstall`). Requires Node.js ≥ 18.
The skill itself has zero npm dependencies.

**VS Code extension** (optional, read-only visual layer): install
[`packages/extension/archgen-extension-0.0.1.vsix`](packages/extension/) via
*Extensions: Install from VSIX…*

## Usage

Open your project in any supported agent and talk naturally:

| You say | What runs |
| --- | --- |
| *"generate architecture for a booking platform"* | Interview → artifacts → both gates |
| *"add rate-limiting to my API server"* | Survey existing code first, then plan + gates |
| *"start work"* | Autonomous wave execution until done or blocked |
| *"roll back the auth changes"* | Impact analysis → reverse-order revert plan → approval |

The optional VS Code extension renders `.archgen/` as a live task DAG (running
tasks pulse, edges animate), your real code-dependency graph, and rendered docs —
with a ▶ button that launches your agent on any task. An activity-bar cockpit
complements the editor board with glanceable progress, status-grouped tasks with
quick build, and quick-open docs. It is strictly a viewer:
uninstalling it loses nothing.

## Monorepo map

| Path | What | Distributed as |
| --- | --- | --- |
| [`skill/`](skill/) | The agent skill — `SKILL.md`, `references/`, zero-dep `scripts/`, `assets/` | vendored into npm; installed by `install.sh` |
| [`packages/cli/`](packages/cli/) | `archgen-skill init` / `install` / `uninstall` | npm: [`archgen-skill`](https://www.npmjs.com/package/archgen-skill) |
| [`packages/extension/`](packages/extension/) | Task DAG · code graph · docs views · build button · activity-bar cockpit | `.vsix` via `vsce package` |
| [`schemas/`](schemas/) | Task-file JSON schema + architecture conventions | repo contract |
| [`fixtures/`](fixtures/) | Deterministic E2E demos + shared YAML corpus | repo-only |
| [`docs/`](docs/) | Architecture walkthrough · release process | repo-only |

## Development

```sh
# Skill suite (node:test, zero deps)
node --test skill/scripts/test/*.test.mjs

# CLI — single-store installer, doctor, uninstall --project
cd packages/cli && npm test

# Extension — feature picker, probe order, ≥90% coverage enforced (Node 22 toolchain)
cd packages/extension && npm ci && npm run typecheck && npm run compile && npm test

# Deterministic end-to-end drivers (no LLM calls)
bash fixtures/greenfield-demo/run.sh && bash fixtures/brownfield-demo/run.sh
bash fixtures/verifier-negative/run.sh
```

Extension tests require Node 22 (native-addon pool stability); the shipped
extension runs inside VS Code's Electron runtime regardless. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Dual-mode design, gates, wave mechanics, platform detection |
| [docs/releasing.md](docs/releasing.md) | Cutting CLI + extension releases |
| [skill/SKILL.md](skill/SKILL.md) | The full skill contract the agents execute |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

[MIT](LICENSE) © ArchGen contributors
