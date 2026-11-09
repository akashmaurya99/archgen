# Orchestration playbook — survey, verify, review, dispatch

Sub-agent briefs and wave rules for the orchestrator (`SKILL.md`). Workers never read this file.

## §survey — brownfield codebase analysis brief

Dispatch 1–2 survey sub-agents with `archgen_plan{action:'brief', kind:'survey'}` verbatim. Accept `.archgen/<slug>/codebase-map.md` only when all six sections are present and non-empty: `Structure`, `Modules`, `Conventions`, `Existing docs`, `Toolchain`, `Affected`.

`Existing docs` inventories host PRDs, architecture docs, and ADRs (path + freshness) so the profile can return `reuse`. `Toolchain` records source/test roots, build/test/lint/typecheck commands, and naming/test conventions so the plan guesses nothing.

## §verifier — plan review brief

Dispatch AFTER artifacts exist and `archgen_plan{action:'validate'}` returns `data.valid:true`. Deterministic `verify` runs for EVERY scope, including SMALL.

### Gate sizing — proportional, never skipped

| Scope | Deterministic verify | Judgment verifier | Plan review | User gate |
|---|---|---|---|---|
| SMALL | MAIN agent | MAIN agent audits the same dimensions | MAIN agent | required |
| MEDIUM | verifier sub-agent | 1 strong mid/high-tier agent | MAIN agent | required |
| LARGE | verifier sub-agent | 1 top-tier agent | 1 independent top-tier reviewer | required |

- **ONE agent, the WHOLE plan, ONE pass.** Never split verification by concern; split only by artifact volume when context forces it (`plans/` vs `docs/`).
- **Exhaustive single pass.** Return a complete `COVERAGE:` table (`PASS` / `FAIL` / `N/A` per dimension) so every issue surfaces in Round 1.
- **FORBIDDEN:** quick/explore/cheap-tier models for MEDIUM or LARGE gates.

### Verification pass

Pass `archgen_plan{action:'brief', kind:'verifier'}` verbatim (pre-rendered evidence map, graph, doc-validation status). The verifier:

1. Runs `archgen_plan{action:'verify', tasksYaml, planDir}` → `APPROVE` (cycles, dangling refs, wave ownership, acceptance, bidirectional plan↔task coverage).
2. Runs `archgen_docs{action:'validate', slugDir}` (if markdown exists) → `valid:true`.
3. Audits judgment dimensions across `plans/` and `tasks.yaml`:
   - Wave boundaries match real dependencies (no artificial serialization).
   - Acceptance criteria are objectively verifiable.
   - Edge-case coverage matches the profile's depth budget.
   - `references/code-standards.md` compliance, including separate source/test trees.
   - **Scope & artifact necessity:** the profile exists and is recorded; every created artifact has a consumer and a trigger; every `reuse` names a real host path; every `omit` records a reason; no omitted artifact was created; no host document was duplicated; no task lacks a requirement.
   - Contract completeness: `functional`, `security & data protection`, `data integrity`, `state, lifecycle & recovery`, `resource limits & abuse`, `operational entrypoints`, `metric traceability`, `consistency`.
4. Emits `VERDICT`, the full `COVERAGE:` table, and findings (`file § section — defect — impact — fix`). A missing table is incomplete → treat as `ISSUES`.

### Gate protocol — 2 automatic rounds, then ask the user

Never weaken checks. Efficiency comes from exhaustive coverage, the 2-round cap, batching fixes per file, and never re-applying a failed edit.

When `ISSUES` returns: group findings by file and apply all fixes in one pass; if Round N repeats Round N-1, re-read the file and make a structural fix; if you disagree, surface the finding verbatim to the user rather than silently overriding it.

1. **Round 1:** verifier → `APPROVE` → `§plan-review`; `ISSUES` → batch-fix → Round 2.
2. **Round 2:** `APPROVE` → ask recommendation-first whether to run once more (recommended: no, proceed); `ISSUES` → batch-fix → ask *"Run the verifier once more to confirm fixes? 1. Yes, one more pass (recommended) 2. Waive remaining findings and proceed."*
3. **Round 3+:** each user approval runs exactly one pass.
4. **No `APPROVE` on record:** quote every outstanding finding and obtain an **explicit user waiver** before `§plan-review`. Never cite token/cost numbers when reporting rounds.

## §plan-review — post-plan review stage

Run AFTER verifier `APPROVE`, BEFORE the User Gate. Use `archgen_plan{action:'brief', kind:'review'}` verbatim; reviewers are read-only and make zero `archgen_*` calls.

**Sizing:** SMALL → main-agent self-review; MEDIUM → main-agent review against the profile; LARGE → one independent top-tier reviewer (a 2nd only when context forces `plans/` vs `docs/`, never by concern).

