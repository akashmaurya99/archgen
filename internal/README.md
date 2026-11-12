# internal/ — repo-only QA tooling, NEVER shipped

Nothing in this directory reaches users. It is not synced by
`packages/cli/scripts/sync-vendor.mjs`, not installed by `install.sh` /
`packages/cli`, and not matched by the npm `files` list. It exists so the
skill can be measured and hardened in CI without taxing every installation.

## tools/ — grouped by what a tool is FOR

The tools are grouped by purpose, so a new contributor can find the gate
they care about without reading all nine:

```
tools/
├── lint/      the gates that fail the build on a defect
├── release/   preparing a release
├── budget/    measuring what the context costs
└── safety/    proving the suites do not mutate the repository
```

### lint/ — gates that fail the build on a defect

- `teaching-lint.mjs` — every failure site in `packages/mcp/src` teaches its
  next call. Run: `node internal/tools/lint/teaching-lint.mjs`
- `version-lint.mjs` — no release version is pinned in an ILLUSTRATIVE
  surface (a comment or example must show the shape, not a release).
- `version-consistency.mjs` — every version SURFACE agrees with
  `archgen.config.json`, and the version lives in exactly one place. The
  surfaces are DISCOVERED by rule over the tracked files, so a new package
  is covered the moment it is committed.
- `check-capability-contract.mjs` — the skill declares the MCP server
  version it needs, and that requirement must be satisfiable by THIS
  release. An undeclared dependency is a latent outage.
- `structure-lint.mjs` — the repository's SHAPE must stay clean. Every other
  gate checks what the code DOES; this one checks what it LOOKS LIKE:
  - **S1** no NUL byte in a tracked file — one had made a source file read
    as BINARY to grep, `file` and every editor
  - **S2** no `node_modules` inside a package's source — the CLI is
    zero-dependency, so one can only be a stray install, and it sits FIRST
    on Node's module-resolution path (a stale v0.1.3 copy of the server
    once sat under `packages/cli/lib/`)
  - **S3** every source file has a header comment
  - **S4** no helper copied VERBATIM into two files of one package
  - **S5** every relative import resolves to a file that exists
  - **S6** no directory holds more than 20 files — the drift this whole
    reorganisation exists to stop
  Run: `node internal/tools/lint/structure-lint.mjs`. The gate's own tests
  are in `internal/test/structure-lint.test.mjs`: they build a scratch
  repository with ONE defect in it and assert the gate reports THAT
  defect, because a gate that cannot fail is a gate whose behaviour nobody
  knows.
- `tracked-files.mjs` — the shared reader for "the files this repository
  contains". Git is the source of truth, not the working tree: an
  untracked local artifact is machine state, and a gate that fires on the
  machine it runs on is a gate that gets ignored.

### release/

- `release-prepare.mjs` — bumps the canonical version, propagates it to every
  derived surface, regenerates the lockfiles, and runs every gate. It never
  publishes and never tags; that stays a human action.

### budget/ — measuring what the context costs

- `context-budget.mjs` — measures the skill payload, the MCP tool catalog and
  `.archgen/<slug>/` artifacts, and reports them as a percentage of
  32k / 64k / 128k / 200k / 1M context windows. Run:
  `node internal/tools/budget/context-budget.mjs --project . --json`
  - `--max-always-on <n>` is a HARD GATE: it fails when SKILL.md + the MCP
    tool catalog — what the agent pays before it does anything — exceeds the
    ceiling. CI runs it, so the always-on context can never silently grow.
  - The catalog is measured from the LIVE server (`archgen-mcp --catalog`),
    never from a hand-written copy, so the number cannot drift from reality.
- `tokens.mjs` — the zero-dependency token estimator shared by the budget
  tool and the internal harness tests. Approximate (±10%); `--tokenizer <pkg>`
  swaps in an exact tokenizer when one is installed. It RE-EXPORTS the MCP
  server's estimator, so the number the CI gate prints and the number the
  server reports are the same number.
- `measure-outputs.mjs` — measures the size of the server's own outputs.

### safety/

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
- A tool in `tools/<group>/` resolves the repository root by climbing from
  its OWN directory. When a tool moves, that climb must move with it — the
  failure looks like "the corpus is empty" rather than "the path is wrong",
  so it is easy to misread.
