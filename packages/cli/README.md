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
| `.agents/skills/archgen/` | **The only real copy** — the agentskills.io standard location, read natively by OpenCode, Cursor, Codex, Gemini CLI, Copilot, and Antigravity |
| `.claude/skills/archgen → ../../.agents/skills/archgen` | Relative symlink for Claude Code (the one harness that needs it); skipped gracefully where symlinks require privileges |
| `AGENTS.md` | Managed hub block: skill pointer, quick triggers, and a features registry that stays current as you add features |
| `CLAUDE.md` | One-line bridge: `@AGENTS.md` (existing content is preserved; nothing is written if it already imports AGENTS.md) |

Existing projects are safe: managed blocks upsert between markers, modified skill
copies are backed up to `.archgen/.backup/<timestamp>/` before refresh, and legacy
dual-copy layouts are migrated to symlinks automatically. Verify anytime with
`archgen-skill doctor`.

**Or install globally** into every detected harness:

```bash
npx archgen-skill install          # symlinks; --copy for real copies
```

Prefer shell? Clone the repo and run `./install.sh` (same behavior, plus
`--init`, `--project`, `--uninstall`). Requires Node.js ≥ 18. The skill itself
has zero npm dependencies.

## Quick start

After `npx archgen-skill init`, open your project in any supported agent and talk
naturally:

| You say | What runs |
| --- | --- |
| *"generate architecture for a booking platform"* | Interview → artifacts → both gates |
| *"add rate-limiting to my API server"* | Survey existing code first, then plan + gates |
| *"start work"* | Autonomous wave execution until done or blocked |
| *"roll back the auth changes"* | Impact analysis → reverse-order revert plan → approval |

Everything archgen produces lives in one reviewable `.archgen/<slug>/` folder —
architecture contract, docs, ADRs, plans, and a `tasks.yaml` task graph — versioned
by git.

## Commands

| Command | What it does |
| --- | --- |
| `npx archgen-skill init [dir]` | Prepare a project: canonical skill store at `.agents/skills/archgen`, Claude symlink adapter, AGENTS.md hub + CLAUDE.md bridge |
| `npx archgen-skill install [--copy]` | Install into global harness skill dirs (symlinks by default, real copies with `--copy`) |
| `npx archgen-skill uninstall` | Remove globally-installed copies (manifest-recorded, safe removal) |
| `npx archgen-skill uninstall --project [dir]` | Remove a project install: strips managed blocks, symlink, and store **only if unmodified** — `.archgen/` feature folders and all user content are preserved |
| `npx archgen-skill doctor [dir] [--check]` | Verify and auto-repair an installation: store integrity, version stamp, Claude link, managed blocks, manifest (`--check` reports without fixing) |
| `npx archgen-skill update [dir]` | Check npm for a newer `archgen-skill`, upgrade the global install if outdated, then re-init the project and run doctor against the new version |
| `npx archgen-skill restore` | List backup snapshots; `--snapshot <ts>` restores one (current state is backed up first) |
| `npx archgen-skill migrate [dir] [--apply]` | Evolve generated-artifact formats in place (`--check` by default; every touched file is backed up) |
| `npx archgen-skill --version` / `--help` | Print the CLI version / show help |

## Why archgen

AI coding agents fail at scale for predictable reasons: plans with hidden cycles,
workers editing the same files, tasks without objective acceptance criteria, and no
human checkpoint before execution. archgen makes each of these a *structural*
guarantee:

| Guarantee | Mechanism |
| --- | --- |
| Plans are valid before work starts | Verifier gate — cycles, dangling refs, ownership overlaps, plan↔task coverage |
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

Claude Code, OpenCode, Cursor, Codex, Gemini CLI, Antigravity — and any
agentskills.io-compatible harness. Both global install and project-local `init`
are supported for all of them.

## VS Code extension (optional)

A read-only visual layer that renders `.archgen/` as a live task DAG, your
code-dependency graph, and rendered docs — with a ▶ button that hands any task to
your agent. Install it from the VS Code Marketplace or from a `.vsix` on
[GitHub Releases](https://github.com/akashmaurya99/archgen/releases). It never
edits anything: uninstalling it loses nothing.

## Documentation

| Doc | Contents |
| --- | --- |
| [Architecture walkthrough](https://github.com/akashmaurya99/archgen/blob/main/docs/architecture.md) | Dual-mode design, gates, wave mechanics, platform detection |
| [The skill contract](https://github.com/akashmaurya99/archgen/blob/main/skill/SKILL.md) | The full skill specification agents execute |
| [Changelog](https://github.com/akashmaurya99/archgen/blob/main/CHANGELOG.md) | Release history |

## Contributing

See [CONTRIBUTING.md](https://github.com/akashmaurya99/archgen/blob/main/CONTRIBUTING.md).
Skill suite and CLI tests run with zero dependencies:

```sh
node --test skill/scripts/test/*.test.mjs   # skill suite
cd packages/cli && npm test                 # CLI suite
```

## License

[MIT](https://github.com/akashmaurya99/archgen/blob/main/LICENSE) © ArchGen contributors
