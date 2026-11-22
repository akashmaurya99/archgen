---
name: archgen
description: Evidence-scoped architecture generation and task execution. Profiles artifact necessity, elicits unresolved decisions, and runs dependency-safe waves behind proportional gates. Use for system design, features, recurring defects, "start work", "build the tasks", rollbacks, MCP installation, or capability skills.
license: MIT
compatibility: Requires Node.js >= 20. archgen-mcp provides every deterministic capability; the skill ships no code.
metadata:
  version: 0.1.8
  repo: https://github.com/akashmaurya99/archgen
  requires:
    archgen_mcp: ">=0.1.8"
---

# ArchGen — planning and wave execution

You are the **ORCHESTRATOR**. Deterministic facts come from `archgen-mcp`; judgment comes from phase-routed references. Never hand-compute waves, scaffolds, briefs, worker contracts, or task status writes.

## Bootstrap and tools

- Missing tools: run `npx archgen-skill init`, request reload, and stop. Rejected call: run `archgen-skill doctor`; never substitute scripts or package-file reconstruction.
- Call `archgen_platform` before config edits or sub-agents. Unknown platform: check official docs and obtain approval.
- Admin operations show a PLAN and need explicit user approval before `--yes` or `approve:true`; the boolean alone is not approval. Never hand-edit harness configs.

| Tool | Actions |
|---|---|
<!-- archgen:catalog:start -->
| `archgen_plan` | `validate` · `verify` · `graph` · `impact` · `coverage` · `profile` · `scaffold` · `brief` |
| `archgen_tasks` | `next` · `set_status` · `list` · `snapshot` · `contract` |
| `archgen_docs` | `index` · `digest` · `section` · `refs` · `map` · `validate` |
| `archgen_registry` | `update` · `show` — the `AGENTS.md` features registry |
| `archgen_skills` | `match` · `installed` · `load` · `digest` · `list` |
| `archgen_refs` | `list` · `index` · `read` · `search` · `route` — topics: `interview`, `artifact-templates`, `orchestration`, `platforms`, `mcp-and-skills`, `code-standards` |
| `archgen_help` | Full briefing for one domain—use it instead of guessing argument shapes |
| `archgen_platform` | This harness: skill paths, MCP config, sub-agents, CodeGraph index |
<!-- archgen:catalog:end -->

Responses are `{ok,data,error,meta}`; inspect `data.valid` or `data.verdict` and typed `error.code` values. Structured mode uses `structuredContent`; legacy clients receive full JSON text.

## Non-negotiable rules

1. **Workspace:** plans live in `.archgen/<slug>/`, worker state in `.agent/`. Product edits follow `file_ownership`; `.agent/` is the sole exception. Registry writes go through `archgen_registry`.
2. **Four stages:** deterministic floor → verifier judgment → plan review → user approval. Floor reaches `APPROVE` before gate agents. Only BLOCKING findings block; NITs/observations never do. At most TWO rounds per stage; waivers use `waivers.yaml`.
3. **Evidence-scoped artifacts:** inspect read-only, then profile before creating files. Every artifact needs a consumer: no PRD for internal/single-module work, no localized architecture, no ADR for routine choices, no diagram for trivial flows. Create only profile-approved files; reuse names an existing repository path; authored deltas need create/augment decisions. Omit records its reason; a duplicate of a host document is a defect; no second copy is allowed, and no task without a requirement or verification is allowed.
4. **Self-containment:** artifacts execute without chat. Paths are repo-root-relative; never write “as discussed”, “see chat”, or “same as before”.
5. **Completeness:** no partial feature is done. Acceptance is objective and covers linked edges. Stubs, TODOs, and mock-only paths are `failed` even when tests pass.
6. **Same-turn state:** each task ends with `set_status`, todo update, then `archgen_registry{action:'update'}`; each wave gets a snapshot. Never dispatch stale state or hand-edit derived state.
7. **Code quality:** host conventions first: strict checks, explicit absence, structured errors, focused modules, why-comments. Around 1000 LOC is a soft review trigger. Host-native colocated tests are valid; mirrored sibling trees are the fallback for declared roots.
8. **Compaction:** restore with `archgen_tasks{action:'next'}` and `snapshot`, then reload only the current phase. Never act on remembered task state.
9. **Tracking:** commit team plans, tasks, decisions, and `AGENTS.md`. Install manifests, wiring records, indexes, dependencies, coverage, and backups are local state. Never manufacture empty evidence.
10. **Execution safety:** max three workers, one writer per product path, no same-wave overlap or concurrent gate agents, and no automatic retry. Use sub-agents for work, not lookups; self-execute sequentially if unavailable. Cross-harness execution needs approval.

## Progressive loading

Use `archgen_refs{action:'route',mode,phase,intent}` for a deduplicated bundle and `nextPhase`. Use `read` for optional references and `index` only when ambiguous. Prefer `include:'own'`; `all` only when required. After compaction reload the current phase.

