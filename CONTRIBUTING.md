# Contributing to ArchGen

Thanks for your interest in contributing! This repository is a small monorepo:

```
skill/              the archgen agent skill (canonical source of truth)
packages/cli/       `archgen-skill` npm CLI (init / install / uninstall)
packages/extension/ VS Code extension (DAG, code-graph, docs views)
fixtures/           deterministic end-to-end drivers + shared YAML corpus
schemas/            JSON schema + architecture conventions
```

## Setup

- Node.js >= 18 (no other global tooling required)
- `git clone` the repo; there are no dependencies to install for the skill
  itself. The CLI and extension install their own deps via npm when needed.

## Running tests

Fast path from the repo root — one setup, one command for everything CI runs:

```sh
npm run setup   # once — installs extension dependencies
npm test        # skill + CLI + extension (typecheck + compile + vitest)
```

Each package also has its own suite — run all of them before opening a PR
(CI runs the same set):

```sh
# skill (node:test, no deps)
node --test skill/scripts/test/*.test.mjs

# CLI
cd packages/cli && npm test

# VS Code extension (typecheck + compile + vitest)
# Extension tests require Node 22 (better-sqlite3 + vitest pools are
# unstable on Node 20; the shipped extension runs in VS Code's Electron
# runtime, so this constrains tooling only):
cd packages/extension && npm ci && npm run typecheck && npm run compile && npm test

# Parser↔view-model parity vs the greenfield-demo fixture (CI: cross-mode job)
cd packages/extension && npm run cross-mode

# Version single-source + vendor-freshness gate (CI: vendor-check job) —
# run after ANY skill/ or archgen.config.json edit
npm --prefix packages/cli run sync:check
```

## Fixture drivers

`fixtures/*/run.sh` are deterministic end-to-end drivers that exercise the real
scripts with zero LLM calls (greenfield generation, brownfield survey, verifier
negative cases). Run them from the repo root:

```sh
bash fixtures/greenfield-demo/run.sh
bash fixtures/brownfield-demo/run.sh
bash fixtures/verifier-negative/run.sh
```

`fixtures/yaml-corpus/` is a shared corpus consumed by BOTH the skill's parser
(`skill/scripts/lib/yaml.mjs`) and the extension's TS port. If a corpus test
fails, the two parsers have diverged — fix both together and never adjust
expected outputs unilaterally.

## Pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) messages
  (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).
- All gates must pass locally before you open a PR (CI runs the same set).
- Keep changes atomic: one concern per PR.
