# Contributing to ArchGen

Thanks for your interest in contributing! This repository is a small monorepo:

```
skill/              the archgen agent skill — orchestration guidance, NO code
packages/mcp/       `archgen-mcp` — the MCP server (owns every capability)
  src/core/         the implementations, grouped by domain:
    protocol/       the vocabulary every tool speaks (errors, codes, hints)
    plan/           the plan of record — audit, coverage, graph, waves
    docs/           prose artifacts, briefs, worker contracts
    skill/          capability-skill discovery, install, registry
    harness/        MCP wiring, platform capability tables, CodeGraph
    fs/             the only layer that touches disk — containment, YAML, JSONC
  assets/           registries · templates · briefs · the protocol references
packages/cli/       `archgen-skill` npm CLI (init / install / doctor / update / restore / migrate / uninstall) — zero-dep
internal/           repo-only QA tooling (lint / release / budget / safety) — never shipped
fixtures/           deterministic end-to-end drivers + shared YAML corpus
schemas/            the architecture.yaml conventions (the task schema ships in packages/mcp/schemas/)
```

### Where things live

| Thing | Home | Why |
|---|---|---|
| The skill prompt | `skill/SKILL.md` | the harness must load it as a skill file |
| The code rules workers read | `skill/references/code-standards.md` | workers may have no MCP tools — it must be a plain file |
| The orchestrator protocols | `packages/mcp/assets/references/` | served by `archgen_refs`; always the same version as the tools they describe |
| Every registry, template and brief | `packages/mcp/assets/` | the tool and its data ship together |
| All capability logic | `packages/mcp/src/core/` | one implementation, reached by the agent and the CLI |

### The layers inside `src/core/`

`core/` is split by DOMAIN, not by size. The dependency direction is
deliberate and one-way:

```
protocol/  ←  fs/  ←  plan/  docs/  skill/  harness/
```

- **protocol** — the vocabulary: error codes, the envelope contract, the
  teaching hints, argument routing. Everything else imports it; it imports
  nothing but itself.
- **fs** — the only layer that touches disk: containment, YAML, JSONC. Like
  protocol, it imports nothing above it.
- **plan / docs / skill / harness** — the four domains that use the two
  bottom layers.

A new file goes in the domain it belongs to. If it fits none of them, that
is a signal about the design, not about the folders — ask before adding a
seventh.

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
CANONICAL parser by `packages/mcp/test/fs/yaml-corpus.test.mjs` — if a corpus
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
- **A new core file goes in its domain folder** (`protocol/`, `plan/`,
  `docs/`, `skill/`, `harness/`, `fs/`). `npm run test:structure` fails when
  a directory grows past the size it was laid out for, so the flat row this
  replaced cannot come back.
- **One implementation per rule.** If a helper is needed in two files, it
  lives in one place and is imported. `structure-lint` reports a helper
  copied VERBATIM into two files — the shape a copy-paste takes.
- **A source file opens with a header comment** saying what it owns and why
  it exists. `structure-lint` fails a file that has none.
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
