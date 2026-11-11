# Contributing to ArchGen

Thanks for your interest in contributing! This repository is a small monorepo:

```
skill/              the archgen agent skill — orchestration guidance, NO code
packages/mcp/       `archgen-mcp` — the MCP server (owns every capability)
  src/core/         the implementations + the canonical assets they read
  assets/           registries · templates · briefs · the protocol references
packages/cli/       `archgen-skill` npm CLI (init / install / uninstall) — zero-dep
internal/           repo-only QA tooling (token budget, estimators) — never shipped
fixtures/           deterministic end-to-end drivers + shared YAML corpus
schemas/            JSON schema + architecture conventions
```

### Where things live

| Thing | Home | Why |
|---|---|---|
| The skill prompt | `skill/SKILL.md` | the harness must load it as a skill file |
| The code rules workers read | `skill/references/code-standards.md` | workers may have no MCP tools — it must be a plain file |
| The orchestrator protocols | `packages/mcp/assets/references/` | served by `archgen_refs`; always the same version as the tools they describe |
| Every registry, template and brief | `packages/mcp/assets/` | the tool and its data ship together |
| All capability logic | `packages/mcp/src/core/` | one implementation, reached by the agent and the CLI |

## Setup

- Node.js >= 20 (the official MCP SDK v2 floor; Node 18/20 are EOL)
- `git clone` the repo. The skill itself has no dependencies and no code; the
  CLI is zero-dependency too. The MCP server installs its own deps via npm
  (`npm run setup` does it).

## Running tests

Fast path from the repo root — one setup, one command for everything CI runs:

```sh
npm run setup   # once — installs the MCP server's dependencies
npm test        # internal (QA) + MCP + CLI
```

The suites must never mutate the repository. `npm run test:immutable` proves
it (CI runs it as the `immutable` job) — a suite that silently deletes a
tracked file looks like a green run, so this gate is not optional.

The internal QA suite (`npm run test:internal`) covers `internal/`, which
never ships — use it to measure context cost of any skill/artifact change.
Anything under `internal/` must never be imported by shipped code (MCP
server, CLI, vendor mirror).

Each package also has its own suite — run all of them before opening a PR
(CI runs the same set):

```sh
# MCP server — the runtime that owns every capability (node:test)
cd packages/mcp && npm ci && npm test

# CLI — zero-dependency
cd packages/cli && npm test

# Version single-source + vendor-freshness gate (CI: vendor-check job) —
# run after ANY skill/ or archgen.config.json edit
npm --prefix packages/cli run sync:check
```

## Fixture drivers

`fixtures/*/run.sh` are deterministic end-to-end drivers that exercise the REAL
archgen MCP tool surface (`archgen-mcp exec …`) with zero LLM calls (greenfield
generation, brownfield survey, verifier negative cases, and the full tool
matrix). Run them from the repo root:

```sh
bash fixtures/greenfield-demo/run.sh
bash fixtures/brownfield-demo/run.sh
bash fixtures/verifier-negative/run.sh
bash fixtures/tool-matrix/run.sh
```

`fixtures/yaml-corpus/` is the frozen contract for archgen's YAML subset: each
`*.yaml` has a committed `*.expected.json` sibling holding the parsed data, the
comment ledger, or the expected error. The corpus is pinned against the
CANONICAL parser by `packages/mcp/test/core/yaml-corpus.test.mjs` — if a corpus
test fails, the parser drifted: fix the parser and never adjust an expected
output unilaterally.

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) messages
  (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- All gates must pass locally before you open a PR (CI runs the same set).
- Keep changes atomic: one concern per PR.
- Never commit a real `.codegraph/` index or an `.archgen-version` stamp — both
  are local state. CI's vendor-check refuses any tracked `.codegraph/`.
- Optional: `git config core.hooksPath .githooks` enables the pre-commit
  sync drift check.

## Hard rules for shipped code

- The skill ships NO code and has zero npm dependencies. The CLI is
  zero-dependency too. Only `packages/mcp` depends on anything (the official
  MCP SDK + Zod).
- `internal/` is import territory: shipped code never imports from it.
- Everything in `packages/mcp/src/core/` ships — keep comments minimal (WHY
  only), output lean, and runtime deterministic.
- One implementation per capability: the MCP server owns it, and the CLI
  reaches it through the server — never a second copy.
- **The skill declares what the server it needs** (`metadata.requires.archgen_mcp`
  in `skill/SKILL.md`). `npm run test:contract` proves the declaration is
  satisfiable by this release — bump both together or the gate fails.
- **The tool catalog is a permanent context tax.** Every client injects every
  tool's schema into the model's context on every request. `npm run test:budget`
  caps the always-on total (SKILL.md + catalog); run it after touching a tool
  description, an argument, or the skill.
- `.codegraph/` indexes are machine-local; they may be committed for team
  projects ONLY when the team deliberately opts in.

## Testing an unpublished build

A build that is not on the registry cannot be tested with `npx
archgen-skill init` — that installs the PUBLISHED packages. One command
installs this checkout into a project instead:

```sh
scripts/install-local.sh <project-dir>            # MCP wired globally (the default)
scripts/install-local.sh <project-dir> --location-project   # MCP wired into the project
scripts/install-local.sh <project-dir> --check    # report what is installed, change nothing
```

It points the skill at this repo's vendored copy and the MCP entry at this
repo's server (`ARCHGEN_MCP_BIN`), so the client drives the code you just
built. Nothing is published, and the global `archgen-mcp` install is left
exactly as it is.

**Restart the client session afterwards.** A client validates a call against
the tool catalog it was given when the session connected; a session that
predates the upgrade rejects a valid action. `archgen_setup{action:'doctor'}`
reports `serverActions` — the action list the running server offers — so the
two can be compared in one call.

To revert the wiring: `packages/mcp/bin/archgen-mcp.mjs uninstall-mcp --yes`.