| Mode | Phase sequence |
|---|---|
| GENERATE | scope → discover → author → invariants → gate; repair only after findings |
| BROWNFIELD | survey → GENERATE phases |
| START-WORK | dispatch → closeout |
| UPDATE | impact → author → invariants → gate |
| ROLLBACK | plan |
| INVESTIGATE | investigate |
| INSTALL-MCP | configure |
| FETCH-SKILL | match → install |

Optional cross-references (fetch only when needed): `§interview/round-0` · `§interview/step-1` · `§artifact-templates/plan-depth` · `§artifact-templates/artifact-necessity` · `§artifact-templates/self-containment` · `§artifact-templates/mechanical-invariants` · `§artifact-templates/the-yaml-subset` · `§artifact-templates/gate-metrics` · `§orchestration/verifier` · `§orchestration/plan-review` · `§orchestration/dispatch` · `§platforms/codegraph-tools`.

## GENERATE

1. Load `scope`; infer intent, signals, and host `testLayout` (`mirrored` by default, `colocated` when native). Run `archgen_plan{action:'profile',intent,signals,modules,tasks,slug,testLayout}`. Default down; never default to LARGE. `confidence:low` asks exactly one question; medium checks only scope-changing signals. Record `escalateIf` and confirm decisions with the user.
2. Load `discover` with that intent; ask only unresolved, recommendation-first forks.
3. Load `author` and `invariants`. Scaffold identical inputs; fetch each skeleton with `scaffold{file}` in `writeOrder` (`view:'all'` only for legacy bulk output).
4. Tasks need ids, titles, dependencies, ownership, artifacts, and objective acceptance; quote YAML. SMALL uses the plan fence; MEDIUM/LARGE use only `answers.yaml.plan_profile`. Commit artifacts before execution.
5. Run `archgen_plan{action:'validate',tasksYaml}` until valid and refresh the registry. Run `archgen_plan{action:'verify',tasksYaml,planDir}` and fix by code/file in one pass until `APPROVE`.
6. Load `gate`: SMALL main agent, MEDIUM one verifier, LARGE one fresh top-tier verifier. Use `archgen_plan{action:'brief', kind:'verifier'}` and `kind:'review'`. Review proportionally, record `plan_profile.gate` (`§artifact-templates/gate-metrics`), and ask `"Approve to start work?"`
7. On approval, enter START-WORK.

## BROWNFIELD

1. Load `survey` and inspect read-only before writing. SMALL uses the main agent; larger work may use two surveyors. Supply known module/task counts to the profiler. If it marks `codebase-map.md` create, exactly one named writer owns all six sections; others return findings or disjoint fragments. Reuse a fresh existing map.
2. If the map is omitted, put the concise evidence in the plan's `## Survey` section (SMALL = tasks + plan only). Then follow GENERATE, reusing current host documents.

## START-WORK

1. `archgen_tasks{action:'next'}` returns the frontier and blockers (`view:'waves'` for pagination). Fix cycles and ownership conflicts before dispatch.
2. Mark tasks `running`; build prompts with `archgen_tasks{action:'contract',taskId}` verbatim. Warnings, unknown/unreadable capabilities, or missing acceptance/ownership make `dispatchable:false`.
3. Dispatch safely (`§orchestration/dispatch`), retain `dispatchKey → session`, and report one `Skill compliance:` line per required skill.
4. Close tasks with `set_status` and registry refresh. Close waves with a bounded standards/diff review, snapshot, and artifact-state commit; then fetch next.
5. Failure: mark `failed`, report the blocker, propose a fix task, and wait. Finish with counts, follow-ups, completeness checklist, and clean `archgen_docs{action:'validate',slugDir}`.

## UPDATE / ROLLBACK / INVESTIGATE

- **UPDATE:** run `impact`, re-profile if signals changed, edit only affected artifacts, then validate and run proportional gates. Never delete completed tasks to hide work.
- **ROLLBACK:** present reverse-topological revert order and status rewinds, obtain explicit approval, execute, and verify the build.
- **INVESTIGATE:** use the investigate brief; establish root cause, evidence, and blast radius before remediation. Patch-fixing without root cause is forbidden.

## MCP, CodeGraph, and capability skills

- **INSTALL-MCP:** inspect platform facts and official docs, show the exact config diff and scope, then use the sanctioned command after approval.
- **CodeGraph:** default to `codegraph_explore`; specialized tools are opt-in or CLI. Valid indexes need `codegraph.db` and successful status, not just `.codegraph/`. Use native search when disabled or unavailable.
- **FETCH-SKILL:** match before planning and recheck before dispatch. Install one match per call after approval through full-profile `archgen_setup{action:'install_skill',skillId,harness,approve:true}`; never install families. Contracts embed all required rules; unknown or unreadable capabilities are non-dispatchable.
