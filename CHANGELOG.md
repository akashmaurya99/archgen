## [0.1.8] - UNRELEASED

The release machinery release: the test suite runs on every supported Node
version, the budget gate measures the SAME number everywhere, and the publish
workflow uses npm's trusted publishing instead of a token that cannot publish.

### Fixed — the test suite could not run on Node 22+

`node --test test/` works on Node 20 and BREAKS on Node 22+: a positional
argument became a GLOB, so `test/` matched the DIRECTORY and the runner
tried to execute it as a module —

    Error: Cannot find module '.../packages/cli/test'

— on every Node 22 and 24 runner. The CLI job and the immutable job failed
on every push, and had been failing since 0.1.6. The suites now use the
DISCOVERY form (`node --test`), which is portable across Node 20, 22 and 24,
and the CI matrix carries all three versions — a matrix that tests one
version tests one version's semantics.

### Fixed — the budget gate SILENTLY dropped its largest term on Node 20

`process.stdout.write` to a PIPE is asynchronous on Node 20, and a process
that writes a large payload and exits can lose the tail. The budget tool read
a TRUNCATED 17KB tool catalog as 8KB of invalid JSON, reported `the MCP tool
catalog is not valid JSON`, and then measured the always-on cost WITHOUT the
largest term — on a supported Node version, with the gate still green.

Every large payload now goes through `fs.writeSync` (`core/protocol/io.mjs`,
`packages/cli/lib/io.js`): the bytes are in the pipe before the process can
exit, on every version. The measured always-on figure is now identical on
Node 20, 22 and 24 — and it is the honest one.

### Fixed — the publish workflow could not use npm's trusted publishing

npm uses TRUSTED PUBLISHING only when NO auth token is present: a
`NODE_AUTH_TOKEN` in the environment makes npm prefer the token and IGNORE the
trusted publisher. The workflow set the token whenever the secret existed, so
the OIDC exchange never happened — and a classic token with 2FA enabled
cannot publish from CI at all:

    npm error code EOTP
    npm error This operation requires a one-time password.

The workflow now publishes via OIDC FIRST (no token in the environment) and
falls back to the token only if that fails. The error message names the real
cause (`EOTP` vs `ENEEDAUTH`/`401`/`E403`) and the one-time fix on npmjs.com:
Package → Settings → Trusted Publishers → GitHub Actions, repository
`akashmaurya99/archgen`, workflow `publish-npm.yml`.

### Added — the publish workflow refuses to republish a version

npm never overwrites a published version, and the refusal arrives as a bare
403 that reads like a credential problem. The workflow now checks the
registry FIRST and says `archgen-mcp@0.1.7 is ALREADY on the registry —
nothing was published`.

### Fixed — a global install landed INSIDE the package it was installing for

`npm install -g` installs into the global prefix — unless the environment says
otherwise, and npm sets `npm_config_prefix` whenever it runs a script with
`--prefix` (and `npx` sets it too). Under `npm --prefix packages/cli test` —
exactly what CI runs — a global CodeGraph install landed in

    packages/cli/lib/node_modules/@colbymchenry/codegraph

inside the package it was supposed to install FOR, where nothing can find it
and every later run reports a missing server. The same leak affected the
MCP server's CodeGraph install.

A global install now strips the prefix variables (`npm_config_prefix` and
its camel-cased, upper-cased and globalconfig spellings) so npm falls back
to the real global prefix. The rest of the environment survives — a global
install still needs `HOME` and the user's npmrc.

### Added — `mcp add` can wire one side only

`archgen-skill mcp add` gains `--no-codegraph` and `--no-mcp`, so an operator
can wire ONLY the MCP server, or ONLY CodeGraph. Both flags are forwarded to
the server's bootstrap, where they already existed — the CLI could not reach
them. `--no-codegraph` also keeps the command OFFLINE and side-effect free:
without it the bootstrap ENSURES CodeGraph, and on a machine without
CodeGraph that is a real global install.

## [0.1.7] - 2026-11-13

A correctness release: the catalog is smaller AND correct, every section says
what it is FOR, "no quality loss" is a CI fact instead of a promise, and the
artifacts are written in the order their content depends on.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.7` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.7` |

### Added — the control plane / data plane split

The server now publishes a **PROFILE**, and the profile is a privilege
boundary.

- `lean` (the default) publishes eight tools: `archgen_plan`, `archgen_tasks`,
  `archgen_docs`, `archgen_registry`, `archgen_skills`, `archgen_refs`,
  `archgen_help`, `archgen_platform`.
- `full` adds the admin tools `archgen_setup` and `archgen_codegraph` — the
  ones that install software and write harness configuration. Their approval
  flag is an ARGUMENT the model supplies, so they are no longer published to a
  model that reads untrusted repositories.
- `ARCHGEN_TOOL_PROFILE` (or `--tool-profile`) selects the profile; an unknown
  value is refused, never silently defaulted.

The admin handlers stay registered, so nothing is lost: `archgen-mcp exec
archgen_setup …` and the new CLI commands (`archgen-skill mcp
add|remove|list`, `archgen-skill codegraph ensure|wire|status`) reach exactly
the same code. The CLI prints the PLAN without `--yes` and writes only with
it.

### Added — `archgen_platform`: the runtime facts, read-only

The old `archgen_setup{action:'harness_info'}` answered one question — which
harness is this — with the whole registry, and it came bundled with the
ability to install software. `archgen_platform` answers it alone, read-only,
and compactly: the detected harness, its skill paths, its MCP config path and
key, its restart semantics, its sub-agent dispatch, and whether the project has
a CodeGraph index.

### Added — the CodeGraph policy: a first-time install, the whole tool surface, telemetry off per process

`packages/mcp/assets/codegraph-policy.json` owns five facts that used to be
scattered: the package, what a **first-time install** fetches, the exact spec
the **npx fallback** uses, the **tools the agent may call**, and the telemetry
posture.

- **Install ONCE, never upgrade.** When the CodeGraph CLI is missing, the
  first-time install fetches the newest published release — CodeGraph's own
  official install path. When it is already there, ArchGen installs nothing,
  upgrades nothing and rewrites nothing: an installed CodeGraph may be pinned,
  may be a bundle install, and it is the user's to manage (`codegraph upgrade`
  is theirs to run).
- **The npx fallback stays pinned** (`@colbymchenry/codegraph@1.6.2`): a
  machine with no binary still resolves a reviewed version, instead of
  executing whatever `latest` became.
- **The whole CodeGraph surface is in the agent's hands.** CodeGraph publishes
  ONE MCP tool by default (`codegraph_explore`); the other seven exist and
  stay unlisted because each listed tool costs permanent context. The policy
  wires the allowlist `explore,node,search,callers,callees,impact,files,status`
  — and `§platforms/codegraph-tools` maps every question to exactly one tool
  (`explore` first, `search` for exact locations, `node` for one symbol or
  file, `callers`/`callees`/`impact` for a change's blast radius, `files` for
  layout, `status` for index health), so eight tools do not become eight
  guesses.
- Telemetry is turned off **per process** (`CODEGRAPH_TELEMETRY=0` in the MCP
  entry) instead of by a machine-wide `codegraph telemetry off` write.
- The wiring is CONVERGENT: an entry without the allowlist or with an
  unpinned spec is a pending rewrite, and the next ensure brings it forward.
- The worker contract now names the CLI equivalents (`codegraph explore`,
  `codegraph query`, `codegraph node`, `codegraph impact`) — sub-agents never
  see the MCP server's guidance.

### Changed — the catalog is measured HONESTLY

`npm run test:budget` now speaks JSON-RPC to the real binary and measures
what `tools/list` actually returns. The old measurement (name + description +
input schema) under-counted by ~34% because it never saw the output schema or
the annotations, and it never counted the CodeGraph server's tools at all.

- The per-tool output schema is now the compact `{ok}` shape; the full
  envelope schema is published ONCE, as the MCP resource
  `archgen://schema/envelope`. Every tool description carries the envelope's
  shape where the model reads it.
- The always-on ceiling moved from 13,800 to 18,000 — a HIGHER number, because
  the measurement is honest now: the old figure under-counted by ~2,500
  tokens and never counted CodeGraph's own catalog at all. The measured total
  moved UP with it (13,503 → 17,459), and the ceiling still sits above it —
  the estimator is ±10%, so the gate keeps a margin and still fails when the
  always-on footprint grows past the line.

### Fixed — the catalog's routing was WRONG in six places

Every argument in the schema carried a hand-written parenthesis naming the
actions that read it, and six of them were wrong:

- `archgen_plan.collection` claimed four actions and belongs to **eight**;
- `archgen_docs.collection` claimed **one** and belongs to **six**;
- `archgen_plan.tasksYaml` and `.planDir` each omitted an action;
- `archgen_tasks.taskId` omitted two;
- `archgen_setup.telemetry` omitted one.

A model that trusted the parenthesis passed an argument the handler never
reads — and the handler IGNORES an unread argument, so the call SUCCEEDED and
the agent believed it had done something it had not.

The routing is now **generated** from the same per-action tables the handlers
use, and rendered once — in the tool description and in `archgen_help`. A
hand-written copy of a table is a copy that drifts; a generated one cannot.

### Added — every reference section says what it is FOR

`archgen_refs{action:'index'}` and `archgen_docs{action:'digest'}` now carry
a one-line **purpose** per section. The index used to carry a slug and a
title — enough to identify a section, not enough to CHOOSE one — so an agent
had to pull a section to learn what it held, and paid for every wrong guess.

The purpose is resolved in two steps: an authored one (a blockquote under the
heading) wins, and otherwise the section's first prose line is used, so a
section NEVER lacks one.

### Added — `archgen_refs` can return a whole subtree

`archgen_refs{action:'read', topic, section, include:'all'}` returns the
section AND its nested subsections in one call — the parity
`archgen_docs{action:'section', include:'all'}` has always had.

It mattered: `§orchestration/verifier` returned 71 tokens and named ten
children, and the agent had to make ten more calls to read the protocol it
had already been told to load.

### Fixed — the verify payload carried every finding twice

`archgen_plan{action:'verify'}` returned the findings at the top level AND
inside `audit`, because the audit's findings are pushed into both. On a
broken 120-task plan that was 40 findings, twice, in one payload, for nothing.

The audit now carries the MAPS, the waivers and the snapshot; the counts and
the per-class codes stay, because they are exact while the lists are a sample.

### Fixed — the two gate briefs could not disagree, because there is only one

The verifier and the review briefs each restated the same protocol — the
three finding classes, the three-part BLOCKING test, the two-round cap. They
had already begun to differ in wording, and the next edit would have made
them differ in MEANING.

The shared rules now live in ONE file (`assets/briefs/_gate-protocol.md`)
and are pasted into each brief at load time. The rendered brief is still
self-contained — the gate agent never has to know a fragment exists.

### Changed — the references point at the tools instead of restating them

The repo's own rule — *"the references point at the tools; they never restate
a tool's output"* — was not fully applied. Four sections restated what the
agent already had from a tool:

- the depth budgets restated the `depth` block `profile` returns;
- the answers-file format restated the skeleton `scaffold` serves;
- the MCP key vocabulary restated the registry `harnesses` reads;
- the skill registry restated the entries `archgen_skills{action:'list'}` returns.

Each is now a pointer to the tool that owns the fact. The drift gate that
watched the key vocabulary was **inverted and strengthened**: the registry
owns the keys, and the reference must not carry a second copy.

### Added — the claim ledger: "no quality loss" as a CI fact

`internal/claims/skill-claims.json` records ~280 atomic obligations the
shipped guidance owes the agent — every hard-rule title, prohibition, `§`
marker, error code, coverage dimension, BLOCKING clause, YAML rule and gate
rule — with a stable id and a matcher written against the obligation's
load-bearing WORDS, not a whole sentence.

`packages/mcp/test/skill/skill-claim-ledger.test.mjs` checks every one of
them. A claim may be REWORDED freely; it may not DISAPPEAR, and it may not
WEAKEN. Deleting an obligation deletes its claim in the same commit, and
that diff is the record.

`packages/mcp/test/protocol/schema-routing.test.mjs` does the same for the
catalog: the property list, the enum values, the required arguments, the
annotations and the per-action routing tables are pinned exactly, and every
argument's description must still carry the facts it carried.

### Changed — the always-on payload is smaller

| | before | after |
|---|---|---|
| `SKILL.md` | 7,916 | 7,813 |
| MCP tool catalog — the real `tools/list` payload | 5,587 | 5,850 |
| CodeGraph's own catalog | — | 3,796 |
| **ALWAYS-ON** (all three) | **13,503** | **17,459** |
| protocol references | 19,168 | 20,751 |
| dispatch briefs | 4,236 | 4,069 |

The catalog is at its floor: most of it is the JSON Schema of its 76
arguments, and the flat shape is load-bearing (the `ARG_IGNORED` warning is
what catches a wrong-action call). What changed is that the schema is now
CORRECT, and the SKILL.md no longer restates protocols its references already
own.

The budget ceiling moves with it: `--max-always-on` 13,800 → **18,000**. The
figure is the honest measurement's, not the projection's, and it keeps a
margin over the measured 17,459 (the estimator is ±10%), so the gate still
fails when the always-on footprint grows past it.

### Changed — the skill teaches what the tools can do

`archgen_plan{action:'scaffold'}` returns every skeleton at once — 7,428
tokens. The tool already served ONE file per call; the skill never said so.
It does now, and the mode table names `§artifact-templates/mechanical-invariants`
— the section that owns the checklist the skill used to restate — so the
invariants are loaded before the tasks are written, not after.

### Fixed — the tool published the WRONG write order as fact

The scaffold served the create set in the ladder's RULE order, and that order
put `tasks.yaml` **first** — before the PRD whose `FR-<MODULE>-nn` ids its
acceptance lines must cite, and before the `architecture.yaml` whose
`owns[]` its `file_ownership` globs must mirror. A LARGE greenfield plan was
served as:

```
tasks.yaml → plans/<slug>.md → answers.yaml → docs/prd.md → architecture.yaml → …
```

Four hard inversions. The dependency graph was not absent — it was implicit,
inverted, and unaudited, and every one of them is a content inconsistency the
moment the file is written.

The edges are **data** now (`dependsOn` in `depth-ladder.json`), and the
order is **derived** from them at runtime — never stored, so the two cannot
disagree. The chain is:

```
codebase-map.md → answers.yaml → docs/prd.md → architecture.yaml
                 → decisions/0001-*.md → docs/<module>.md + docs/mermaid-snippets.md
                 → tasks.yaml → plans/<slug>.md
```

