# Architecture

How archgen works internally. This document describes the system as implemented in [`skill/SKILL.md`](../skill/SKILL.md) and its references — nothing here is aspirational.

## MCP-first operation

archgen has ONE implementation of every deterministic capability, and it is the
`archgen-mcp` server (`packages/mcp/`). The skill ships **no code** — it is
orchestration guidance for the agent. Two consumers reach the same
implementation:

1. **Agent.** The MCP server over stdio. Eight domain tools
   (`archgen_plan`, `archgen_tasks`, `archgen_docs`, `archgen_registry`,
   `archgen_codegraph`, `archgen_setup`, `archgen_skills`, `archgen_refs`)
   plus `archgen_help`; every result is a typed envelope
   `{ ok, data, error, meta }`.
2. **CLI installer.** `archgen-skill init` / `install` shells out to
   `archgen-mcp bootstrap` to wire the MCP server into every detected harness
   and ensure CodeGraph. The CLI itself stays zero-dependency.

Both read the same artifacts and the same task-file schema
(`schemas/tasks.schema.json`); the frozen YAML corpus (`fixtures/yaml-corpus/`)
plus its corpus test keep the MCP core's parser pinned to a known contract.

## The containment model

The server takes paths from a model, and a model can be talked into reading a
private key. So the server owns a boundary:

- The **anchor** is the directory the server was started in — the project the
  CLI named, or the cwd an MCP client started it in. It does not change per
  call.
- A tool's `projectRoot` argument is a **selector**: it must resolve inside
  the anchor, or the call is refused with `PERMISSION_DENIED`. It cannot
  redefine the boundary — that is what made the old containment checks
  worthless, since they were measured against a root the model supplied.
- Every path derived from a project root is resolved through the anchor and
  contained again, and a symlinked parent is caught by comparing **real**
  paths, not by a textual prefix.
- A file inside a contained directory is still checked: a document whose real
  path lands outside the artifact space is refused, because a repository can
  ship `.archgen/leak.md → ~/.aws/credentials`.

The same principle runs through the installer: it asserts containment
**before** it mutates anything.

## The gate flow

No task executes until the gates pass, in order — never skipped. Gate **depth**
scales with the profile; the deterministic floor runs for every scope:

1. **The floor, first.** `archgen_plan{action:'verify'}` is the deterministic
   truth and it runs BEFORE any gate agent is dispatched: cycles, dangling
   refs, same-wave ownership overlap, plan↔task coverage, the **mirrored test
   tree**, **matrix citations that resolve**, **PRD requirements that are
   cited**, **decision files that exist**, **declared paths that have an
   owner**, and **wave labels that match the DAG**. The orchestrator fixes
   every issue it reports and re-runs until `APPROVE` — a local loop, at zero
   agent cost. A gate agent that never sees a mechanical defect can spend its
   pass on judgment.
2. **Verifier gate.** Judgment scales: SMALL is audited by the main agent;
   MEDIUM by one strong verifier sub-agent; LARGE by one top-tier verifier.
   The brief carries the floor's result and four rendered maps — requirement
   map, edge-case matrix map, ownership map, module DAG — so the agent checks
   ALIGNMENT (does the acceptance a matrix row cites verify the stated case?)
   instead of re-deriving facts. Findings are classified **BLOCKING**,
   **NIT** (cosmetic, never blocks), or **OBSERVATION** (a capability nobody
   asked for, never blocks). The verifier may not invent requirements: a
   missing capability that no PRD, decision or `answers.yaml` asked for is an
   observation, not a defect.
3. **Plan review.** Zero findings, or an explicit user waiver. SMALL/MEDIUM are
   reviewed by the main agent against the profile; LARGE gets one independent
   reviewer. Review areas include `scope fit & minimalism`.
4. **User gate.** The orchestrator presents the artifact list with
   create/reuse/omit decisions, the wave summary (`archgen_tasks{action:'next'}`),
   and the ownership map, and asks "Approve to start work?"

**The gate runs at most twice.** Round 1 is exhaustive; round 2 is a delta
re-check of round 1's findings. There is no round 3 — whatever remains is
escalated to the user with the outstanding list. That cap, plus the floor
before the agent, is what turned a four-round review into one.

