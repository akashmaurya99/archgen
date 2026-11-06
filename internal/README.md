# internal/ — repo-only QA tooling, NEVER shipped

Nothing in this directory reaches users. It is not synced by
`packages/cli/scripts/sync-vendor.mjs`, not installed by `install.sh` /
`packages/cli`, and not matched by the npm `files` list. It exists so the
skill can be measured and hardened in CI without taxing every installation.

## tools/

- `context-budget.mjs` — measures the skill payload, the MCP tool catalog and
  `.archgen/<slug>/` artifacts, and reports them as a percentage of
  32k / 64k / 128k / 200k / 1M context windows. Run:
  `node internal/tools/context-budget.mjs --project . --json`
  - `--max-always-on <n>` is a HARD GATE: it fails when SKILL.md + the MCP
    tool catalog — what the agent pays before it does anything — exceeds the
    ceiling. CI runs it, so the always-on context can never silently grow.
  - The catalog is measured from the LIVE server (`archgen-mcp --catalog`),
    never from a hand-written copy, so the number cannot drift from reality.
- `tokens.mjs` — the zero-dependency token estimator shared by the budget
  tool and the internal harness tests. Approximate (±10%); `--tokenizer <pkg>`
  swaps in an exact tokenizer when one is installed.
- `repo-immutable.mjs` — proves the test suites never mutate the repository.
  A suite that silently deletes a tracked file looks like a green run, so this
  gate runs the suites and diffs the tracked-file hashes before/after.

## test/

Node:test integration suites for the internal tools. Run with
`npm run test:internal`, or as part of `npm test`.

## Rules

- No file under `internal/` may be imported by anything under `skill/`,
  `packages/mcp/src`, `packages/cli/vendor`, or `packages/cli/{bin,lib}` (all
  ship). The reverse is fine: a dev tool may import shipped code.
- Anything that must ship lives under `packages/mcp/src` (the runtime) or
  `skill/` (the guidance) and ships in the next release.
- If a tool graduates to user-facing, move it into `packages/mcp/src/` (with
  its tests under `packages/mcp/test/`) or into `skill/`, and re-run
  `npm run sync`.
