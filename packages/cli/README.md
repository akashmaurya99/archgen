<div align="center">

# archgen-skill

**Conversational architecture generation & autonomous task execution for coding agents.**

[![CI](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml/badge.svg)](https://github.com/akashmaurya99/archgen/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/akashmaurya99/archgen/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

Describe what you want to build. archgen interviews you (or surveys your existing
codebase), produces an architecture contract plus a dependency-ordered task graph,
verifies the plan, then executes it wave-by-wave through sub-agents.

Works as an agent skill for **Claude Code · OpenCode · Cursor · Codex · Gemini CLI ·
Antigravity** — and any [agentskills.io](https://agentskills.io)-compatible harness.

</div>

---

## Install

**Prepare a project** (recommended) — installs ONE canonical skill copy plus
harness bridges so every agent auto-discovers it:

```bash
npx archgen-skill init
```

What `init` writes (nothing is ever duplicated):

| Path | What |
| --- | --- |
| `.agents/skills/archgen/` | **The only real copy** — the agentskills.io standard location read natively by OpenCode, Cursor, Codex, Gemini CLI, Copilot and Antigravity |
| `.claude/skills/archgen → ../../.agents/skills/archgen` | Relative symlink for Claude Code (the one harness needing it). Skipped gracefully where symlinks need privileges — Claude still works via the bridge below |
| `AGENTS.md` | Managed hub block: skill pointer + quick triggers + a features registry that stays current as you add features |
| `CLAUDE.md` | One-line bridge: `@AGENTS.md` (existing files keep all their content; if it already imports AGENTS.md we write nothing) |

Existing projects with user content are safe: managed blocks upsert between
markers, modified skill copies are backed up to `.archgen/.backup/<timestamp>/`
before refresh, and legacy dual-copy layouts are migrated to symlinks
automatically. Verify anytime with `archgen-skill doctor`.

**Or install globally** into every detected harness:

```bash
npx archgen-skill install          # symlinks; --copy for real copies
```

Prefer shell? Clone the repo and run `./install.sh` (same behavior, plus
`--init`, `--project`, `--uninstall`). Requires Node.js ≥ 18.
The skill itself has zero npm dependencies.

## Quick start

After `npx archgen-skill init`, open your project in any supported agent and talk naturally:

| You say | What runs |
| --- | --- |
| *"generate architecture for a booking platform"* | Interview → artifacts → both gates |
| *"add rate-limiting to my API server"* | Survey existing code first, then plan + gates |
| *"start work"* | Autonomous wave execution until done or blocked |
| *"roll back the auth changes"* | Impact analysis → reverse-order revert plan → approval |

Everything archgen produces lives in one reviewable `.archgen/<slug>/` folder —
architecture contract, docs, ADRs, plans, and a `tasks.yaml` task graph — versioned by git.

## Commands

| Command | What it does |
| --- | --- |
| `npx archgen-skill init [dir]` | Install the single canonical skill store at `.agents/skills/archgen`, add the Claude symlink adapter, write the AGENTS.md hub + CLAUDE.md `@AGENTS.md` bridge |
| `npx archgen-skill install [--copy]` | Install into global harness skill dirs (symlinks by default, real copies with `--copy`) |
| `npx archgen-skill uninstall` | Remove globally-installed copies (manifest-recorded, safe removal) |
| `npx archgen-skill uninstall --project [dir]` | Remove project install: strips managed blocks, our symlink and the store **only if unmodified** — feature folders in `.archgen/` and all user content are preserved |
| `npx archgen-skill doctor [dir] [--check]` | Verify + auto-repair an installation: store integrity, version stamp, Claude link, blocks present exactly once, manifest resolution (`--check` reports without fixing) |
| `npx archgen-skill --help` | Help |

### Version stamp (`.archgen-version`)

Every skill tree the CLI writes carries a one-line `MAJOR.MINOR.PATCH\n` stamp
at its root — the canonical store from `init`, each `install --copy` tree, and
the real directory behind global symlink installs. `update` refreshes it via
its init/doctor pass. `doctor` lists every detected install with its stamped
version (`missing` / `unknown (pre-0.1 stamp)` when absent or unparseable).
The VS Code extension reads the same file to warn about outdated skills;
absent or corrupt means "unknown (legacy)", never an error.

## Why archgen

AI coding agents fail at scale for predictable reasons: plans with hidden cycles,
workers editing the same files, tasks without objective acceptance criteria, and no
human checkpoint before execution. archgen makes each of these a *structural*
guarantee rather than a hope:

| Guarantee | Mechanism |
| --- | --- |
| Plans are valid before work starts | Verifier gate — catches cycles, dangling refs, ownership overlaps, plan↔task coverage gaps |
| You approve before code is written | Explicit user gate after verifier approval |
| Parallel workers never collide | Disjoint `file_ownership` globs enforced per wave |
| Task order is always correct | Topological waves from `depends_on`; chains stay sequential |
| Failures never cascade silently | Failed tasks exclude downstream into `blockedByFailure`, surfaced to you |
| Every artifact is reviewable | Everything in one `.archgen/<slug>/` folder, versioned by git |

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

## Supported harnesses

| Harness | Global install | Project-local (`init`) |
| --- | --- | --- |
| Claude Code | ✅ | ✅ |
| OpenCode | ✅ | ✅ |
| Cursor | ✅ | ✅ |
| Codex | ✅ | ✅ |
| Gemini CLI | ✅ | ✅ |
| Antigravity | ✅ | ✅ |
| Any agentskills.io harness | ✅ | ✅ |

## VS Code extension (optional)

A read-only visual layer that renders `.archgen/` as a live task DAG (running tasks
pulse, edges animate), your code-dependency graph, and rendered docs — with a ▶
button that launches your agent on any task. Install the `.vsix` from
[GitHub Releases](https://github.com/akashmaurya99/archgen/releases). It is strictly
a viewer: uninstalling it loses nothing.

## Documentation

| Doc | Contents |
| --- | --- |
| [Architecture walkthrough](https://github.com/akashmaurya99/archgen/blob/main/docs/architecture.md) | Dual-mode design, gates, wave mechanics, platform detection |
| [The skill contract](https://github.com/akashmaurya99/archgen/blob/main/skill/SKILL.md) | The full skill specification agents execute |
| [Changelog](https://github.com/akashmaurya99/archgen/blob/main/CHANGELOG.md) | Release history |
| [Contributing](https://github.com/akashmaurya99/archgen/blob/main/CONTRIBUTING.md) | Development setup and PR guide |

## Contributing

See [CONTRIBUTING.md](https://github.com/akashmaurya99/archgen/blob/main/CONTRIBUTING.md).
Skill suite and CLI tests run with zero dependencies:

```sh
node --test skill/scripts/test/*.test.mjs   # skill suite
cd packages/cli && npm test                 # CLI suite
```

## License

[MIT](https://github.com/akashmaurya99/archgen/blob/main/LICENSE) © ArchGen contributors