**Review areas (all 5, every run):** `edge cases per module` · `task ordering & parallelization` · `cross-module contracts` · `scope fit & minimalism` (unneeded artifacts, unneeded tasks, duplicated host docs, missing omit reasons) · `documentation completeness` (every task has a plan section).

Pass 1 zero findings → done; findings → batch-fix, re-run `validate` + verifier → Pass 2. Remaining findings at Pass 2 → ask once: *"Run one more targeted pass on the N open findings? 1. One more pass (recommended) 2. Waive findings and proceed."* Pass 3 is final; remaining findings need an explicit user waiver. The orchestrator applies fixes; reviewers never edit.

## §investigate — root-cause protocol

Triggered by recurring defects after execution. Pass `archgen_plan{action:'brief', kind:'investigate'}` verbatim. SMALL → main agent; MEDIUM/LARGE → 1–3 read-only investigators split by disjoint suspected subsystem.

Mandatory four-part deliverable (no patch-fixing): **root cause** (one sentence), **evidence** (paths, lines, reproduction), **blast radius** (`archgen_plan{action:'impact', tasksYaml, target}`), **remediation** (new fix tasks inheriting affected `file_ownership`, routed through normal gates).

## §dispatch — wave execution

Dispatch via the platform's native sub-agent mechanism (`archgen_setup{action:'harness_info'}`). If sub-agents are missing, crash, or lack permissions, the **main agent executes sequentially**. Never switch harnesses or spawn external CLIs without explicit approval.

### Executor — sub-agents are for WORK, never lookups

| Operation | Executor |
|---|---|
| Wave frontier, task list/status (`archgen_tasks{next,list}`) | **MAIN AGENT** (never a sub-agent) |
| Plan health, graph, coverage, impact, profile (`archgen_plan`, `archgen_docs`) | **MAIN AGENT** (never a sub-agent) |
| Registry update, resume snapshot, CodeGraph status | **MAIN AGENT** (never a sub-agent) |
| Single task implementation | **Worker** (`archgen_tasks{action:'contract'}`) |
| Survey / verifier / reviewer / investigation | **Gate sub-agent** (`brief: 'survey'|'verifier'|'review'|'investigate'`) |

### Session reuse and parallel dispatch

Maintain a **dispatch ledger** (`dispatchKey → session` from `contract`). Continue the same agent for follow-ups, fixes, and re-verification in files it already touched—never re-dispatch for the same context.

**HARD CAP: 3 live parallel sub-agents.** Batch larger waves. Before parallel dispatch, verify:
1. **Same wave only:** tasks from the current `archgen_tasks{action:'next'}`.
2. **Disjoint write globs:** `next` blocks overlap with `OWNERSHIP_CONFLICT`.
3. **No concurrent gate agents:** never run verifier/reviewer during a worker wave.
4. **Single writer per shared file:** serialize shared configs, lockfiles, entrypoints.
5. **Ledger pre-registration:** record `dispatchKey` BEFORE spawning.
6. **Live counting:** completed/paused sessions awaiting follow-up do not count against 3.

Native mechanics: Claude Code background `Agent`; Cursor subagents; Antigravity `invoke_subagent`; Codex `spawn_agent` (no nesting); Gemini CLI parallel `@agents` (read-only unless worktree-isolated).

If the mechanism fails: (1) **default** — main agent executes sequentially, honoring wave order and ownership; (2) **cross-harness fallback (USER GATE)** — only when platform-blocking, report the exact error, propose a specific alternative, and wait for approval. Log the decision.

Optional worktree isolation:
```bash
git worktree add ".worktrees/$id" -b "task-$id"
# run the sub-agent there, then merge task-$id on completion
```

### Worker prompt contract

Generate via `archgen_tasks{action:'contract', tasksYaml, taskId}`. It bundles task ID/title, verbatim acceptance, `file_ownership`, dependency neighborhood, `references/code-standards.md` path, inline normative rules + paths for matched skills, pre-located plan sections, `.agent/` paths, the completion protocol (`set_status`, `Skill compliance:` line, commit scope), prohibitions, the CodeGraph directive, and `dispatchKey`.

**Pre-dispatch:** inspect `contract.warnings`. Never dispatch with missing acceptance criteria, empty `file_ownership`, or an uninstalled required skill.

## Failure policy

- **Mechanism failure** (missing/spawn crash/permissions) → fallback above; do NOT mark the task `failed`.
- **Task failure** (non-zero exit or unmet acceptance) → `set_status` `failed`; **never auto-retry**. Dependents are held in `blockedByFailure`.
- Report the failed ID, logs, and a proposed fix task (new ID, `depends_on: []`, inheriting failed ownership globs). `[wait for user]`
