# archgen

[![CI](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml/badge.svg)](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Conversational architecture generation and autonomous task execution for coding agents. archgen interviews you (or surveys your existing codebase), produces architecture artifacts plus a dependency-ordered `tasks.yaml`, then executes the work wave-by-wave through sub-agents — with a verifier gate and a user gate before any code is written. It ships as an agent skill for Claude Code, OpenCode, Cursor, Codex, Gemini CLI, Antigravity, and any agentskills.io-compatible harness.

## What is archgen?

archgen turns product intent into a durable architecture contract and a task graph stored in a single hidden `.archgen/<slug>/` folder inside your project. A verifier sub-agent checks the plan (cycles, ownership overlaps, missing acceptance criteria) before you approve it, then work is dispatched to one worker per task in topological waves — failed tasks are never auto-retried, they come back to you.

## Quick Start

```bash
# In a project: copy the skill locally + add AGENTS.md/CLAUDE.md pointers
npx archgen init

# Or install globally into every detected harness
npx archgen install
```

Prefer shell? Clone this repo and run the installer:

```bash
./install.sh              # global harness install (symlinks)
./install.sh --init .     # project-local setup + AGENTS.md/CLAUDE.md pointers
```

Requires Node.js >= 18. The skill itself has zero npm dependencies.

## The Loop

```
 interview / survey
        │
        ▼
 artifacts (.archgen/<slug>/)
 architecture.yaml · docs · ADRs · plans · tasks.yaml
        │
        ▼
 VERIFIER GATE ── issues ──► fix & re-verify
        │ APPROVE
        ▼
 USER GATE ─── reject ───► revise
        │ approve
        ▼
 waves (topological order, one worker per task,
 disjoint file_ownership globs)
        │
        ▼
 done — final report: done/failed/blocked, commits, follow-ups
```

## Monorepo map

| Path | What | Published as |
| --- | --- | --- |
| `skill/` | The agent skill: `SKILL.md`, `references/`, `scripts/` (zero-dep Node >= 18), `assets/` | vendored into the npm package; installable via `install.sh` |
| `packages/cli/` | `archgen init` / `install` / `uninstall` CLI | npm: [`archgen`](https://www.npmjs.com/package/archgen) |
| `packages/extension/` | VS Code extension: task DAG view, code-graph view, docs view, build button over `.archgen/` artifacts | `.vsix` via `vsce package` |
| `schemas/` | Task-file JSON schema + architecture conventions | repo-only |
| `fixtures/` | Deterministic end-to-end demos (greenfield, brownfield, verifier-negative, shared YAML corpus) | repo-only |
| `install.sh` | Multi-harness installer with uninstall manifest | repo-only |

## VS Code extension

The extension is a read-only window over your `.archgen/` folder — a live task DAG, code dependency graph, and rendered docs. It never edits repository files itself. See [`packages/extension/`](packages/extension/) and its [MANUAL-TEST.md](packages/extension/MANUAL-TEST.md) checklist.

## Development

```sh
# skill (node:test, no deps)
node --test skill/scripts/test/*.test.mjs

# CLI
cd packages/cli && npm test

# VS Code extension (typecheck + compile + vitest)
cd packages/extension && npm ci && npm run typecheck && npm run compile && npm test
```

Deterministic fixture drivers (no LLM calls): `bash fixtures/greenfield-demo/run.sh`, `bash fixtures/brownfield-demo/run.sh`, `bash fixtures/verifier-negative/run.sh`.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

## License

[MIT](LICENSE)