Each edge carries the fact that must pass forward ("the `FR-<MODULE>-nn` ids
the acceptance lines cite"), so the agent is told WHAT to carry, not only
WHEN. An omitted dependency **dissolves**; a reused one is satisfied by the
host document.

### Added — the one-file cursor refuses a file whose dependency does not exist

`scaffold{file}` now checks the artifact space on disk. A missing **hard**
dependency is a refusal that teaches the unblocking call (`teach` + `hint`,
the shape every archgen failure uses); a missing **soft** one is reported in
the payload. A plan can no longer be written out of order — and the floor
still proves the joins afterwards (`REQ_UNKNOWN`, `PATH_UNOWNED`,
`DECISION_MISSING`, `PLAN_TASK_COVERAGE`), one round later than it should
have.

### Added — the floor proves the per-task plan section

The class contract says a MEDIUM/LARGE plan carries one heading per task.
The floor proved only that a task id appears **somewhere** in the plan text,
so a plan that mentioned `T9` in passing — and had no `T9` section — passed,
and the worker contract then pointed at a section that did not exist.

`PLAN_TASK_SECTION_MISSING` (an issue) and `PLAN_TASK_TITLE_DRIFT` (a
warning — a paraphrase is not a defect) close it, at MEDIUM/LARGE with a
recorded scope class.

### Fixed — the provenance migration stamped two of the three YAML artifacts

The reference told the agent to stamp `tasks.yaml`, `architecture.yaml` **and
`answers.yaml`**; `npx archgen-skill migrate` scanned only the first two, so
a plan written before the convention existed kept an unstamped `answers.yaml`
forever. All three are scanned now.

### Changed — the skill states the order, and the data states the reason

`skill/SKILL.md` says the create set is written in the scaffold's
`writeOrder`; the reference explains the dissolve/reuse semantics and points
at the tool instead of restating the order. The always-on context grew by
The always-on context barely moved — the order itself is tool output, so it
costs nothing on every request. Measured now: `SKILL.md` 7,813 · the real
`tools/list` catalog 5,850 · CodeGraph's catalog 3,796 · **always-on 17,459**
against an 18,000 ceiling.

## [0.1.6] - 2026-11-11

A contract release: the reference rule is the skill's path rule, every
continuation keeps its scope, and every answer describes the collection it
actually returned.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.6` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.6` |

### Fixed — references resolve by the skill's path rule

`archgen_docs{action:'validate'}` resolved EVERY path-like reference against
the referencing document and required it to land inside the artifact space.
The skill mandates **repo-root-relative paths** — and the profile hands out
exactly that form (`.archgen/<slug>/architecture.yaml`) — so the mandated
form was reported broken, in the very file the profile told the agent to
write it in.

The rule is now the skill's rule:

- a target starting with `./` or `../` is relative to the **document's own
  directory**, and must land inside the artifact space;
- any other target is relative to the **project root**;
- a project-root path that names an artifact of the artifact space must
  exist;
- a project-root path **outside** it is a repository path or an **output
  declaration** — a file the plan will create — and is not broken for not
  existing yet.

Each finding now carries the rule it was judged by, so the repair loop needs
no source reading.

### Fixed — every continuation keeps its scope, and every answer describes itself

- `archgen_codegraph` reported the PAGE as the total and published no
  continuation: the tail of the detected harnesses was unreachable.
- `archgen_setup{action:'harnesses'}` dropped `location` from its cursor, so
  the next page listed the global config path the caller had excluded.
- `archgen_plan{action:'verify'}` always described the ISSUES collection —
  even when the warnings were asked for — and its two collections had
  different window lengths, so one offset could not walk both.
- `archgen_plan{action:'scaffold'}`'s one-file cursor dropped the profile
  inputs, re-entering class mode and refusing the artifacts the profile had
  marked `create`.
- `collection` was silently ignored on every action that has no such
  collection. It is now a typed error everywhere.
- `archgen_tasks{action:'snapshot'}` answered `INTERNAL` for a missing file.

### Fixed — the floor judges the plan, not the spelling

- The mirrored-tree rule silently skipped a plan whose roots or globs were
  written `./src` — so it could reach `APPROVE` with no test tree at all.
- A waiver could silence an unrelated finding through a finding's DETAIL
  clause, and a bare `*` scope approved everything. Both are refused.
- A `reuse` host path that merely CONTAINED an `.archgen/` segment was
  rewritten and reported missing.
- LARGE carried two different "edge cases per task" numbers — one payload,
  two answers. The depth budget is now the only owner.

### Added — a way to test an unpublished build

A build that is not on the registry cannot be tested with `npx
archgen-skill init` — that installs the PUBLISHED packages. One command now
installs a checkout into a project instead:

```sh
scripts/install-local.sh <project-dir>              # MCP wired globally
scripts/install-local.sh <project-dir> --location-project   # MCP wired into the project
scripts/install-local.sh <project-dir> --check      # report only, change nothing
```

It points the skill at the checkout's vendored copy and the MCP entry at the
checkout's server (`ARCHGEN_MCP_BIN`), so the client drives the code that was
just built. Nothing is published, and the global `archgen-mcp` install is left
untouched.

### Fixed — an override no longer mutates the global install

The bootstrap refreshed the global npm install of `archgen-mcp` even when
`ARCHGEN_MCP_BIN` named the server to use — mutating a machine-wide install
nobody asked for, and failing for any build that is not published yet. An
override now means **"use this binary"**, and the global install is left
exactly as it is.

### Changed — the always-on ceiling

The reference rule and the collection contract live in the always-on kernel
and in the tool briefings. The always-on total moves **13,132 tokens**; the
documented CI ceiling stays **13,800**, keeping its ~5% margin.

## [0.1.5] - 2026-11-11

A small correctness release: the scope profile accepts the evidence an agent
actually has, and a rejected call is diagnosable in one call.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.5` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.5` |

### Fixed — the scope profile accepted only a count

`archgen_plan{action:'profile'}` took `modules` and `tasks` as **numbers**.
The arguments are named after the things they count, so an agent that had
already enumerated the modules and the tasks of a plan passed **the lists**
— and the schema refused them.

The tool now takes either: a number, or the list itself, whose length is the
count. The same evidence scores the same way either way, and the profile's
`next` call always carries the canonical number.

### Added — the doctor reports what the running server offers

A client caches the tool catalog it was handed when the session connected.
When the server is upgraded afterwards, the client keeps validating against
the old schema and rejects a valid action with the old allowed values — while
`doctor` (whose own action list never changed) reports the new server
version. The two facts read as a contradiction.

`archgen_setup{action:'doctor'}` now reports **`serverActions`** — the action
list the running server offers — so one call settles which side is stale.

### Changed — the always-on kernel says how to check the server

The bootstrap section now asks the agent to confirm the **server** (not just
the presence of a tool) and routes any rejected call through the doctor. It
also states plainly that a tool's output is never reconstructed from the
server's installed files.

The always-on total moves **13,164 tokens** and the documented CI ceiling
moves with it **13,600 → 13,800**, keeping the same ~5% margin over the
measured total that it has always had.

## [0.1.4] - 2026-11-11

A correctness release: four independent audit rounds swept every tool, every
skill file, every brief and every template, and **every defect they found was
fixed at the root** — the gate can now approve a plan the user has explicitly
waived, no bound hides its tail, and the always-on kernel says exactly what
the tools do.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.4` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.4` |

### Fixed — the floor could never approve a waived plan

Two independent audits swept every tool and every skill file and found the
same class of defect on both sides: **the documentation promised behaviour the
code did not have.** Every one of these is fixed at the root, and every one
is pinned by a test.

**The gate was unpassable.** A waiver suppressed nothing. Three references
said "a waived finding is not a defect to fix", but the floor read the ledger
and then ignored it — so a plan with an approved deviation could never reach
`APPROVE`. A waiver now **suppresses** the findings it covers (by code, or by
subject), the suppressed findings are reported separately so the deviation
stays visible, and a waiver missing `scope`/`finding`/`reason`/`approved_by`/
`approved_at` is `WAIVER_INVALID` and suppresses nothing.

**A recorded `create` decision could never be satisfied.** The ladder's paths
were literal placeholders (`decisions/NNNN-<title>.md`), so the floor compared
the placeholder against disk and reported `PROFILE_CREATE_MISSING` for the real
file while reporting `PROFILE_UNRECORDED` for the file that actually existed.
Decisions are now proved against **families** (`plans/*.md`, `decisions/*.md`,
`docs/prd.md`): the plan may name its files as it likes and the decision still
holds. A `reuse` decision without a `host_path` is `PROFILE_DECISION_INVALID`.

**Rows escaped the traceability checks.** A matrix row still carrying the
template's placeholder (`<ID>#1`) did not parse, so it was invisible to every
check — now `MATRIX_CITATION_UNRESOLVED`. A plan with edge-case rows and no
declared claim was reported clean, while the reference promised the floor
would say so — now `MATRIX_CLAIMS_UNDECLARED`.

**The mirror guessed a path convention.** The floor derived the mirrored test
path from the source glob's directory and inserted its own `unit/` level,
demanding `tests/unit/unit/core` from a host that had declared
`test_root: tests/unit`. The floor now mirrors into the **declared** test
root and never guesses a level — the host owns its layout.

**`PROFILE_NOT_RECORDED` was classified as an issue in the reference and
emitted as a warning by the code.** The code tables are now the single source
of truth, and a drift test fails CI when the reference's table and the code's
tables disagree.

**The brief carried a recomputed SUBSET of the floor.** A gate agent could be
told "the floor is clean" while `archgen_plan{action:'verify'}` had findings
the brief never showed — the task-level codes (`CYCLE`, `NO_ACCEPTANCE`,
`OWNERSHIP_OVERLAP`, …) only existed in the verifier. The brief now carries the
verdict and the full finding set, and the floor is computed once.

**The brief renderer threw.** `renderAudit` read `ctx` from a frame that did
not have it: every brief whose finding list was truncated died with
`ReferenceError: ctx is not defined`. The same class of bug shipped in
`archgen_refs`, which called `invalidInput` without importing it. Every
action's **error path** is now driven by a test and must return a typed
error — never `INTERNAL`.

### Fixed — bounds that hid their tail, and one that hid the truth

- `archgen_refs{action:'list'}` always returned `[]`: it read
  `listTopics(roots).topics`, and `listTopics` returns an array. The whole
  reference-discovery surface was dead.
- `archgen_plan{action:'coverage'}` reported **the wrong ids** — the tool
  applied the offset a second time over a concatenated list, so the ids it
  called "covered" were the tail of the uncovered list — and a `meta.total`
  that changed as it paged. Each collection now has its own window, its own
  total and its own cursor (`collection`).
- `archgen_plan{action:'verify'}` advertised a `limit` it ignored, and its
  two lists shared ONE offset over two different lengths — so the warnings
  between index 20 and 39 were reachable at no offset at all.
- `archgen_plan{action:'impact'}` computed the limit into `meta` and returned
  the unbounded payload, with a `next` that returned the same payload.
- `archgen_plan{action:'validate'}` and `archgen_docs{action:'validate'}` were
  unbounded: 400 errors and 120 broken references in one answer.
- `archgen_docs{action:'index'}` capped at 100 files **inside the core**, so
  files 101+ were unreachable; `archgen_docs{action:'digest'}` cut a
  file-scoped digest at 400 sections, so a 501-section file lost 101 with no
  way to reach them. A file-scoped digest is now that file's complete outline.
- `archgen_docs{action:'refs'}` / `{action:'map'}` dropped the `file` scope
  from the continuation, so the "next call" was a different query.
- `archgen_plan{action:'graph'}` and `archgen_docs{action:'section'}` /
  `{action:'validate'}` nested their payload under `data.data`, unlike every
  sibling action.
- `archgen_skills{action:'match'}` computed `required`/`installed` from the
  PAGE, so `limit: 1` reported one required skill when three matched — and
  its continuation dropped the summary and ownership that drive the match.
- `archgen_plan{action:'scaffold', file}` rejected the exact paths the tool
  publishes, and still shipped ~1,900 tokens of non-file payload.

### Fixed — silent degradations

- `archgen_codegraph{action:'ensure'}` changed a **machine-wide telemetry
  setting** without `approve: true`, contradicting its own contract.
- `archgen_setup{action:'bootstrap'}` returned a raw 11-key codegraph report
  where `archgen_codegraph` returned a shaped 7-key one; its fast path
  returned a third shape. `harness_info` returned three shapes. `install_mcp`
  returned unbounded per-config rows where `bootstrap` returned counts.
- `archgen_setup{action:'uninstall_mcp'}` reported `written: true` when it had
  removed nothing; `doctor` said "2/5 checks OK" while carrying three rows.
- `archgen_tasks{action:'contract'}` emptied the capability block on any
  error — so a worker was told nothing was required when matching had never
  run — and cut five doc sections to two with no count.
- `archgen_skills{action:'install'}` fell back to `universal` for an unknown
  harness, installing for the wrong target and reporting success.
- `archgen_registry{action:'show'}` parsed the `AGENTS.md` block while
  `{action:'update'}` derived the rows from `.archgen/` — so `show` reported
  no features for a project that had one.
- `archgen_tasks{action:'list'}` took a free-text status filter (a typo
  returned an empty list) and reported "no task 'X'" for a task that existed
  but was filtered out.
- `archgen_tasks{action:'next'}` and `{action:'snapshot'}` used opposite
  bases for `waveIndex` — the same field name, opposite meanings.
- `archgen_plan{action:'profile'}` and `{action:'scaffold'}` accepted a
  `tasks` count and ignored it. The task count is now evidence.

### Fixed — the guidance contradicted the tools

Every `§` section, brief and template was reconciled with the code:

- the profile's own `next` hint dropped the inputs that decide the artifact
  set — following the tool's own cursor served a **different plan**; it now
  carries every input, and a drift test round-trips it;
- `scaffold` without an `intent` serves the class's candidate set and now
  says so (`mode: 'class'`) instead of pretending it served the profile;
- every `brief` call site in `SKILL.md` now names its scope arguments, and
  `set_status` / `snapshot` / `next` name `tasksYaml`;
- `archgen_codegraph{action:'ensure'}` needs `approve: true`;
- the gate-metrics block had **three shapes in three files** and the floor
  read one of them — there is now one canonical shape, and the floor also
  reads the gate block a SMALL plan keeps in its own `## Profile` fence;
- the coverage dimensions were 8 in one file, 9 in another and 4 in a third —
  there is now one list of nine, in the brief that must carry it;
- the review brief said "zero findings" while also saying a NIT never blocks,
  and told the orchestrator to re-run a closed stage;
- the shipped `tasks.yaml` template **failed the floor it was meant to
  satisfy** (`WAVE_GROUP_SPANS`, and two tasks owning the same glob);
- `code-standards.md` claimed the verifier audited it — it audits the tree
  layout only, and says so now;
- the model-tier rules moved out of the brief (they are orchestrator policy);
- the interview round cap is keyed by **intent** and served by the profile;
- `platforms.md` and `mcp-and-skills.md` no longer restate the MCP key
  vocabulary in two different ways.

### Fixed — the third verification pass found sixteen more

A third verification pass drove the real handlers against the fixed code and
found sixteen defects — three of them HIGH, all in the machinery the previous
commits had just added:

- **EVERY CONTINUATION LOOED FOREVER AT THE TAIL.** The truncation test
  compared the **page** length with the **total**, which is true at the tail
  as well — so the published continuation pointed at the *same* offset and an
  agent that followed it spun on an empty page forever. The core already
  computed what is *left* after the window (`omitted`); every caller now uses
  it.
- **A CHAIN THAT JUMPED BETWEEN COLLECTIONS.** `meta.next` continued whichever
  collection happened to be truncated, so an agent paging the uncovered list
  was handed the task list — and the offset repeated. `meta.next` now
  continues **the collection the caller asked for**; `meta.more` names the
  others.
- **A MISMATCHED `collection` ANSWERED WITH A SILENT ZERO.**
  `coverage{collection:'issues'}` is schema-legal and returned
  `total: 0, returned: 0` while the payload carried twenty tasks. Each
  action now validates the collection against its own set and refuses a
  mismatch with `INVALID_INPUT`.
- **`impact`'s CONTINUATION COULD NEVER REACH THE `transitive`/`artifacts`
  TAILS** — the offset walked only the selected list, and the published
  continuation always named the selected list. Each list now has its own
  continuation, and the ones that are still truncated are named in
  `meta.more`.
- **A WAIVER SUBJECT SUPPRESSED UNRELATED FINDINGS.** A scope of `test`
  matched the *prose* "mirrored **test** path", and `T19#2` matched
  `T19#20`. A scope is now matched against the **subjects** a finding names —
  the quoted paths and the task#acceptance refs — never against the prose
  between them.
- **`coverage{taskId}` RETURNED OTHER TASKS' FINDINGS.** The filter was a
  substring test, so `T1` matched `T10`'s finding.
- **`docs{validate}`'s WARNINGS TAIL WAS UNREACHABLE** — the two lists shared
  one cursor — and its continuation dropped the `file` scope. Both lists have
  their own window and cursor now.
- **A SIBLING ARTIFACT SATISFIED A DIFFERENT FAMILY'S DECISION.**
  `docs/prd.md` and `docs/<module>.md` are different families whose patterns
  overlap, so a PRD satisfied the module-diagram family's `create` (a missing
  diagram passed) and blocked a plan that had correctly omitted one. The
  presence checks now compare the family *assignment*.