A gate pass is ONE holistic agent over the WHOLE plan — never one agent per
dimension or per concern. Cross-issue reasoning catches contradictions a
narrow slice misses, and one agent costs a fraction of several.

The gate briefs are tool output, and they carry their context **rendered**:
the evidence map (every artifact and its section anchors), the dependency
graph, and the reference-integrity result. The sub-agent therefore makes no
tool call of its own, and the orchestrator spends no call assembling
context — which is also why the brief is read from any working directory
(every path in it is absolute).

## Scope is an evidence decision

`archgen_plan{action:'profile'}` is read-only and deterministic: an intent
baseline plus explicit signals (module count, public contracts, migrations,
security surface, production/product-facing, existing host documents, …)
produces a score, a `SMALL` / `MEDIUM` / `LARGE` class, a confidence, and one
`create` / `reuse` / `omit` decision per artifact with a reason.

Two rules stop the old "everything is LARGE" default: **missing evidence never
pushes the class up** (a thin profile stays low-confidence and asks exactly one
question), and **each artifact is decided independently** (a LARGE plan may
still omit ADRs and diagrams). Existing host PRDs, architecture docs, and ADRs
come back as `reuse`; the plan records the path and writes only the delta.
`scaffold` then serves only the skeletons for the required set, and the plan's
`## Profile` section (or `answers.yaml plan_profile:`) records every decision so
the verifier can audit it.

## Wave execution & ownership discipline

`archgen_tasks{action:'next'}` resolves the dependency frontier into topological waves. A cycle or an ownership clash comes back as the typed error codes `CYCLE` / `OWNERSHIP_CONFLICT` — the orchestrator fixes `tasks.yaml` before proceeding.

- **One worker per task.** Workers receive: task id + title, acceptance criteria verbatim, their `file_ownership` globs ("edit NOTHING outside these"), the code-standards reference, the **normative rules of every matched capability skill**, the pre-located doc sections, the CodeGraph directive when the project is indexed, and the done/failed status command. Workers never talk to each other; coordination happens only through `tasks.yaml` state.
- **Disjoint globs per wave.** Two same-wave tasks may not overlap on file ownership — enforced by the resolver and rejected by the verifier.
- **Dispatch discipline.** A sub-agent is a WORK unit, not a lookup: status, wave frontier, plan health, graph and registry are always one orchestrator tool call, never a sub-agent. **At most 3 parallel sub-agents at a time** — a larger wave runs in batches of three. Parallel sets must have disjoint read AND write footprints; gate agents never run while a wave is in flight.
- **Session reuse.** A follow-up that needs an agent's context — a fix in files it touched, a clarification, a re-check of its own output — CONTINUES that agent's session. The contract returns a `dispatchKey` so the orchestrator's ledger is keyed by the tool's own value.
- **Dispatch tiers** (`archgen_refs` → `orchestration.md`): Tier 1 uses native sub-agents where the harness is strong (Claude Code background agents with worktree isolation; Cursor background subagents; Antigravity `invoke_subagent`; Codex flattened plans; Gemini hub-and-spoke for read-only waves). Tier 2 is a universal bash fallback spawning parallel workers over headless CLIs (`claude -p`, `opencode run`, `codex exec`, `gemini`, `agy`), with git-worktree isolation when ownership borders are tight.
- **Failure policy:** worker failure marks the task `failed` — never auto-retried. Downstream tasks stay blocked via `blockedByFailure`. The user sees the failed id, log path, and a proposed fix task; fix tasks get fresh ids and inherit the failed task's ownership.

## Git as the VCS decision

