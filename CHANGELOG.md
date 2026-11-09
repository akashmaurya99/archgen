## [Unreleased]

Nothing yet.

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