- **A YAML FENCE IN A LATER SECTION BECAME THE PLAN PROFILE.** The fence
  search scanned the rest of the document, so an appendix's block was adopted
  and the floor blocked on a record it had invented. The fence must now be
  inside the Profile section.
- **A RECORDED PATH COULD ESCAPE THE ARTIFACT SPACE.** `../outside.md`
  resolved to a sibling of the slug directory. Recorded paths are contained
  before they are used.
- **`tasks{next, taskId}` REPORTED "no task" FOR A COMPLETED TASK** — the
  wave resolver excludes done tasks, so the lookup found nothing. It now
  looks the id up in the task set and reports that the task is done.
- **`harness_info` STILL RETURNED TWO SHAPES** — the named-harness branch
  short-circuited before the unified envelope. One shape now.
- **`bootstrap`'s CODEGRAPH KEY SET STILL DIFFERED** from
  `archgen_codegraph`'s, and `index` was emitted only on some paths. Both are
  fixed sets now.

### Changed — the always-on ceiling moves, because the guidance did

The floor's exact behaviour (waivers, families, the claim convention), the
profile→scaffold round trip, the medium-confidence rule, the error semantics
and the corrected call sites all live in the always-on kernel — where the
agent reads them. The always-on total moves **12,970 tokens**, and the
documented CI ceiling moves with it **12,200 → 13,600**. The budget is still
a hard gate: CI fails if the always-on footprint exceeds it. The ceiling
keeps the same ~5% margin over the measured total that it has always had —
the token estimator is ±10%, so a tighter margin would let the gate fail on
noise.

| | Tokens |
|---|---:|
| `skill/SKILL.md` (always-on) | 7,566 |
| MCP tool catalog (9 tools, always-on) | 5,404 |
| **Always-on total** | **12,970** |
| Protocol references (on demand) | 17,424 |
| Median reference section | 271 |
| Dispatch briefs (on demand) | 4,155 |
| Artifact templates (on demand) | 2,733 |

### Fixed — the final verification pass found seven more

A second verification pass drove the real handlers against the fixed code and
found seven defects in the previous commit — one of them a regression that
flipped a SMALL plan from `APPROVE` to `ISSUES`:

- **A gate-only `## Profile` fence blocked the floor.** The fence was read as
  *the plan profile*, so the decision set was empty and every artifact on disk
  read as `PROFILE_UNRECORDED` — a plan that records no artifact profile at
  all blocked instead of warning. The fence's GATE is now read separately
  from its artifact decisions.
- **`coverage`'s continuation named the default collection**, so an agent
  paging the uncovered list got the task list instead. The requested
  collection is now first.
- **`coverage`'s `meta.total`/`meta.returned` described the whole set** while
  the answer carried one collection — `returned` could exceed `total`. Both
  now describe the selected collection; the whole-set view stays in
  `meta.available`.
- **`scaffold{file}` served an `omit`-decided artifact as "write this"**, with
  `skeleton: null`. It now refuses, with the reason.
- **`bootstrap`'s outer payload had a key on one path only**
  (`alreadyConfigured`), and the codegraph report's key set varied with what
  happened to be detected. Both are fixed sets now.
- **`impact`'s `meta.total` excluded the artifacts** its payload carried, and
  it had no way to say which list the window walks. It now has a `collection`.
- **`verify`'s published continuation advertised `limit: 50`** while the
  effective limit was 40. The continuation now carries the effective limit.

### Added — the tests that hold the rules in place

- `floor-contract` — the floor's new contracts: a waiver suppresses, a family
  satisfies a create, an unbound matrix row is visible, the mirror uses the
  declared root, `answers.yaml` can satisfy its own recorded create.
- `single-source-of-truth` — the code table, the gate block, the waiver
  shape, the nine dimensions and the profile→scaffold round trip are pinned
  to their owners.
- `error-paths` — every action's failure path is driven and must return a
  typed error, never `INTERNAL`.
- `skill-call-audit` — **every `archgen_*` call the skill names is checked
  against the tool's schema**: the action must exist, every argument named
  must exist, and every argument the tool requires must be named. Five calls
  the tool rejected were found this way; the test is what stops the skill's
  instructions from rotting silently.
- `tool-contract` — the promises the tool catalog makes: a continuation names
  the collection that was asked for, `meta.total`/`meta.returned` describe
  the answer, one shape per fact, and an `omit`-decided artifact is never
  served as "write this".
- `continuable` / `bounded-output` — every bound is walkable, and every count
  is exact. The continuation chain is walked to the end and asserted to
  **terminate**: it never repeats an offset and never advances backwards.

### Added — `archgen_plan{action:'profile'}` — the scope classifier

The skill used to map an intent straight onto a scope class, and a scope class
made every artifact in it mandatory. A greenfield prototype therefore paid for a
PRD, an architecture contract, ADRs and diagrams it did not need.

The new action is read-only and deterministic. An intent baseline plus explicit
signals (module count, public contracts, data migrations, security surface,
production/product-facing, existing host documents, …) produces a score, a
`SMALL` / `MEDIUM` / `LARGE` class, a confidence, and **one decision per
artifact**:

```
archgen_plan { action: 'profile', intent: 'BROWNFIELD-FEATURE',
               signals: ['multi-module'], modules: 2, slug: 'demo' }
```

- **`scopeClass`, `confidence`, `score`, `rationale`, `missingSignals`,
  `escalateIf`** — the decision is explainable, not a vibe.
- **`artifacts[]`** — `create` / `reuse` / `omit` per artifact, each with a
  reason. Existing host PRDs, architecture documents and ADRs come back as
  `reuse`; the plan cites the path and writes only the delta.
- **`depth`** — hard ceilings for plan context, edge cases per task, PRD pages,
  architecture lines, diagram nodes, ADRs and plan length.
- **Missing evidence never raises the class.** A thin profile stays
  low-confidence and asks exactly one calibration question.

`scaffold` now answers with `requiredArtifacts`, `optionalArtifacts`,
`artifactPolicy`, `omissionPolicy` and `depthBudgets`, and its `nextStep`
starts at the profile. The decision is recorded in the plan's `## Profile`
section (SMALL) or `answers.yaml` `plan_profile:` (MEDIUM/LARGE).

### Added — the mechanical floor: the gate agent no longer does arithmetic

The gate agent was proving facts by hand, every round: that a source-owning
task owns the mirrored test path, that an edge-case matrix row points at an
acceptance that exists, that every PRD requirement is cited, that a declared
decision file is on disk, that a declared path has an owner, that a wave label
matches the DAG. Each pass surfaced one more category of the same checks —
which is why one review became four.

`archgen_plan{action:'verify'}` now computes them, and it runs **before** any
gate agent is dispatched:

