# internal/ — repo-only QA tooling, NEVER shipped

Nothing in this directory reaches users. It is not synced by
`packages/cli/scripts/sync-vendor.mjs`, not installed by `install.sh` /
`packages/cli`, and not matched by the npm `files` list. It exists so the
skill can be measured and hardened in CI without taxing every installation.

## tools/

- `context-budget.mjs` — measures the skill payload and `.archgen/<slug>/`
  artifacts and reports them as a percentage of 32k / 64k / 128k / 200k / 1M
  context windows. Run:
  `node internal/tools/context-budget.mjs --project . --json`
- `tokens.mjs` — the zero-dependency token estimator shared by the budget
  tool and the internal harness tests. Approximate (±10%); `--tokenizer <pkg>`
  swaps in an exact tokenizer when one is installed.

## test/

Node:test integration suites for the internal tools (kept here so the
skill's dev suite in `skill/scripts/test` remains exclusively about shipped
runtime behaviour). Run with `npm run test:internal`, or as part of
`npm test`.

## Rules

- No file under `internal/` may be imported by anything under `skill/`,
  `packages/cli/vendor`, or `packages/cli/{bin,lib}` (all ship).
- Anything that must ship lives under `skill/` and ships in the next release.
- If a tool graduates to user-facing, move it into `skill/scripts/` and its
  tests into `skill/scripts/test/`, and re-sync the vendor mirror.