archgen does not build its own history layer — **git is the history layer, and the plan of record lives in it.** Workers commit their own work; the orchestrator commits the artifact state each wave changed (the updated `tasks.yaml`, and the `.agent/` notes, decisions and reports) with that wave's commits, and the plan itself is committed before the first wave. Every archgen artifact is **tracked**: the plan, the installed skill store, the harness bridge, `AGENTS.md`/`CLAUDE.md` and the project MCP config — never gitignored, because an artifact nobody can see in `git log` is not a record of anything. Rollback is `git revert` of the task's commits in reverse dependency order (with status rewinds via `archgen_tasks{action:'set_status', force:true}`, gated on explicit user approval since it's destructive). Done tasks are never deleted from `tasks.yaml` — history lives in git.

## Dot-folder convention

Everything generated goes inside `.archgen/<project-slug>/` at the target repo root — the artifacts the profile marks create: `tasks.yaml`, plans, and, only with a trigger, `architecture.yaml`, PRD docs, ADRs in `decisions/`, diagrams, and worker/gate state under `.agent/` (`notes/`, `reports/`, `resume.md`). Nothing else is written outside it except source edits performed by approved-task workers. Generation is right-sized by evidence: a localized change gets a plan note + `tasks.yaml` + a recorded profile; a real feature adds the contract and depth its signals justify; only a production, product-facing, multi-module system gets the full stack. Existing host documents are cited, never regenerated, and every omit/reuse decision is recorded in the plan's Profile section. The whole `.archgen/<slug>/` tree is **version-controlled** — it is the plan of record, not scratch space.

## Platform detection & web-search fallback

Step 0 asks the server: `archgen_setup { action: 'harness_info' }` detects the
harness from env/config markers in order (`.claude/`, `.cursor/`, `.windsurf/`,
`.opencode`, `.github/copilot-instructions.md`, `~/.codex`, `.gemini/`, `.kiro/`,
`.trae/`) and returns its capability row — skill install paths, MCP config file +
top-level key + entry shape, the MCP CLI, restart semantics, and the sub-agent
dispatch mechanism. The canonical data is
`packages/mcp/assets/platform-capabilities.json`; `archgen_refs` →
`platforms.md` keeps
the narrative and the detection order. If no platform matches, the orchestrator
uses its web-search tool to find official docs for skill/MCP config locations,
proposes findings, and proceeds only after user approval.

## MCP and skill-fetch subsystems

Two support modes round out the loop:

- **INSTALL-MCP.** When a needed MCP server (e.g. context7) isn't configured, the
  orchestrator reads the platform's config quirks from
  `archgen_setup { action: 'harness_info' }` (VS Code uses `servers`; OpenCode
  uses `mcp` with array commands; Antigravity requires `serverUrl`), prefers the
  platform CLI (`claude/codex/gemini/copilot mcp add …`), otherwise drafts the
  exact config diff and shows it. Configs are written only after approval, then
  verified post-reload.
- **FETCH-SKILL.** The registry, the matching, the install and the
  follow-instruction all live in the `archgen_skills` tool
  (`packages/mcp/assets/skill-registry.json`). A task whose title, summary or
  file ownership matches a capability domain (frontend/UI → ui-skills) is matched
  by WHOLE-WORD patterns; a `required` hit is installed before dispatch — exactly
  ONE skill, never a bundle, via
  `npx -y skills add <repo> --skill <slug> --agent <agent> --yes`. The skill lands
  at `<project>/.agents/skills/<slug>/SKILL.md`, and the worker is pointed at
  that file. Missing capabilities trigger a web search for a reputable skill
  repo, proposed to the user and added to the registry on approval.

  The skill's **normative rules travel INTO the worker contract**, not beside
  it: a path pointer is a file the worker may never open, and a skill that is
  never opened is a skill that is never applied. Every matched required skill
  is included — the old contract injected only the first one, so a second
  installed skill was silently dropped. `archgen_skills{action:'digest'}` and
  `{action:'load', section}` are the lens for pulling one section of a skill
  when the agent decides it needs more. The install search walks the same
  roots as the archgen skill itself, so a skill installed above the project
  root, or under a harness directory, is found.

## The judgment / output split

The skill holds the **judgment** — policy, rules, when-to-use, authoring craft.
The MCP server holds the **deterministic output** — artifact sets, skeletons,
dispatch briefs, assembled worker prompts, harness capability tables.

The five orchestrator-facing protocol documents moved INTO the MCP package
(`packages/mcp/assets/references/`) and are served section-by-section by
`archgen_refs`. They live there so they are always the same version as the
tools they describe, and so they are not copied into every project that runs
`archgen-skill init`. One exception stays in the skill as a plain file:
`code-standards.md`, because WORKER sub-agents read it with their native file
tools and may have no MCP server at all.

The references point at the tools; they never restate a tool's output. A drift
test (`packages/mcp/test/core/reference-drift.test.mjs`) pins the two together,
so a number that appears in both can never disagree.

## The capability contract

The skill calls the server's tools — that is a dependency, and an undeclared
dependency is a latent outage. So it is declared:

```yaml
# skill/SKILL.md frontmatter
metadata:
  requires:
    archgen_mcp: ">=x.y.z"
```

`archgen_setup{action:'doctor'}` reports a mismatch, `bootstrap` warns before
wiring, and a CI gate (`internal/tools/check-capability-contract.mjs`) refuses
to ship a skill whose declared minimum exceeds the server's version.

| Tool output | Replaces hand-assembly in |
|---|---|
| `archgen_plan { action: 'profile' }` | the scope score + per-artifact create/reuse/omit decisions + depth budgets |
| `archgen_plan { action: 'scaffold' }` | the depth ladder's artifact set + skeletons |
| `archgen_plan { action: 'brief' }` | the verifier / review / survey / investigate briefs |
| `archgen_tasks { action: 'contract' }` | the worker prompt contract (8 rules) |
| `archgen_setup { action: 'harness_info' }` | the harness capability tables |

## The no-dead-action gate

Two capabilities shipped DEAD and the unit tests did not notice, because a
code path nobody exercises cannot fail in a test that never calls it:

- `archgen_plan{action:'graph'}` threw `ReferenceError: opts is not defined`
  on every call, for every project, forever. A module-level function read a
  variable from its CALLER's frame. The review brief has told the orchestrator
  to attach the graph since the day it was written, so every plan review had
  been running without it.
- `archgen_docs{action:'section', section:'<slug>'}` failed on every plan,
  because the whole argument was treated as a FILE path — while `digest` hands
  out section SLUGS. The digest→section round trip, the primary way an agent
  reads an artifact, was broken by construction.

And one shipped a literal placeholder: every worker prompt began
`<Domain> work: follow …`. The briefs had a `remainingPlaceholders` guard; the
worker contract had none.

So the gate is behavioural, not structural:

- **`packages/mcp/test/contract/action-matrix.test.mjs`** drives EVERY action
  of EVERY tool against a real project and asserts it succeeds, that it never
  reports `INTERNAL`, and that the briefs and worker contracts carry no
  unsubstituted placeholder.
- **`fixtures/tool-matrix/run.sh`** does the same through the REAL MCP binary
  and the REAL stdio transport — proving the whole path, not just the handler.
- A brief may only name the archgen calls its allowed-call list permits
  (`core/brief-context.mjs`), so a sub-agent cannot be sent to re-derive a
  fact the brief already carries.

## Provenance & migration

Every artifact archgen writes carries machine-readable provenance, and every mutation is backup-first:

- **Skill trees** carry a `.archgen-version` stamp (`MAJOR.MINOR.PATCH\n`) at their root — rewritten by the CLI on init/install/update; `doctor` and the MCP server read it to flag outdated copies (absent = "unknown (legacy)", never an error).
- **Managed blocks** in AGENTS.md/CLAUDE.md open with a `<!-- archgen:block vX.Y.Z -->` line; init/doctor normalize legacy unversioned blocks to the current format in place.
- **Generated artifacts** under `.archgen/<slug>/` open with `# schema_version:` / generator / generated-at comments. `archgen-skill migrate --check` lists artifacts missing stamps; `--apply` adds them, backing up each original into `.archgen/.backup/<ts>/migrate/`.
- **`archgen-skill restore`** lists snapshots from the project vault (`.archgen/.backup/`) and per-harness global vaults (`<skills-dir>/.archgen-backups/`); restoring a snapshot first moves the current state of every affected path into a fresh safety snapshot.
- **Backup-first policy**: divergent stores, divergent global `--copy` destinations and about-to-be-restored paths are always moved aside before replacement — archgen never destroys state it did not just back up.