- **Mirrored test tree** — a task owning source under `toolchain.source_root`
  owns the mirrored path under `toolchain.test_root` (the test FILE name is
  the language's choice; the PATH is not).
- **Matrix citations resolve** — every `Covered by` cell names a task and an
  acceptance index that exists.
- **Requirements are cited** — every `FR-<MODULE>-nn` in the PRD is cited by an
  acceptance, and every FR id an acceptance cites exists in the PRD.
- **Declared things exist and are owned** — every `structure:` path and module
  `owns[]` glob has a task that owns it; every `decisions[].id` has its file.
- **Wave labels match the DAG** — `parallel_group: wave-N` equals the task's
  computed wave, and one group never spans two waves.
- **Ownership containment** — one task's glob containing another's is a
  *warning* (a later wave can overwrite the earlier task's files), never a
  block.

The gate brief now carries the floor's result and four rendered maps —
requirement map, edge-case matrix map (row → the acceptance text it cites),
ownership map, module DAG — so the agent checks ALIGNMENT instead of
re-deriving facts, and reads the sections it needs instead of whole files.

### Added — traceability claims: the link is written down, so the floor can join it

The gate kept reporting the same class of finding by eye — a matrix row
pointing at the acceptance that does *not* verify it ("E4 cites T9#1, but T9#1
is the probe-correctness check"). That is a join, not a judgement, so the join
moved into the data:

```yaml
acceptance:
  - "the probe result is persisted with its evidence payload (covers E4)"
```

- The floor now checks the **mutual link**: the matrix row cites `T9#1`, and
  `T9#1` claims `E4`. A row pointing at an acceptance that does not claim it
  is an issue — with the acceptance that *does* claim it named in the message.
- An acceptance claiming an edge row that does not exist is an issue too.
- `(covers FR-<MODULE>-nn)` counts as a requirement citation, and the
  requirement map now shows the requirement text **next to** the acceptance
  text, so the remaining judgement is a two-line comparison.
- The convention is **detected, not imposed**: until a plan declares claims,
  nothing is enforced; once one acceptance claims an edge id, every row is
  checked. Ids are artifact ids — never code names, never language-specific.

### Added — the waiver ledger and the gate's own metrics

- **A waiver is a file, not a sentence.** `.archgen/<slug>/waivers.yaml`
  records `scope`, `finding`, `reason`, `approved_by` and `approved_at`. The
  floor reports the ledger's size, the gate brief lists every waiver (a
  waived finding is not a defect to fix), and the orchestrator must write the
  ledger before proceeding past a residual finding.
- **The gate measures itself.** `answers.yaml` → `plan_profile.gate` records
  rounds used, findings by class, waived count and residual; the floor checks
  that the recorded waived count matches the ledger.

### Added — the floor as a build gate

`archgen-mcp exec` gained `--fail-on <path>:<value>`, so the deterministic
floor is reachable from CI:

```bash
npx archgen-mcp exec archgen_plan '{"action":"verify","tasksYaml":".archgen/<slug>/tasks.yaml","planDir":".archgen/<slug>/plans"}' --fail-on verdict:ISSUES
```

Exit `3` on a match, `0` otherwise. Warnings never fail the build — a gate that
cries wolf gets bypassed. The recipe is in [`docs/ci.md`](docs/ci.md).

### Changed — the floor fails loud instead of guessing

The mirrored-test-tree rule used to infer the source and test roots from the
most common path prefix when `architecture.yaml` did not declare them — a
guess that is wrong for half the ecosystems, and a wrong guess that silently
skips a check is worse than no check. The roots are now **declared or the rule
is off, loudly**: `"the mirrored-test-tree rule is NOT ENFORCED — declare
toolchain.source_root and toolchain.test_root"`. A language-neutrality test
pins it: the audit core may not contain a default path prefix at all.

### Fixed — the profile and the scaffold read two different lists

The artifact set was written TWICE in the ladder — once in the profile rules,
once per scope class — and the two had drifted:

```
in profile but NOT in scaffold:  [codebase-map.md, docs/mermaid-snippets.md]
```

So "write only what the profile marked `create`" could silently not happen:
the profile said create, the scaffold never offered the file. There is **one
list** now — `profile.artifactRules` — and
`archgen_plan{action:'scaffold', scope, slug, intent, signals}` serves exactly
the create set. Without an intent it serves the class's candidate set, with
the required ones flagged and the conditional ones marked as such.

### Fixed — the profile's decisions were never proved

"Artifact necessity" was still judged by the agent, because the floor never
compared the recorded decisions with the files on disk. It does now:

- every `create` artifact exists (`PROFILE_CREATE_MISSING`);
- every `omit` artifact does **not** (`PROFILE_OMIT_PRESENT`);
- every `reuse` cites a file that exists (`PROFILE_REUSE_MISSING`);
- every artifact on disk has a decision (`PROFILE_UNRECORDED`) — an artifact
  without a consumer is the defect this whole mechanism exists to prevent;
- a SMALL plan records its profile in the plan's `## Profile` YAML block, so
  the check covers every scope class, not only MEDIUM/LARGE.

### Fixed — a brief could be stale

The brief is rendered at dispatch; if the plan changed afterwards, the agent
would judge content the brief never described. The brief now carries a **plan
snapshot** — task, requirement and edge-row counts plus a fingerprint — and the
verifier is told: if what it reads disagrees with the snapshot, report it and
stop judging stale content.

### Added — every finding carries a stable code

Fixes can now be batched by code and per file, tests assert behaviour instead
of prose, and CI counts classes (`issueCodes` / `warningCodes` on the verify
result): `MIRROR_MISSING`, `MATRIX_CLAIM_MISMATCH`, `PROFILE_OMIT_PRESENT`,
`REQ_UNCITED`, `WAVE_LABEL_DRIFT`, `NO_ACCEPTANCE`, `CYCLE`, and the rest —
the full table is in [`docs/ci.md`](docs/ci.md).

### Added — the gate names its subject, and a corpus locks its behaviour

- `plan_profile.gate` now records **who approved** the gate (`verifier`), the
  rounds used, the findings by class, the waived count and the residual. The
  floor warns when no verifier is recorded (`GATE_IDENTITY_MISSING`) — an
  approval without a subject is not an approval.
- `fixtures/plan-corpus/` holds poisoned plans with their expected codes, so
  the floor's behaviour is locked by example (the yaml-corpus precedent): every
  case must produce exactly its codes, and no others.

### Changed — the brief is a map, not a copy

A 30-task plan with 60 edge rows rendered every map in full: **6,034 tokens**
in one message — a fifth of a 32k window. The maps are now bounded by a shared
budget, and the budget is a **ceiling, not a quota**:

- a small plan is **never** truncated — the ceiling only binds when there are
  more rows than a brief can carry;
- the budget is allocated by use (the matrix map first, then requirements, then
  ownership and the module DAG) and a map with fewer rows than its share hands
  the surplus to the next one;
- nothing is dropped silently: the brief says how many rows it left out and
  where they live, and the verifier is told to read that section and check
  every row there — while the floor's own checks stay complete either way.

A clean 30-task brief is now ~3,000 tokens.

### Changed — workers receive the cases they owe

An acceptance that claims `(covers E4)` now reaches the worker as the **case**,
not just the link: the worker contract carries "E4: probe persistence — result
stored for audit", so it implements exactly the cases the plan claims.

### Changed — one coverage report

`archgen_plan{action:'coverage'}` now reports the whole traceability picture —
tasks, requirements, edge cases, and whether a profile was recorded — instead
of a second report that knew nothing about traceability.

### Fixed — a section call returned the whole file

`archgen_docs{action:'section', file: <path>, section: <name>}` — the shape an
agent reaches for naturally — **returned the entire document**: a file hit with
no `#anchor` meant "no section was named", and the separate `section` argument
was ignored. One "pull the section" call delivered most of a plan, and the
agent then pulled the same task sections again.

The section name and the file are now separate inputs: `file` + `section`
extracts that section from that file.

### Changed — a section is a section, and it says how big it is

A section OWNS its nested subsections, so pulling `## Per-task sections`
returned all twenty task sections with it. Now:

- a section returns its **own** content (heading + text up to its first child);
- it **names** its children (slug, title, line) so the caller drills down
  instead of re-reading;
- `include:'all'` returns the whole subtree when that is what the caller wants;
- every response carries `lines` and `bytes`, so an unexpected 2,000 lines is
  visible rather than discovered later.

Measured on a 20-task plan: pulling `context` went from **2,801 tokens to
220**; pulling `per-task-sections` with `include:'all'` is 1,684.

### Fixed — the overview paid for an outline nobody could use

`archgen_docs{action:'index'}` carried every heading's raw TEXT. Fetching needs
a slug, so the caller paid for an outline it could not act on and then called
`digest` for the same outline with slugs. The overview is now the file map
(path, title, section count, words) — **1,147 → 348 tokens** — and `digest` is
the single outline.

### Changed — smaller, bounded outputs

- The token map carries **five** excerpts per section, each ≤120 characters.
- The gate brief's matrix map dropped the case text (it lives in the plan's
  matrix section) and keeps the PAIRING — row → acceptance → claim — which is
  the part the agent cannot cheaply re-derive.
- The verifier brief's protocol was tightened without losing a rule.

Measured on a 20-task, 60-edge-row plan: the verifier brief **6,941 → 4,990**
tokens, the review brief **5,855 → 4,294**.

### Fixed — three outputs had no ceiling

Measured against the worst case (120 tasks, each missing its mirrored test
path; 13 files x 20 sections):

| Action | Before | After |
|---|---:|---:|
| `archgen_plan{verify}` | 7,191 | **2,588** |
| `archgen_plan{coverage}` | 7,109 | **2,666** |
| `archgen_docs{digest}` | 11,775 | **4,136** |

**The bound never loses what the agent needs:**

- the floor's **counts per class stay exact** (`MIRROR_MISSING x120`), the
  verdict is computed from the full set, and the list is a sample with the
  remainder reported — so the agent reports *one line per class* ("every task
  owns source without its mirrored test path") instead of 120 near-identical
  lines, which is the fix the orchestrator actually needs;
- the coverage report bounds the uncovered list and keeps the exact total;
- the digest spends its budget on a **fair share per file** — every file keeps
  the head of its outline, the remainder is shared round-robin, and the real
  section count is always reported — so a budget can never starve a file's
  navigation entirely (it was spent in file order before).

### Fixed — a bound that hid the tail

The floor's findings were capped at 40 with **no way to reach the rest**: the
agent could see that there were 120 and never see findings 41–120. A bound
that hides the tail without a way to reach it is not a bound — it is a loss,
and the agent ends up fixing a class it cannot enumerate.

Every bounded output is now **continuable**, and the rule is tested:

- `archgen_plan{action:'verify'}` takes `offset` and names the next call in
  `meta.next` — the findings list is a window, not a truncation;
- `archgen_plan{action:'coverage'}` walks its uncovered list the same way;
- a digest scoped to **one file** is that file's complete outline (the budget
  exists to bound the artifact set, not to hide a document the caller asked
  about);
- the gate brief names the continuation when it shows a sample of the floor's
  findings.

A test walks the findings to the end and asserts: every finding is reachable,
none is shown twice, and the totals and per-class counts never change.

### Changed — the judgement input got BETTER, not smaller

The gate brief's matrix map now carries the row's **expected behaviour** next
to the acceptance that claims it — the exact pair the agent has to compare —
instead of the concatenated input+expected text. The input state stays one
read away in the plan's matrix section.

```
E1 | returns an empty list without a call | T1#1 | the module 1 behaviour holds (covers E1) | E1
```

A broken 60-task brief: **4,227 tokens** with complete counts
(`MIRROR_MISSING x60, MATRIX_DANGLING_CLAIM x59, REQ_UNCITED x1`) and a
40-line sample plus "80 more of the same classes — report them BY CLASS".

### Changed — the gate runs at most twice, and the verifier cannot invent requirements

- **Round 1 is exhaustive; round 2 is a delta.** Round 2 re-checks only round
  1's findings (fixed / open / regressed) and the floor. It does not restate
  what is fixed, and a finding it did not see must be marked `NEW` and be
  blocking-grade.
- **There is no round 3.** What remains after two rounds is escalated to the
  user with the outstanding list. The protocol no longer allows an unbounded
  number of user-approved rounds.
- **Every finding is classified** — `BLOCKING` (contradicts an agreed
  requirement, an accepted decision, or a stated invariant), `NIT` (cosmetic:
  wording, spacing, punctuation — never blocks, never triggers a round), or
  `OBSERVATION` (a capability nobody asked for — never blocks, never a fix
  demand).
- **The verifier may not invent requirements.** It audits the plan against the
  PRD, `answers.yaml`, the decisions, the code standards and the recorded
  profile. Without this rule the gate kept discovering new features
  (checkpoint/resume, rate limiting, retention policies) and the plan never
  converged.

### Fixed — the review stage had its own three-pass loop

The verifier stage was capped at two rounds; the **review stage kept its own
three-pass protocol**. Two stages with different loops are two stages that
drift, and the third pass is where an agent starts wanting new features.

There is now **ONE gate protocol, TWO stages, TWO rounds each** (the review
stage runs it verbatim):

- **Round 1 is exhaustive** — every area, every finding, one pass. Holding a
  finding back to see what a fix does is a defect in Round 1.
- **The fix pass is one pass per file AND per code**, then the floor re-checks
  it. If the floor reports your own code again, the *class* was not fixed.
- **Round 2 is a delta** — the Round 1 findings and the artifacts the fix
  touched; nothing else.
- **No round 3, ever, by default.** What remains is either a concrete defect
  (the orchestrator fixes it and the floor proves it) or a judgement call (the
  user's decision). A third pass needs an explicit user request with a stated
  purpose — never "one more look".

### Changed — a finding blocks only when it names the rule it violates

The endless "target 0 or negative" → "target 0, negative, or non-finite"
churn was a classification failure: nothing told the agent what makes a
finding blocking. Now a BLOCKING finding must name **the artifact, the rule
it violates** (a PRD requirement, an accepted decision, a recorded profile
decision, a code standard, or another task's contract) **and the change that
satisfies it**. A finding that cannot name the violated rule is a NIT
(cosmetic — one line, no rewrite, no round) or an OBSERVATION (a capability
nobody asked for).

### Changed — session reuse, bounded

The dispatch ledger reuses a worker's session for a follow-up fix — that part
is right (context continuity). Three rules now bound it: **gate agents never
reuse a session** (independence), **a changed contract invalidates the
session** (its earlier work rests on a stale acceptance), and **the session is
an optimisation, never the record** (the contract and the git history are).
The old wording — reuse for "re-verification" — was the hole: a gate that
continues the session of the agent it judges is not a gate.

### Changed — artifacts have a consumer, and the host repository wins

- **Necessity over completeness.** Every candidate artifact answers: who reads
  it, what decision it changes, is the fact already in the repo, and what
  breaks if it is omitted. No consumer → do not create it; record why.
- **Reuse over regenerate.** A second copy of an existing PRD, architecture
  document or ADR is a defect, not thoroughness.
- **Proportional gates.** The deterministic `verify` floor runs for every
  scope; the judgment verifier and the plan review scale with it — SMALL is
  audited by the main agent, MEDIUM gets one verifier sub-agent, LARGE gets a
  top-tier verifier and an independent reviewer. A ninth coverage dimension,
  **scope & artifact necessity**, joins the verifier's sweep, and the reviewer's
  "enhancement opportunities" area becomes **scope fit & minimalism**.
- **The interview stopped guessing.** Round 0 is scope calibration, the
  intent→scope column is gone, and a question the prompt, repo, profile or
  survey already answers is never asked.
- **The survey got two more sections**: `Existing docs` (host documents and
  freshness — the reuse candidates) and `Toolchain` (source/test roots,
  build/test/lint commands, naming conventions).

### Changed — the skill no longer prescribes a stack

`references/code-standards.md` and every template are language-neutral: the host
ecosystem's toolchain, formatter, naming and test runner come first, and the
skill states only invariants (strict checking, explicit absence, structured
errors, one purpose per module, < 1000 LOC, why-comments, a sibling test tree).
The canonical templates carry `toolchain:` and `existing_docs:` blocks and
neutral placeholders instead of a TypeScript/Next.js/Prisma example.

### Fixed

- **A hash algorithm could fail the gate.** The plan↔task check read any
  `UPPER-123` token as a task id, so `SHA-256`, `HTTP-404`, `UTF-8`,
  `ISO-8601` and `CVE-2021-44228` were reported as *unknown task ids* and a
  plan mentioning a digest could never pass. A token is now a task reference
  only when its prefix is one this plan's task ids use, a generic task prefix
  (`TASK-`, `T-`, `STEP-`, …), or an explicit task context — requirement ids
  and technical constants never are.
- **A search hit could hide the word that matched.** `archgen_refs{search}`
  truncated a long line from the START, so the excerpt it returned sometimes
  did not contain the token at all. The excerpt is now a window around the
  match.
- **Two provenance headers per artifact.** The canonical templates carried their
  own `schema_version`/`generator`/`generated_at` header AND `scaffold`
  prepended one, so every served `tasks.yaml` and `architecture.yaml` opened
  with two. Exactly one now, and a regression test pins it.
- **The token report measured files that no longer exist.** The context-budget
  tool still pointed at `skill/references/*.md`; the protocol documents live in
  the MCP package now, so the GENERATE scenario measures the files the server
  actually serves.
- **The regression test copied the tree it did not need.** `BUG-SYNC1` copied
  `packages/cli` wholesale, including installed dependencies whose symlinks can
  make `cpSync` throw — a flake with nothing to do with the behaviour under
  test. The copy now skips `node_modules`.
- **A stale path in the docs.** The architecture walkthrough still pointed at
  `results/`; gate and investigation reports live under `.agent/reports/`.

Measured, 0.1.3 → unreleased:

| | 0.1.3 | Unreleased |
|---|---:|---:|
| `skill/SKILL.md` (always-on) | 6,252 | 6,492 |
| MCP tool catalog (9 tools, always-on) | 4,695 | 5,056 |
| **Always-on total** | **10,947** | **11,646** |
| Protocol references (on demand) | 12,931 | 15,237 |
| Median reference section | 238 | 243 |
| Dispatch briefs (on demand) | 2,416 | 3,673 |
| Artifact templates (on demand) | 2,347 | 2,596 |

The catalog grew by the `profile` action, and the protocol references by the
floor protocol, its invariants, the traceability rules and the code table; the
always-on total stays under the CI ceiling, which moves **11,500 → 12,200**
because the floor protocol, the waiver rule and the section contract are part
of the always-on contract. The gate still fails a regression beyond that.

## [0.1.3] - 2026-11-09

A token-and-noise release: the same capabilities, a **14% smaller always-on
footprint**, and a second install call that does nothing because there is
nothing left to do.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.3` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.3` |

### Changed — the always-on surface is 14% smaller

The always-on cost is what every request pays before the agent does anything:
`SKILL.md` plus the tool catalog the client injects. Both were rewritten to say
only what the caller cannot infer from the schema.

- **The catalog** measures 4,695 tokens, down from 5,242. Repeated argument
  wording now comes from four shared constants (`limit`, `offset`, `location`,
  `approve`), so the same sentence cannot drift between nine tools.
- **`SKILL.md`** keeps every rule, gate, mode and `§` obligation, and drops the
  prose that restated them.
- **`archgen_help`** keeps every action, argument and gotcha; only repeated
  wording was cut.
- **Reference and brief prose** was tightened without dropping a single pinned
  fact, section slug, or coverage dimension; the verifier and reviewer gates
  are unchanged in substance.

Measured, 0.1.2 → 0.1.3:

| | 0.1.2 | 0.1.3 |
|---|---:|---:|
| `skill/SKILL.md` (always-on) | 7,420 | 6,252 |
| MCP tool catalog (9 tools, always-on) | 5,242 | 4,695 |
| **Always-on total** | **12,662** | **10,947** |
| Protocol references (on demand) | 13,265 | 12,931 |
| Dispatch briefs (on demand) | 2,626 | 2,416 |
| Artifact templates (on demand) | 2,358 | 2,347 |

The CI ceiling is tightened to **11,500** tokens, so a regression fails the
build instead of reaching a user.

### Changed — a configured project is a no-op

The install path was idempotent in effect but not in cost: a second
`bootstrap` or `codegraph ensure` re-ran the installer and the indexer, then
answered with the full report. A second call now returns
`alreadyConfigured: true` with what is present — and runs nothing.

- **Detect the entry, not just the file.** `archgenMcpStatus` and the new
  `codegraphState` read the config and report `wired` per harness; a config
  that already carries the entry is not rewritten.
- **Skip the installer when every target is wired.** `codegraph ensure` no
  longer runs `codegraph install` on a configured project, and `status` no
  longer makes a network call (`upgrade --check`) for a local fact.
- **Report the result, not the process.** A no-op returns only the facts the
  caller needs; a pending CLI, index build or unapproved write is never
  reported as `alreadyConfigured`.
- **The archgen entry must be exact.** The no-op check asks the real writer in
  dry-run mode, so a config that merely has the key — a stale absolute path,
  a different command — is a pending rewrite, not a configured project.
- **`doctor` reports problems only.** A healthy install answers with status,
  summary and versions; the five always-OK rows — and the per-harness wiring
  table — are gone.
- **The CLI uses the same handler.** `archgen-mcp bootstrap` now runs the
  `archgen_setup` handler instead of a second copy of the composition, so
  `archgen init` gets the compact no-op and the same approval gates. It also
  accepts the historical per-config report, because an older global server
  can still answer the call. Failed and skipped wiring is surfaced instead of
  printed as an ordinary row.

### Fixed — the status check used a second copy of the path rules

`archgenMcpStatus` detected harnesses and resolved config paths by hand
instead of using the writer's `detectHarnesses` and `configTargetFor`. A
`COPILOT_HOME` or a `~/`-relative config was therefore checked in a different
place than it was written, and the no-op decision disagreed with the install.
Both now share one implementation, and the server passes its own environment.

`archgen_codegraph{action:'status'}` reports the tri-state honestly — `absent`,
`present-no-codegraph`, or `wired` — instead of treating an existing config as
a wired one.

### Fixed — a paginated CodeGraph result pointed at the wrong action

`meta.next` from `archgen_codegraph` always said `action:'status'`, even when
the call was `ensure` or `wire`. The next slice now belongs to the action that
produced it.

### Tests

`packages/mcp/test/core/setup-idempotency.test.mjs` pins the whole no-op
contract: JSON and TOML entry detection, per-target MCP status, the second
ensure running no installer or indexer, a stale entry counting as pending, an
unmergeable config reporting `ok:false`, the tri-state status, the compact
bootstrap payload, issues-only doctor output, and the Copilot-home environment
resolution. The CLI suite pins both report shapes, the failure/skip
surfacing, and the nonzero exit when a config cannot be merged.

## [0.1.2] - 2026-11-09

The release that makes the plan of record **visible**, keeps the tests **out of
the source tree**, and stops the tools from **dumping** what the agent only
needed a piece of.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.2` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.2` |

### Fixed — the codegraph manager ignored the server's own environment

The dangling half of the Copilot-home commit: `detectHarnesses` takes the
environment so it can resolve a NAMED home (`COPILOT_HOME`), but
`manageCodegraph` was still reading the implicit `process.env` default. Every
other caller already passed it — the tools, the CLI, the wiring module. A
server running with its OWN environment (a sandbox, a test harness, a
`COPILOT_HOME` that is not the process default) detected the Copilot harness
from the WRONG environment and wired the file the client never reads.

### Added — every archgen artifact is committed

Nothing told the agent to commit the plan. Worse, the worker contract says
*"commit your work scoped to the owned files"* — and `file_ownership` only
ever names product code — so `.archgen/<slug>/` was **structurally
un-committable**, and the natural fallback was to gitignore it. The plan of
record, the run state and the decisions were invisible in the history, and a
reviewer could not see what was planned or why it changed.

The whole archgen footprint is now version-controlled:

- `.archgen/<slug>/` — the plan of record, including the `.agent/` run state;
- `.agents/skills/archgen/` — the canonical installed skill, one copy for the
  team;
- `.claude/skills/archgen` — the harness bridge into that store;
- `AGENTS.md` and `CLAUDE.md` — the registry hub and its pointer;
- the project MCP config — the wiring that gives the team the tools.

Machine-local state stays out: `.codegraph/` (the local symbol index),
`.archgen/.runtime/` (the legacy heartbeat) and the `.archgen-version` deploy
stamp.

The rule is stated **once per audience** — the invariant in the always-on
`SKILL.md` (Hard Rule 10), the path list in the on-demand
`§artifact-templates/artifact-tracking`, the commit points in the GENERATE
and START-WORK steps, and the audit in the verifier brief, because the gate
agent never reads the skill and the brief is the only thing that reaches it.

### Changed — the source tree and the test tree are separate

`references/code-standards.md` said *"colocate tests beside the code they
test—never in a disconnected root `/tests` directory"*, and
`architecture.yaml` said `test_placement: colocated`. Agents were not
ignoring the rule — **the rule was the opposite of the standard**, and the
template the agent copies taught it.

The test tree is now a **sibling** of the source tree, never a child:

```
src/features/catalog/api/routes.ts
  -> tests/unit/features/catalog/api/<the language's test file>
```

- **The PLACE is fixed; the NAME is not.** The standard says where a test
  lives, never what it is called — the naming convention belongs to the
  language's ecosystem and to the host repository, so no per-language pattern
  is hardcoded anywhere.
- **Ownership follows the tree.** A task that owns `src/features/x/**` also
  owns `tests/unit/features/x/**` — a worker may not write outside
  `file_ownership`, so the mirrored path has to be in it. A plan may give the
  tests to a dedicated task instead, as long as some task owns them.
- **One narrow exception:** a language whose runner discovers tests only
  inside the package directory keeps those files beside the code; everything
  the runner can discover elsewhere still lives in the test tree.
- **In a brownfield repo** the survey reports where the tests live today, and
  the plan moves only the modules it touches — it never migrates the rest.

The standards file, the templates, the always-on skill and the verifier brief
now say the same thing, and six gates hold them there.

### Changed — the tools fetch; they no longer dump

The root cause was not a big payload. It was that **no collection-shaped
action had an item-level selector** — so "I need one section" cost "the whole
topic", and the only way to get one row was to take the whole set and pick
from it. The tool surface made dumping the cheaper option for the server and
the more expensive one for the agent.

Four changes, applied uniformly:

- **A selector on every collection.** `taskId` (tasks, plan coverage),
  `skillId` (skills), `file` + `section` (docs), `harness` (setup),
  `section` (references, skills). One item instead of the set.
- **A bound the caller owns.** Every tool takes `limit` and `offset`
  (default 50). A bound never hides data: the count is in `meta.total`, and
  `meta.next` is the exact call that returns the next slice. A large project
  — a 500-task plan, a 250-node graph, a 200-file artifact tree — can no
  longer dump itself.
- **A map to the rest.** Every answer's `meta` carries `available` (what
  else exists), `more` (the call that fetches one item) and `next`. The
  agent always knows there is more without the server having sent any of it.
- **The expensive default is gone.** `archgen_refs{action:'read'}` with no
  section returned the WHOLE topic (4,013 tokens); it now returns the
  section index, and the whole topic is `section: '*'` — deliberate.

Measured on a real plan, before → after:

| Call | Before | After |
|---|---:|---:|
| `archgen_refs{read}` (no section) | 4,013 tok | 1,353 tok |
| `archgen_refs{search}` | 1,641 tok | 853 tok |
| `archgen_skills{load}` (installed) | the file **three times** | rules + index |

### Fixed — the same text delivered twice

Measured, not guessed: every payload was scanned for text delivered more than
once.

- **`archgen_skills{action:'load'}` returned the skill file THREE times** — as
  `content`, as the extracted `rules`, and as the section index. The rules
  are what the agent must obey and the index is what it may pull; the file
  itself is one call away. The raw content is gone.
- **`archgen_skills{action:'match'}` returned every matched row three
  times** — under `matched`, `required` and `installed`. The install state
  now rides ON the row, and the two subsets are ids.
- **A search reported the same line once per nested section.** Sections
  overlap (a parent's body contains its children's), so a three-level nesting
  delivered the same sentence three times. Every hit is now reported ONCE,
  under the deepest section that contains it — in `archgen_refs{search}` and
  `archgen_docs{map}` alike.
- **The reference index listed the topic's own H1 as a section**, so index 0
  was "the whole document". The H1 is the topic, not a section.
- **The setup harness list was delivered under two keys.** One key now.

The two payloads that were NOT changed are deliberate: the gate `brief` and
the worker `contract` carry the same facts as prose (for the sub-agent) and
as fields (for the orchestrator) — two audiences, two formats.

### Changed — the token figures are measured, not typed

`npm run test:budget` now measures the ON-DEMAND content too — the protocol
references, the median section, the dispatch briefs, the artifact templates —
and reports it in its output. The README quotes the tool instead of a
hand-typed number that went stale on the next edit: every figure in it was
already out of date when this release started.

What 0.1.2 ships, measured:

| | Tokens |
|---|---:|
| `skill/SKILL.md` (always-on) | 7,420 |
| MCP tool catalog (9 tools, always-on) | 5,242 |
| **Always-on total** | **12,662** — 39% of a 32k window |
| Protocol references (on demand) | 13,265 across 5 files |
| A typical reference section (on demand) | 238 — the median of 39 |
| Dispatch briefs / artifact templates (on demand) | 2,626 / 2,358 |

### Fixed — the changelog had stopped being a changelog

The sections were out of order (0.1.0 sat above 0.1.1) and the rewrite
measurement was duplicated across two releases, so there were two places for
it to go stale. The file is back to its own convention — `[Unreleased]`, then
every release newest first — and each measurement lives in the release that
produced it.

`docs/architecture.md` also claimed that *"archgen does not build its own
history layer"* while the new rule requires the plan of record to be
committed. Git IS the history layer; the document now says so, and says what
is tracked.

### Migration

- **Upgrading is recommended** — the skill's rules changed: the archgen
  artifacts are committed, and the tests live in their own tree. Run
  `npx archgen-skill init` (or `archgen-skill update`) to pick them up.
- The 0.1.1 symlink-path upgrade note still applies if your project path
  contains a symlink: on macOS that includes anything under `/tmp` or
  `/var`.

## [0.1.1] - 2026-11-07

A patch release. One defect shipped in 0.1.0 and it was severe enough to
break the product for a large share of users.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.**

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.1` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.1` |

### Fixed — a valid path inside a symlinked project was refused as an escape

The containment guard compared the **lexical** path against the **real**
root. Those two are spelled differently in the NORMAL case:

- `process.cwd()` returns the REAL path — on macOS, `/private/var/...`;
- the caller passes the LOGICAL one — `/var/...`.

So the guard refused a perfectly valid path inside the project with
`refusing a path outside the project`. The two names the SAME place, and
they were compared as strings.

**Anyone whose project is reached through a symlink hit it**: macOS `/tmp`
and `/var`, a symlinked repository, a symlinked home directory. On macOS
that is the default for a project under `/var/folders/...` — which is where
every temp directory lives, including the ones a test harness uses.

Found by installing the **published** package into a temp project and driving
it: the very first call with a project-relative path failed. The source tree
was green the whole time, because a test's temp directory and the path it
built were spelled the same way.

The guard now makes **two** comparisons and allows the path if **either**
says it is inside:

- **LEXICAL** — the caller's spelling against the root's spelling;
- **REAL** — where the path actually lands against where the root actually
  is.

The real comparison is the one that can answer the question, and it is the
one that catches a symlinked parent redirecting a write out of the tree. It
now runs first and it is allowed to answer. The guard still never fails
open: when the real comparison cannot be made, the lexical one stands alone,
and a path outside the root by every measure we could make is still
refused — with the refusal wording unchanged.

The same bug was in **both** implementations — the MCP server's `fs-safety`
and the CLI's `store.js`, which `fs-safety` says it inherits from — so the
fix landed in both, or the two would disagree about the same path. One test
pins both at once, because they are two implementations of one rule.

### Fixed — the publish workflow could never have published the CLI

Every publish run in this repository has failed — `vmcp-0.0.7`,
`vmcp-0.0.6` four times over, and the 0.1.0 pair. Every release was
published by hand.

The CLI leg failed at `Test`, every time. The CLI is zero-dependency and
deliberately ships no lockfile, but its **tests** are not zero-dependency:
the migration suite drives the **real** archgen MCP server, which needs the
MCP SDK. The CI workflow already installed the server's dependencies for
exactly this reason; the publish workflow did not, so two tests died with
`ERR_MODULE_NOT_FOUND` and the run never reached the publish step. The leg
now installs them. Reproduced in a pristine clone of the tag: from
`Cannot find package '@modelcontextprotocol/server'` and 186/188, to
188/188.

The credential check also gave a **false green**: it tested npm's *version*
and nothing else. npm 11.5.1+ supports OIDC, so the check passed on any
modern runner — whether or not a trusted publisher is configured for the
package on npmjs.com. The failure then surfaced at `Publish` as a bare
`401`. The check now says plainly that the npm version is necessary but not
sufficient, names the npmjs.com configuration it requires, and — when a
token is used — proves the token works with `npm whoami` before the publish
step, so a revoked or mis-scoped token fails with a message that names the
cause.

### Fixed — the failures that cost an agent a round-trip

An agent reported three failures in a row. Two of them were loops, and both
were ours:

- **`archgen_refs` said "no section 'plan-depth'"** — and `plan-depth` is
  exactly what the skill teaches. The `§` markers name a section by a SHORT
  name (`§artifact-templates/plan-depth`) while the headings produce longer
  slugs (`plan-depth-by-scope-class`), so the shorthand the skill taught did
  not resolve. The agent did precisely what it was told and got an error.
  Every `§` shorthand in the skill is a **prefix** of a real slug, so the
  resolver now accepts an unambiguous prefix — the shorthand the skill
  teaches is now the shorthand the skill can use. A test walks every `§` mark
  in the skill and asserts it resolves.
- **`archgen_docs` said "missing or not a directory"** — because
  `archgen_plan{action:'scaffold'}` returns each file's CONTENT and **writes
  nothing**, and nobody said so. The scaffold payload now carries
  `writes: false` and the files to write, the skill says it in both places
  the call appears, and the failure itself names the fix.
- **A batch of calls lost every sibling result** when one argument was
  wrong. That is the caller's `Promise.all`, not an MCP defect — but the
  skill and `archgen_help` now say to settle batches (`allSettled`), because
  one bad argument must not discard the rest.

### Changed — every failure teaches the next call

An error that only says WHAT FAILED leaves the agent to guess, and a guess
that fails the same way is a loop. Every archgen failure is now **one line**
carrying the cause, the fix, and the exact next call:

```
no section 'plan-depth' in 'artifact-templates' — a prefix of the slug works too, if unambiguous. Next: archgen_refs{action:'index',topic:'artifact-templates'}
```

The vocabulary is shared (`core/guidance.mjs`), so every tool teaches the
same way, and the machine-readable next step rides along in the error's
details for a client that would rather act than read. A missing artifact
space, an unknown section, an uninstalled skill, an unknown task id and an
outside-project path all teach now.

### Added — the skill is audited against the live server

Two gates hold the skill to the server it runs against:

- every tool, action and argument the skill names — **anywhere in the file**,
  including the code blocks and the prose — must exist in the live schema;
- every action the server exposes must be reachable from the skill, so a new
  capability cannot ship undocumented.

The first one is how the `§` defect above is now impossible to reintroduce.

### Changed — the README's token footprint, measured and re-framed

The section listed every surface with its full size, which made archgen look
expensive: a reader saw 12,431 tokens of references and reasonably concluded
the thing was heavy. **None of it is ever paid** — the agent reads a
*section*.

It now leads with what is actually charged — the **always-on total, 11,647
tokens**, 36% of a 32k window, and the promise that this is all a session
pays — and then the on-demand cost per section, measured: the five protocol
references are 13,265 tokens *in total*, but the **median section is 238
tokens**, and a capability skill's rules are ~160.

### Migration

- **Upgrading is required if your project path contains a symlink.** On
  macOS that includes anything under `/tmp` or `/var`. Reinstall the server:
  `npx archgen-skill init` (or `archgen-skill update`).
- The `archgen_ui` migration note from 0.1.0 still applies to an agent
  driving an older skill.

## [0.1.0] - 2026-11-07

The first release with a version of its own. It removes the VS Code
extension, repairs three tool paths that had been dead or broken since they
were written, makes the capability skills actually apply, and rewrites every
agent-facing artifact to be a third smaller.

**Publish order: `archgen-mcp` FIRST, then `archgen-skill`.** The CLI's
installer resolves `archgen-mcp` from the registry, so a release that
advertises the server before it exists hands every user a broken bootstrap.

| Artifact | Published as | Tag |
|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-0.1.0` |
| `packages/cli` | `archgen-skill` | `vcli-0.1.0` |

### Fixed — three tool paths that had been dead or broken

- **`archgen_plan{action:'graph'}` had never worked.** `loadPlan(input)` read
  `opts` from its **caller's** frame — a module-level function reaching into a
  local it does not own — so every call threw `ReferenceError: opts is not
  defined` and surfaced as `INTERNAL: opts is not defined`. For every project,
  in every format, with or without status, since the action was written. The
  review brief has told the orchestrator to attach the graph since the day it
  was written, so **every plan review had been running without it**.
- **`archgen_docs{action:'section', section:'<slug>'}` failed on every plan.**
  The action treated its whole argument as a FILE path, while `digest` hands
  out section **slugs** — so the digest→section round trip, the primary way
  an agent reads an artifact, was broken by construction. The resolver now
  accepts a bare slug, a path, or `path#anchor`; an ambiguous slug returns
  candidates instead of a guess, and a miss lists what IS available.
- **`archgen_plan{action:'brief'}` demanded the slug even when the caller had
  already passed the absolute `tasks.yaml`** — a path that IS
  `.archgen/<slug>/tasks.yaml`, so the slug was derivable. Worse, it emitted
  `tasks.yaml` **absolute** while `slug dir` and `plans dir` were
  **project-relative**, and a relative path in a brief resolves against the
  *server's* root: a brief read from a worktree pointed at the wrong tree.
  The slug is derived now, and every path in a brief is absolute, from one
  source.

### Fixed — the worker contract shipped a literal placeholder

Every worker prompt began `<Domain> work: follow …`. The briefs had a
`remainingPlaceholders` guard — which required a **lowercase** first letter,
so `<Domain>` was invisible to it — and the worker contract had **no guard at
all**. The follow-instruction wording also existed in three places with three
different texts. There is now one owner, and the guard catches mixed case.

### Fixed — the capability skills were downloaded and never applied

- The contract pointed at a **file** and never opened it, so a design skill
  could be installed and ignored. It now carries the skill's **normative
  rules** — the MUST / SHOULD / NEVER lines, selected semantically and never
  truncated — for **every** matched required skill.
- Only `required[0]` was injected, so a task matching two required skills
  silently lost the second. In the reported project, `fixing-accessibility`
  was installed and named by **no contract at all**.
- `load` searched exactly **one** path, so a skill installed above the project
  root was reported "not installed" by the tool that installed it. The search
  now walks the same roots the archgen skill itself is resolved from.
- `archgen_codegraph{ensure}` ran a **global `npm install -g` without
  approval**, while the tool documents "without `approve: true` the tool prints
  its plan and writes nothing".

### Changed — the dispatch discipline, which was missing entirely

- The verifier brief demanded "exactly one line", which is a ceiling on
  completeness: it found the first issue it was sure about, the orchestrator
  fixed it, and the next round found the next one. The brief now requires a
  **COVERAGE table** — every dimension PASS / FAIL / N/A — so one pass is
  provably exhaustive. **One holistic agent** over the whole plan, never one
  per dimension.
- A sub-agent is a **WORK unit, not a lookup**: status, wave frontier, plan
  health and the graph are one orchestrator tool call each.
- **MAX 3 PARALLEL SUB-AGENTS** at a time, with disjoint read *and* write
  footprints; gate agents never run while a wave is in flight.
- A follow-up that needs an agent's context **continues that agent's
  session**; the contract returns a `dispatchKey` to key the ledger on.
- The briefs carry the evidence map, the dependency graph and the
  reference-integrity result **already rendered**, so the sub-agent makes no
  tool call and the orchestrator spends no call assembling context.
- The CodeGraph directive is now **in the prompt** (server-detected) instead of
  only in prose, and every contract forbids reading the archgen skill and
  running the archgen tool suite — the contract IS the complete input.

### Changed — the agent-facing content is a third smaller

Every artifact the agent reads was rewritten: `SKILL.md`, the five protocol
references, the four dispatch briefs and the templates. The rules are denser,
each rule has exactly **one owner**, and the briefs carry a concrete worked
example instead of an abstract template.

| | Before | After | |
|---|---:|---:|---|
| `skill/SKILL.md` (always-on) | 8,240 | 6,916 | −16.1% |
| Protocol references | 17,676 | 12,431 | −29.7% |
| Dispatch briefs | 2,874 | 2,526 | −12.1% |
| **All agent-readable content** | 32,019 | 25,265 | **−21.1%** |
| **Always-on (SKILL.md + tool catalog)** | 13,103 | **11,280** | **−14.3%** |

### Fixed — the skill named two actions that do not exist

`SKILL.md` is **always-on**, so these were in the context of every session:
`archgen_docs` was documented with a `search` action (the real ones are
`refs` and `map`), and `archgen_registry` with a `read` action (it is
`show`). An agent following the table burned a round-trip on a typed
`INVALID_INPUT` and recovered by guessing.

There was **no gate** that said "the action names in SKILL.md must exist" —
the repo had drift gates for the references and a schema-parity gate for the
YAML, and nothing for the skill's own vocabulary. `skill-tool-vocabulary`
now reads the **live schemas** and holds the skill's tool table to them.

### Changed — the version lives in ONE place, and a release is ONE command

- `install.sh` rendered the managed block's stamp from a **literal**. It now
  reads the canonical config the CLI itself reads, so a release cannot forget
  to update it and it can never disagree with the CLI.
- `scripts/smoke.sh` hardcoded the tarball names; it now derives them from
  the canonical version.
- Every test that named a release version now derives it from the package.
  The semver **algorithm** fixtures moved onto a neutral series, so they are
  visibly arbitrary inputs rather than old archgen releases.
- **The version gate now DISCOVERS its surfaces** instead of carrying a
  hand-written list — from the **tracked** files, so a new package is covered
  the moment it is committed, and an untracked local artifact (the CLI's
  deliberately gitignored lockfile) can never fail a release. The gate also
  proves the version appears in **exactly one place**, and that `install.sh`
  carries no literal.
- **`npm run release:prepare <version>`** does the whole bump: the canonical
  version, the capability declaration, every derived surface, both lockfiles,
  and then **every gate**. A release can no longer be half-done.

### Removed — the VS Code extension

The extension is gone, and everything that existed only to serve it.

- **The extension package** (`packages/extension/`) — the task DAG, the
  code-dependency graph, the rendered-doc views, the activity-bar cockpit and
  the ▶ build button. It is deleted, not deprecated.
- **The filesystem UI bridge** (`packages/mcp/src/core/ui-channel.mjs`) — the
  heartbeat/command/acknowledgement queue under `.archgen/.runtime/`. It was a
  control plane for a UI that no longer exists.
- **`archgen_ui`** — the tool that spoke to that bridge. Its only consumer was
  the extension, so every action could only ever have answered
  `available:false`. The MCP catalog is now **9 tools** (8 domain +
  `archgen_help`), down from 10 — and the always-on context cost drops with
  it.
- **The extension's TypeScript YAML port** — a second implementation of
  archgen's YAML subset, which the corpus parity test existed to keep in
  step. One implementation is better than two kept in sync.
- **The `vextension-*` release stream** — the GitHub Release workflow that
  built and shipped the `.vsix`. Releases are now the two npm packages alone.

### Changed — the regression nets got stronger

Nothing was dropped without its replacement landing first.

- **The YAML corpus now has one owner, and it is the canonical parser.**
  `fixtures/yaml-corpus/*.expected.json` was asserted by the extension's
  suite and by nothing else — deleting the package would have silently
  deleted the only test holding archgen's artifact format. It is now pinned by
  `packages/mcp/test/core/yaml-corpus.test.mjs`, which asserts the parsed
  data, the comment ledger, the error messages and the round-trip (comments
  included, at their anchors).
- **The action matrix is now self-maintaining.** It carried a hard-coded
  floor of "at least 40 actions", which stopped discriminating once the
  catalog changed — and `archgen_skills{digest}` went untested for the whole
  life of the matrix. The gate now asserts that EVERY action the catalog
  exposes is driven by the matrix, so a new action cannot ship without a test
  and a removed action cannot leave a stale row behind.
- **`fixtures/tool-matrix/`** drives every action of every tool through the
  **real MCP binary** — 58 calls — so a broken tool fails the fixtures, not a
  user.
- Coverage is gated on the MCP server. The extension owned the repo's
  coverage gate; it now covers the runtime that owns every capability.

### Migration

- An agent driving an **older skill** against this server will call
  `archgen_ui` and get an unknown-tool error. Refresh the skill:
  `npx archgen-skill init` (or `archgen-skill update`).
- This release **requires the new server**: the skill calls
  `archgen_skills{action:'digest'}`, bare-slug sections, and briefs that carry
  rendered context. `metadata.requires.archgen_mcp` is now `>=0.1.0`, and
  `archgen_setup{action:'doctor'}` reports a mismatch instead of failing
  silently later.
- The `.archgen/.runtime/` directory, if present, is dead state from the old
  extension. `archgen-skill uninstall --project` now removes it; until then it
  is safe to delete by hand.

## [0.0.7] - 2026-11-07

This release is the hardening pass that followed the MCP-first cutover. A
line-by-line audit of all three packages found 50 defects; every one is fixed
here, each at its root cause rather than at its symptom. The ones that
changed what the tool DOES are listed first.

### Fixed — the agent could not see archgen's tools

- **OpenCode never saw archgen's tools.** OpenCode keeps its servers at
  `mcp.servers.<id>`, not `mcp.<id>`. The registry wrote `mcp.archgen`, so
  the entry landed exactly where OpenCode never looks: the harness reported
  the server as wired, and the agent saw **no archgen tools at all**. (The
  confusion was real: CodeGraph's own installer had put *its* entry in the
  right place, so the agent could see `codegraph_explore` and nothing else.)
  The writer now understands a dotted key path, and both registries — the
  writer's and the one the agent is briefed from — say `mcp.servers`.
- **`init` created a directory named `undefined`.** The CLI passed the project
  root as `projectDir` and the MCP facade read `projectRoot` — a
  property-name mismatch. The value never arrived, the child process was
  handed the literal string `undefined`, and it resolved that against its own
  working directory: the harness configs, the CodeGraph index and the managed
  blocks all landed in `undefined/` next to the real project. The project
  root is now **required and must be absolute**, and the guard turns the
  mistake into a named failure instead of a stray directory.
- **The project root carried the harness configuration.** `.mcp.json`,
  `.codex/`, `.gemini/` and the rest were written into every project. The
  server is one binary for every harness, so the wiring belongs in the
  harness's own **global** config — the project root now carries only the
  skill store, the artifacts, the index and the `AGENTS.md` / `CLAUDE.md`
  blocks. `--location-project` opts into the old per-project wiring.
- **OpenCode and Zed could not be wired at all.** Their configs are JSONC —
  they carry `//` comments — and a strict `JSON.parse` refused them, so they
  were left untouched: safe, but those two harnesses were silently never
  configured. The writer now understands JSONC and edits it **textually**, so
  the entry is spliced into the raw text and every comment, key order and
  unrelated setting survives byte-for-byte. Rewriting a JSONC file as plain
  JSON would have deleted the user's comments, which is as bad as not
  wiring it.

### Changed — one server for every harness

- **The MCP server is installed GLOBALLY**, so every harness names the same
  stable executable. The npx fallback pointed into npm's npx **cache**
  (`~/.npm/_npx/<hash>/…`), which `npm cache clean --force` removes — and
  the harness then fails to start a server that was wired minutes earlier.
  The global install is best effort: an offline machine or an unwritable npm
  prefix still gets a working install through the npx fallback.
- **The harness wiring is global by default**, so a project carries no MCP
  configuration of its own and a fresh clone needs no re-wiring.

### Fixed — security

- **The MCP server's boundary was model-controlled.** Every containment check
  was relative to a root the MODEL chose, so naming a different
  `projectRoot` moved the edge of what the server would read or write. The
  server now owns an **anchor** — the directory it was started in — and a
  tool's `projectRoot` is a *selector*: it must resolve inside the anchor, or
  the call is refused with `PERMISSION_DENIED`.
- **The extension's bridge could be talked into writing anywhere.** A command
  id became the acknowledgement file's name, and an id of
  `../../../../package.json` overwrote the workspace's `package.json`. Ids
  are now validated as file names at parse time, so the command never runs.
- **A symlinked document could be read out of the artifact space.**
  `.archgen/leak.md -> ~/.aws/credentials` passed a lexical prefix check and
  its contents were rendered. The real path of both the target and the
  `.archgen` root is compared now.
- **Restoring a snapshot removed every other installed skill.** The vault
  recorded a top-level directory name and the restore rebuilt the whole tree
  from it. It now records the exact backed-up paths and restores exactly
  those.
- **`archgen uninstall <dir>` performed a GLOBAL uninstall.** The positional
  form was accepted and then dropped, so it removed every archgen copy from
  the user's home directories. A positional directory now routes to the
  project uninstall.
- **The wiring manifest's paths were untrusted input.** The manifest is a
  file in the repository, so a clone could ship one naming any file on the
  machine and have `uninstall_mcp` edit it. Recorded paths are contained now.
- **The CLI's containment guard ran after the destructive step.** `install`
  deleted the existing Claude copy before asserting it was inside the
  project. The assertion comes first.
- **The global uninstall guard was a suffix test.** Any manifest path ending
  in `skills/archgen` was removed, including one outside the known harness
  directories; an edited copy was removed with no backup. The guard is an
  exact allow-list now, and an edited copy is backed up first.
- **On Windows the MCP server was spawned with a shell and unquoted
  arguments**, including the user's project path — a path with spaces was
  split and a path with `&` was interpreted by `cmd.exe`. The shim's JS
  entry point is invoked with node, with no shell.
- **The scope gate accepted any `.archgen` segment on the machine.** The
  artifact space is anchored to the project root now.

### Fixed — correctness

- **A status update could destroy the plan.** The emitter quoted VALUES but
  wrote KEYS verbatim, so a quoted key like `"odd: key"` was re-emitted
  unquoted and the file no longer parsed — every later tool call then failed.
  Keys are encoded exactly like values now.
- **Two workers in one wave could lose each other's status update.** The
  whole read-modify-write now runs under an exclusive on-disk lock: the
  workers are separate processes, so the guard has to live on disk.
- **The coverage report was inverted.** It said every UNCOVERED task was
  covered, because it re-derived "is this task mentioned?" from the checker's
  NEGATIVE findings — and an uncovered task's finding names the task. The
  checker now returns what it computed.
- **`archgen_setup{action:'uninstall_mcp'}` always failed** — the function was
  never imported.
- **Wiring any MCP config crashed when Codex CLI was installed.** The
  registry named an entry shape the writer did not know, so the loop threw
  and every harness after it was never configured. The registry and the
  writer now agree, and a test makes that agreement structural.
- **The npx fallback produced a command that could never start** — the npx
  form and the installed form are DIFFERENT COMMANDS, not one command with a
  swapped executable.
- **The wiring manifest recorded the wrong key**, so uninstall removed the
  wrong section.
- **`archgen_codegraph{action:'wire'}` installed and upgraded CodeGraph.**
  Its own help said it would not. It now only wires.
- **An installed CodeGraph is never upgraded.** The upgrade ran on every
  bootstrap, so a plain `npx archgen-skill init` could rewrite a working
  installation the user had pinned. CodeGraph is installed when it is
  MISSING and left alone when it is there.
- **A dispatched brief could contain `<slug dir>`.** Seven placeholders, two
  substituted, and the `slug dir` one given the bare slug. Every placeholder
  is filled in from ONE source now, and a brief that would still carry one
  is refused.
- **The resume snapshot could say "wave 3 of 2"**, and could be written
  outside `.archgen/`. One formula is used by both the file and the response,
  and the snapshot resolves its slug directory through the scope gate.
- **A missing file came back as `INTERNAL`.** The agent is told to branch on
  the code; "the file is not there" is a fact it can act on.
- **The DOCS "open in editor" button always opened the wrong path** — the two
  "open a document" routes disagreed about their base directory.
- **The board rendered dark in a light theme** until the user switched
  themes once.
- **The task board re-laid out its whole DAG on every model push**, although
  the layout depends only on the structure.
- **The long-running child processes blocked the whole stdio server.** A
  global install or an index build meant the server could not answer a
  single other request for up to fifteen minutes. Those operations are async
  now.
- **Two document reads could finish out of order**, leaving the DOCS tab
  showing the first document while the sidebar highlighted the second.
- **The host's "copied to clipboard" messages were discarded by the
  webview**, so the user got no confirmation of the action they triggered.

### Fixed — the installer

- **The store swap was not atomic**, despite the header saying it was: the
  old store was deleted before the new one was renamed in, so a failed rename
  left no store at all.
- **A migration could mutate a file it never backed up** — the framework and
  the migration computed their file lists at different moments.
- **The doctor could crash instead of reporting**: one unreadable file
  aborted the whole run, and a manifest without `entries` was a TypeError.
  A `FAIL` row now sets a non-zero exit code, which it did not.
- **A failed MCP bootstrap was reported as success.**
- **`--project` was a flag on `init` but a directory name**, so
  `init --project .` created a directory called `--project`. It is now
  accepted as a flag everywhere, and an unknown flag is a usage error rather
  than a directory name.
- **The global uninstall skipped a failed entry and then deleted the
  manifest**, so that entry could never be cleaned up.
- **The CLAUDE.md managed block was never version-upgraded** — it stayed
  frozen at the version of the first-ever init.
- **A non-semver registry version slipped past the refusal guard**, because
  the comparison returned "equal" for anything it could not parse.

### Changed

- **The npm publish workflow no longer assumes a lockfile exists.** The CLI is
  zero-dependency and deliberately ships none, so `npm ci` refused to install
  it (`EUSAGE`). The install step is now lockfile-aware.
- **The npm publish order is enforced**, not just documented: the CLI leg
  checks the registry for `archgen-mcp@<version>` and refuses to publish
  before the server is there.
- **The publish credential check is plain shell.** The previous inline
  `node -e` script could not run at all (`node -e` rejects a top-level
  `return`), so the check exited 1 in silence. It now runs on every npm
  version boundary and names both fixes when it refuses.
- **The capability-contract example is version-agnostic.** A concrete version
  in a doc or a comment is wrong at the next release and nobody notices. The
  examples now use the `>=x.y.z` placeholder the repo already used in
  `docs/releasing.md`, and `internal/tools/version-lint.mjs` keeps them that
  way — so no release ever has to go and update a comment again.
- **The UI command queue is pruned** by age and by count, so it is bounded by
  construction instead of growing for the life of the project.
- **`archgen_codegraph{action:'wire'}` no longer installs** anything, and the
  manual config writer honours the same `targets` filter the native path
  honoured.

### Added

- **Version drift gates.** `npm run sync:check` now also verifies that each
  committed lockfile's version matches its `package.json` (a mismatch makes
  `npm ci` refuse to install), and CI checks the same thing with the exact
  command that fixes it.
- **`npm run test:versions`** — the umbrella version check.
  `version-consistency.mjs` verifies every version surface against the
  canonical source and reports each mismatch with the command that fixes it.
  `version-lint.mjs` refuses a version pinned in an *illustrative* surface
  (a doc, a README, a reference asset, a source comment, the manual-test
  script) — examples show a shape, not a release, so no release ever has to
  go and update a comment by hand. The pattern is derived from the canonical
  version's `MAJOR.MINOR`, so the gate adapts as the project moves.
- **The coverage report is uploaded as a CI artifact**, so a threshold
  failure says *which* file fell below without a local reproduction.
- **`archgen_plan{action:'brief'}` accepts the inputs a brief genuinely
  needs** — a feature request, a topic, a round — and refuses a brief that
  would still carry a placeholder.

### Fixed — from the previous section

- **Generated artifacts now record the version that produced them.** The
  `scaffold` action wrote a bare `# generator: archgen` — no version at all —
  even though the server knows its own version exactly. The provenance header
  therefore said nothing about which release created the file, and the only
  guidance for the agent was a placeholder it could copy literally. The tool
  now writes the running server's version, and the reference tells the agent
  to paste that header verbatim and never type a version itself.
- **The extension read the MCP server's response on `'exit'`**, which fires
  before stdout is drained. On a fast runner the client could see an empty
  buffer from a server that had answered correctly and report
  `produced no JSON (exit 0)`. It now reads on `'close'`, which fires after
  the stdio streams are closed. The same race in `launchHarness` (its output
  tail could lose its last lines) and in the dispatch toast is fixed too. A
  deterministic regression test reproduces the original failure byte-for-byte.

## [0.0.6] - 2026-11-06

### Changed — BREAKING: the MCP server owns every capability

- **The skill ships no code.** `skill/scripts/*.mjs` (11 scripts + 5 lib
  modules) and their test suite are **deleted**. The skill is now guidance only.
- **New package `packages/mcp/`** (npm: `archgen-mcp`): the MCP server that
  owns all deterministic capability, built on the official
  `@modelcontextprotocol/server` v2 (2026-07-28 spec) with Zod v4.
  - 10 domain tools: `archgen_plan`, `archgen_tasks`, `archgen_docs`,
    `archgen_registry`, `archgen_codegraph`, `archgen_setup`, `archgen_ui`,
    `archgen_skills`, `archgen_refs`, `archgen_help`.
  - Every result is a typed envelope `{ ok, data, error, meta }` with a stable
    error-code taxonomy (`INVALID_INPUT`, `NOT_FOUND`, `CYCLE`,
    `OWNERSHIP_CONFLICT`, `CONFLICT`, `PERMISSION_DENIED`, `UNAVAILABLE`,
    `TIMEOUT`, `INTERNAL`).
  - A CLI facade (`archgen-mcp exec|bootstrap|doctor|uninstall-mcp`) lets the
    CLI installer and the VS Code extension reach the SAME handlers the agent
    uses — one implementation, three ways in.
- **One generic harness writer.** `core/harness-wiring.mjs` writes MCP entries
  for BOTH archgen and CodeGraph — one approval gate, one symlink guard, one
  idempotency check, one manifest-scoped uninstall. JSON and TOML (Codex CLI).
- **Real-time UI control.** `archgen_ui` drives the VS Code extension over a
  filesystem command queue (`.archgen/.runtime/cmd/` → `ack/`) with an
  allowlist, a workspace-root check, expiry, and idempotent replay. The data
  plane already worked (the extension's watcher); this adds the control plane.
- **CodeGraph** is installed, wired and indexed by the MCP server, which drives
  the official CLI and never reimplements it.
- **Installer wiring.** `archgen-skill init` / `install` now wire the archgen
  MCP server into every detected harness (new `--no-mcp` flag alongside
  `--no-codegraph`) and report an MCP-wired check in `doctor`.
- **Node floor raised to >= 20** (the official MCP SDK v2 requires it).

### Added — the capability contract

The skill calls the MCP server's tools — that is a dependency, and an
undeclared dependency is a latent outage: a skill at v1 driving a server at v2
whose action names changed fails SILENTLY (the agent calls a removed action and
improvises). It is now declared and enforced:

```yaml
# skill/SKILL.md frontmatter
metadata:
  requires:
    archgen_mcp: ">=0.0.6"
```

- `archgen_setup{action:'doctor'}` reports a `CAPABILITY MISMATCH` row.
- `archgen_setup{action:'bootstrap'}` reports the contract before wiring.
- A CI gate (`internal/tools/check-capability-contract.mjs`) refuses to ship a
  skill whose declared minimum exceeds the server's version.

### Added — `archgen_refs`, and the references moved into the package

The five orchestrator-facing protocol documents (`interview`, `orchestration`,
`artifact-templates`, `platforms`, `mcp-and-skills`) moved from
`skill/references/` into `packages/mcp/assets/references/` and are served
**section by section** by the new `archgen_refs` tool (`list` / `index` /
`read` / `search`).

**Why:** the references describe how to use the tools, so they must be the SAME
VERSION as the tools — and they must not be copied into every project that runs
`archgen-skill init` (56 KB per project, identical everywhere). Serving a
section costs ~1–2 KB against ~11 KB for a whole document, so the agent's
on-demand context went DOWN, not up.

`code-standards.md` stays a plain file in the skill: WORKER sub-agents read it
with their native file tools and may have no MCP server at all.

### Changed — the skill payload

The shipped skill tree is now `SKILL.md` + `references/code-standards.md` +
`archgen.config.json` — **9,190 tokens, down from 25,793**. Every `§` mark in
`SKILL.md` is an obligation ("load this section before acting"), the mode table
names the sections to load, and Hard rule 9 requires re-loading them after a
compaction.

### Added — the deterministic output became tool output

The skill keeps the **judgment** (policy, rules, when-to-use); the MCP server
owns the **deterministic output**. Four new actions, no new tools:

| Action | Replaces hand-assembly in |
|---|---|
| `archgen_plan{action:'scaffold'}` | the depth ladder's artifact set + the templates |
| `archgen_plan{action:'brief'}` | the verifier / review / survey / investigate briefs |
| `archgen_tasks{action:'contract'}` | the worker prompt contract (8 rules, assembled) |
| `archgen_setup{action:'harness_info'}` | the harness capability tables |

New canonical assets: `depth-ladder.json`, `platform-capabilities.json`,
`briefs/*.md`, `templates/*`. The artifact templates moved from prose examples
into `templates/*`, so the tool serves them and a copy can never drift.

### Added — capability skills as a tool

`archgen_skills` (match / install / installed / load / list) replaces the
skill's FETCH-SKILL prose and its JSON registry. Verified against the official
repos: the `skills` CLI installs ONE named skill non-interactively
(`npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json`) and
lands it at `<project>/.agents/skills/<slug>/SKILL.md`. No clustering — a
capability DOMAIN maps to ONE precise skill.

### Release

This release ships **three** artifacts at the same version (single-sourced from
`archgen.config.json`):

| Artifact | npm / distribution | Tag |
|---|---|---|
| `archgen-mcp` — the MCP server | npm | `vmcp-0.0.6` |
| `archgen-skill` — the CLI + the skill | npm | `vcli-0.0.6` |
| The VS Code extension | GitHub Release (`.vsix`) | `vextension-0.0.6` |

**Publish order: the MCP server first.** The CLI's installer resolves
`archgen-mcp` from the registry, so a release that advertises the MCP server
before it exists would hand users a broken bootstrap. The extension is
version-agnostic and can ship in any order.

### Fixed

- The extension's YAML port and the MCP core's parser now have a **parity
  test** over the shared corpus, so the two can never drift silently.
- Duplicate mapping keys are rejected consistently by both parsers (a plan
  file with a duplicate key is corrupt — silently taking the last value hid it).
- **Three latent template bugs**: the canonical artifact templates were prose
  examples that were never validated, and three of them carried YAML the parser
  REJECTS (`notes: >= 0` parsed as a block scalar; an unquoted
  `enum(a,b,c)` inside a flow mapping; a plain scalar containing `": "`).
  Moving them into the tool — where a test parses them — exposed and fixed all
  three.
- **The YAML-subset guidance was wrong**: flow mappings and sequences ARE
  supported (the parser accepts them and the corpus proves it). Only block
  scalars, duplicate keys and unterminated flow sequences are rejected.
- `references/platforms.md` drift corrected against the official docs
  (Antigravity's global path, Codex's legacy `~/.codex/skills/`, VS Code /
  Copilot's project path, Trae CN, and the Gemini → Antigravity transition).

## [0.0.5] - 2026-08-27

Enterprise-hardening release: restore reliability, security, performance
budgets, installer safety, and release hygiene across skill, CLI, and
extension.

### Added

- **Extension restore hardening**: `onWebviewPanel:archgen.taskBoard`
  activation event + `retainContextWhenHidden` so a quit/restart-restored
  board re-runs its `ready` handshake and renders with zero interaction; a
  webview watchdog re-posts `ready` (750 ms → 5 s backoff, capped at 2 min
  with an explicit Retry card) instead of spinning forever. Locked by
  `test/panel-restore.test.ts` + `MANUAL-TEST.md` §11 full-restart repro.
- **Fork smoke checklist** (`MANUAL-TEST.md` §16): human-executed release gate
  for VS Code forks (Cursor 1.4+, Windsurf) — open board, reload,
  quit+restart, search, build→clipboard, theme switch.
- **Accessibility scope documented**: WCAG 2.1 AA scoped commitment in the
  extension README — keyboard navigation, theme-variable contrast, aria-live
  for status pushes (third-party render internals explicitly out of scope).
- **CI hardening** (`.github/workflows/ci.yml`): skill/CLI matrix on Node
  20+22; extension typecheck/compile/test pinned to Node 22 with a HARD ≥90%
  coverage gate; cross-mode parity; version/vendor single-source check;
  `npm audit --audit-level=high`; gitleaks secret scan over full history;
  vsix built by CI and uploaded as the `archgen-extension-vsix` artifact —
  never committed to the repo.
- **`docs/releasing.md` single-source release flow**: bump the version in
  `archgen.config.json`, run `node packages/cli/scripts/sync-config.mjs &&
  node packages/cli/scripts/sync-vendor.mjs`, verify with `sync:check`.
- **Tag-triggered release workflow** (`.github/workflows/release.yml`):
  pushing a `vextension-*` tag runs the extension gates, builds the vsix, and
  publishes a GitHub Release with the vsix attached — no manual upload step.
- **Root monorepo scripts**: a private, scripts-only root `package.json` —
  `npm run setup` (once) installs extension deps, `npm test` runs the skill +
  CLI + extension suites CI runs, plus `test:fixtures`, `sync`, and
  `sync:check` aliases. Deliberately not npm-workspaces (the extension keeps
  its own lockfile + native rebuild); no root `version` field (single source
  stays `archgen.config.json`).
- **Community policies**: `SECURITY.md` (private vulnerability reporting via
  GitHub advisories or email) and `CODE_OF_CONDUCT.md` (Contributor Covenant
  2.1).

### Changed

- Extension: SETUP folded out of the tab strip into a centered dialog opened by a new ⚙ header button (⋯ menu too); empty-state copy tightened; sidebar clicks (feature/task/doc) now land you on the right board view.
- README installs point at the CI-built vsix on GitHub Releases instead of an
  in-repo vsix file.
- Version is single-sourced: `archgen.config.json` is now the only place the
  version is edited; sync-config propagates it to the skill config, SKILL.md
  frontmatter, and both package.json files (CI `vendor-check` fails on drift).

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

### Fixed

- **Security (extension)**: markdown-it `validateLink` allowlist blocks
  `javascript:`/`data:text/html`/other-scheme XSS in rendered docs (degrades
  to literal text); task ids are sanitized before reaching the harness
  `{{outfile}}` path (no tmpdir traversal); all codegraph SQL identifiers are
  quoted; harness `spawn` delivery is refused in untrusted workspaces
  (clipboard delivery unaffected).
- **Security/safety (CLI installer)**: no write-through-symlink anywhere
  (lstat-based guards incl. parent-dir escapes); copy-mode installs back up
  foreign targets before replacing; managed-block markers normalize to exactly
  one pair; `install.sh` parity with CLI semantics.
- **Extension perf**: codegraph re-send gated by DB stat (unchanged index →
  zero re-read/re-serialize); search input debounced (200 ms) with ≤2
  relayouts per burst; dagre layouts cached per component; codegraph focus and
  selection survive live background updates (no more ghost-selection dimming).
- **Extension readers**: warn-don't-throw tolerance locked for dup ids,
  invalid statuses, empty/CRLF/unicode docs; corrupt sibling features degrade
  to a warning while the active board renders; 10k-task parse <500 ms.
- Extension: the kickoff-prompt input was a top-center native quick-input jump; it now opens as a centered modal inside the Task Board itself (Enter copies, Esc cancels), while non-board entry points keep the native input.
- Clicking a Docs-tree entry could update an invisible board; documents now
  open the board directly on their page.
- `CONTRIBUTING.md` repo map now names the CLI package correctly
  (`archgen-skill`, not `archgen`).

## [0.0.4] - 2026-08-26

### Added

- **Artifact intelligence layer** — two zero-dependency graph tools ship inside
  the skill, because audited codegraph-family indexers extract source symbols
  only (no markdown headings, no YAML task semantics):
  `scripts/plan-graph.mjs` queries the task DAG (`--node <id>` transitive
  neighborhood with distances, `--mermaid [--status]` flowcharts,
  `--module <name>` filter), and `scripts/doc-index.mjs` indexes markdown
  artifacts (heading tree, `--refs-to` backlinks across TASK/FR/ADR/path
  references, `--validate` broken-reference gate, `--stale` freshness audit,
  `--diagrams` inventory). Both are scope-hardened to `.archgen/<slug>/`
  (symlink and look-alike escapes refused), dedup-guaranteed
  (`duplicatesCollapsed` / realpath file inventory / unique-ref counting /
  duplicate FR-definition detection), scale-guarded (iterative traversals,
  800-task stress-tested, whole-graph renders refuse >250 nodes with scoping
  hints, deterministic truncation markers past 100 files), and surface a
  non-fatal `quality:{selfDeps,emptyOwnership,blankAcceptance}` facts block.
- **No-fallback dispatch policy**: tasks go to the platform's native sub-agent
  mechanism; when sub-agents are unavailable or fail (including missing tool
  permissions) the main agent executes the task itself. Switching to another
  harness/platform requires telling you the concrete issue and getting your
  explicit approval first — automatic headless-CLI worker fallbacks are gone.
- **PLAN-REVIEW stage**: the gate sequence is now verifier → plan-review →
  user. After verifier APPROVE, reviewer sub-agent(s) sized by scope class
  audit edge cases, task ordering, cross-module contracts and documentation
  completeness; artifacts iterate until zero findings or explicit waiver.
- **Root-cause investigation protocol**: recurring post-implementation issues
  trigger complexity-sized investigators (main agent for small scopes, 1–3
  split by subsystem otherwise) producing root cause, evidence and blast
  radius before any fix task is written — patch-fixing without a root cause
  is forbidden.
- **Mandatory capability-skill loading**: registry entries carry a `policy`
  field; UI/design/frontend work requires the design skills fetched and
  followed before planning and dispatch, with a one-line compliance note in
  every affected worker completion report.
- **Professional plan depth**: interviews classify intent (GREENFIELD-SYSTEM
  through BROWNFIELD-CHANGE) with survey-before-questioning for brownfield;
  greenfield systems get PRD-grade artifacts — requirements with stable
  FR-ids, naming/data/API contracts, environment matrix, per-module Mermaid
  diagrams, and edge-case matrices wired to acceptance criteria — under
  self-containment rules that pin every path verbatim so no session
  hallucinates file names after context summarization.
- **Status discipline (non-negotiable)**: every completed task updates
  tasks.yaml, the todo tracker and the AGENTS.md registry timestamp in the
  same turn; batching status writes to session end is forbidden.
- **MCP installs discover their method via web search** when the current
  command/config shape is not known with confidence, then apply it at the
  correct scope — that specific harness's config, or global for npx-style
  servers — behind the existing approval gate.
- **Proactive setup UX**: the extension now wakes on startup even before a plan
  exists and detects three states — archgen skill missing, skill installed but
  no `.archgen/` plan yet, and installed-but-outdated skill (via a new
  `.archgen-version` stamp written by the CLI on every install/init/update,
  readable through symlink layouts). Each state gets a one-time notification
  (signature-keyed dismissal, never nagging), a status-bar shortcut, and a
  non-blocking **Setup panel** whose buttons copy ready-to-paste prompts that
  give your agent full context to install / initialize / update. Everything
  keeps working on older skill versions — updating is recommended, never
  required. New command: `ArchGen: Open Setup Panel`.
- **Clipboard-first delivery**: ▶ Build This Task and ▶ Start Work now copy the
  composed prompt to the clipboard and ask you to paste it into any agent chat —
  reliable across VS Code, Cursor, Windsurf, VSCodium and every agent harness,
  with no CLI or IDE API required. New settings: `archgen.delivery.mode`
  (`clipboard` | `spawn`) and `archgen.delivery.autoFillChat` (best-effort
  pre-fill of the IDE's native chat input; never auto-sends).
- **Activity-bar cockpit**: the single launcher view becomes three sidebar
  views — Overview (feature switcher + live progress summary), Tasks
  (status-grouped live task tree with per-task ▶ build), Docs (quick-open).
- **Start Work** and **Open Board** view-title actions on the cockpit views.
- Native welcome states in each view when no `.archgen/` plan exists.
- Status bar running indicator while a build is in flight.
- **Central config (`archgen.config.json`)**: one canonical file at the repo root
  now pins the version, managed-block markers and well-known filenames;
  `npm run sync` propagates it into SKILL.md frontmatter, package.json and the
  vendored skill copy — ending the SKILL.md-says-1.0.0-vs-CLI-ships-0.0.x drift,
  with a CI vendor-freshness gate so stale publishes are impossible.
- **`archgen-skill restore`**: lists backup snapshots across the project vault
  (`.archgen/.backup/`) and the per-harness global vaults; `--snapshot <ts>`
  restores one, moving the current state into a fresh safety snapshot first.
- **`archgen-skill migrate [--check|--apply]`**: framework for evolving
  generated-artifact formats in place — dry-run by default, every touched file
  backed up before modification. Ships migration `001-stamp-provenance`, which
  stamps `# schema_version` / generator / generated-at comments onto
  `.archgen/*/tasks.yaml` and `architecture.yaml`.
- **Versioned managed blocks**: AGENTS.md/CLAUDE.md blocks now open with a
  `<!-- archgen:block vX.Y.Z -->` provenance line, and init/doctor upgrade
  legacy unversioned blocks to the current format in place automatically.
- **Backup-before-replace on global `--copy` installs**: destinations are
  fingerprinted first — identical trees skip like link mode, divergent ones move
  into `<skills-dir>/.archgen-backups/<timestamp>/` before replacement.
- **Dangling global symlink self-repair**: `install` recreates symlinks whose
  target was evicted (npx cache cleanup) against the current source instead of
  reporting SAME on a broken link.
- **Doctor block-upgrade detection**: stale-format managed blocks are reported
  (`UPGRADED`, or would-upgrade under `--check`) instead of passing silently.

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

### Fixed

- The installer no longer records foreign symlinks (targets that predate us) in
  the uninstall manifest, so `uninstall` removes only what archgen installed.
- Doctor reports broken marker states (orphan/duplicate/reversed markers) as
  FAIL rows instead of aborting the whole run.
- `validate`, `set-status` and `impact` report clean one-line errors (no raw
  stack traces) for unparseable or missing files.
- `set-status` no longer reopens done work via done→failed without `--force`.
- Duplicate YAML keys inside a task are rejected instead of silently last-wins.
- The schema id pattern/type is enforced, so numeric-coerced task ids fail
  validation fast.
- The board's ▶ Start Work button silently did nothing (its message was never
  routed). Both webview↔host message switches now fail compilation if a future
  intent is added without a route.
- Task acceptance criteria were parsed from tasks.yaml but never shown; they
  now appear in sidebar task tooltips and board node hover details.
- Invalid install hint `npx archgen-skill generate` (no such CLI verb)
  corrected to the real `npx archgen-skill init` + agent phrase in the welcome
  views and the board empty state.
- Prompt-injection hardening in harness dispatch: task titles containing
  quotes/backslashes can no longer corrupt spawned argv or smuggle instructions
  (values are escaped at template interpolation and decoded by a hardened argv
  splitter, proven against an adversarial test suite).
- Board refreshes that changed anything beyond id/status/doc paths (warnings,
  acceptance, …) were deduped away and never reached the UI; the model
  fingerprint now covers the full payload.
- Board empty-state was a dead end after `archgen-skill init` (it re-instructed
  the same command while the real next step is generating a plan); it is now
  setup-aware — skill-installed workspaces get a 'Copy kickoff prompt' action —
  and the board replays the setup snapshot whenever it opens.

### Changed

- ▶ actions deliver work via the clipboard by default. Set
  `archgen.delivery.mode` = `"spawn"` for the previous headless CLI behavior
  (unchanged byte-for-byte).

## [0.0.3] - 2026-08-25

### Changed

- **Single-store installs**: `archgen-skill init` now writes exactly ONE skill
  copy at `.agents/skills/archgen` (the agentskills.io standard location read
  natively by OpenCode, Cursor, Codex, Gemini CLI, Copilot and Antigravity).
  Claude Code gets a relative symlink at `.claude/skills/archgen` — the only
  harness needing it. No more duplicate skill folders per project.
- **CLAUDE.md is a one-line bridge** (`@AGENTS.md`, Anthropic's documented
  pattern). Existing files keep all user content; files already importing
  AGENTS.md are left untouched.
- **AGENTS.md is a living hub**: managed block now carries a features registry
  (slug · status · updated) maintained by the new `update-agents.mjs` skill
  script after every generate/work cycle.

### Added

- `archgen-skill doctor [--check]`: verifies store integrity, version stamp,
  Claude link, block uniqueness, manifest resolution — auto-repairs what's safe.
- `archgen-skill uninstall --project`: surgical removal — strips managed blocks,
  our symlink and an unmodified store only; feature folders in `.archgen/` and
  all user content are preserved.
- Ownership verification before every mutation: divergent skill copies are
  backed up to `.archgen/.backup/<timestamp>/` instead of overwritten; legacy
  dual-copy layouts migrate to symlinks automatically.
- Install manifest (`.archgen/.install-manifest.json`) records everything the
  installer creates.

## [0.0.2] - 2026-08-25

### Added (hardening)
- **Anti-compaction rules** — new Hard rule 9 (assume compaction: the FIRST
  tool call after summarization must be re-reading `.archgen/<slug>/tasks.yaml`
  + `next-tasks.mjs` + `.agent/resume.md`; tasks.yaml is ground truth; never
  cite state un re-read) and `.agent/resume.md`, an ≤10-line re-entry snapshot
  rewritten after every wave (slug, wave index, done/failed/blocked ids, the
  resume command, remaining plan sections).
- **CodeGraph for understanding** — the skill now directs agents to prefer
  CodeGraph (`codegraph_explore` / `codegraph node`) whenever they need to
  understand the codebase, and the worker prompt contract carries the same
  directive. Never re-index: the server's file watcher keeps the index live.
- **Drift guards** — `.githooks/pre-commit` (sync single-source check),
  CI `.codegraph/` never-tracked guard, `skill-registry` whole-word matcher
  test, documented Windows parity path (`npx archgen-skill`), internal-vs-
  shipped import boundary in CONTRIBUTING.md.

### Fixed

- **CLI**: the published tarball now ships a proper `README.md` — the npm package
  page previously rendered without one (the README lived only at the repo root).
- Corrected repository links in the CLI `--help` footer and `install.sh`
  (`github.com/akash/archgen` → `github.com/akashmaurya99/archgen`).

### Changed

- Binary name aligned with the package: global installs now expose
  `archgen-skill` (was `archgen`); `npx archgen-skill …` usage is unchanged.
- Package metadata: added `homepage` and `bugs`, refined keywords.

## [0.0.1] - 2026-08-25

### Added

- **Skill**: archgen agent skill with 7 workflow modes, a plan-verifier gate
  (APPROVE/blocks on cycles, overlaps, unknown refs), and wave-based task
  execution (`next-tasks` / `set-status`).
- **CLI** (`packages/cli`, published as [`archgen-skill`](https://www.npmjs.com/package/archgen-skill)): `archgen init` (project-local skill copies +
  AGENTS.md/CLAUDE.md pointer blocks), `archgen install` / `--uninstall`
  (multi-harness global installer with manifest-recorded removal).
- **VS Code extension** (`packages/extension`): DAG view, code-graph view,
  docs view, and build button over `.archgen/` artifacts.
- Multi-harness support: Claude Code, agentskills.io generic layout, OpenCode,
  Cursor, GitHub Copilot (project-local), plus `install.sh` symlink/copy
  installer with uninstall manifest.

[0.0.6]: https://github.com/akashmaurya99/archgen/releases/tag/vextension-0.0.6
[0.0.5]: https://github.com/akashmaurya99/archgen/releases/tag/vextension-0.0.5
[0.0.4]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.4
[0.0.2]: https://github.com/akashmaurya99/archgen/releases/tag/vcli-0.0.2
[0.0.1]: https://github.com/akashmaurya99/archgen/releases/tag/v0.0.1
