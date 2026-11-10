# Orchestration playbook — survey, verify, review, dispatch

Sub-agent briefs and wave rules for the orchestrator (`SKILL.md`). Workers never read this file.

## §survey — brownfield codebase analysis brief

Dispatch 1–2 survey sub-agents with `archgen_plan{action:'brief', kind:'survey'}` verbatim. Accept `.archgen/<slug>/codebase-map.md` only when all six sections are present and non-empty: `Structure`, `Modules`, `Conventions`, `Existing docs`, `Toolchain`, `Affected`.

`Existing docs` inventories host PRDs, architecture docs, and ADRs (path + freshness) so the profile can return `reuse`. `Toolchain` records source/test roots, build/test/lint/typecheck commands, and naming/test conventions so the plan guesses nothing.

## §verifier — plan review brief

### The floor comes FIRST — the gate agent never sees a mechanical defect

Before a gate agent is dispatched, the ORCHESTRATOR drives the deterministic floor to `APPROVE`:

```
archgen_plan { action: 'verify', tasksYaml: <tasks.yaml>, planDir: <plans dir> }
```

That call is the mechanical truth: cycles, dangling refs, same-wave ownership overlap, plan↔task coverage, the mirrored test tree, matrix citations that resolve, PRD requirements that are cited, decision files that exist, declared paths that have an owner, and wave labels that match the DAG. **Fix every issue it reports and re-run until it returns `APPROVE`** — that is a loop the orchestrator runs locally, at zero agent cost.

Only then dispatch the gate agent. Its brief carries the floor's result and the maps (requirement map, edge-case matrix map, ownership map, module DAG), so the agent spends its pass on judgment instead of re-deriving arithmetic. Dispatching a gate agent onto a failing floor is what turned one review into four.

### Gate sizing — proportional, never skipped

| Scope | Deterministic floor | Judgment verifier | Plan review | User gate |
|---|---|---|---|---|
| SMALL | MAIN agent, local loop | MAIN agent audits the same dimensions | MAIN agent | required |
| MEDIUM | MAIN agent, local loop | 1 strong mid/high-tier agent | MAIN agent | required |
| LARGE | MAIN agent, local loop | 1 top-tier agent | 1 independent top-tier reviewer | required |

- **ONE agent, the WHOLE plan, ONE pass.** Never split verification by concern; split only by artifact volume when context forces it (`plans/` vs `docs/`).
- **Exhaustive single pass.** Return a complete `COVERAGE:` table (`PASS` / `FAIL` / `N/A` per dimension) so every issue surfaces in Round 1.
- **FORBIDDEN:** quick/explore/cheap-tier models for MEDIUM or LARGE gates.

### Verification pass

Pass `archgen_plan{action:'brief', kind:'verifier'}` verbatim (pre-rendered evidence map, graph, doc-validation status, mechanical floor, and the four maps). The verifier:

1. Reads the floor's result from the brief — it does NOT re-run it and does NOT re-derive ownership, matrix, requirement, or wave facts.
2. Checks the maps for ALIGNMENT: does the acceptance a matrix row cites verify the stated case; does the acceptance citing a requirement verify that requirement; does the task DAG match the module DAG; does every source-owning task own its mirrored test path.
3. Judges what no tool can: wave-boundary sanity, objectively verifiable acceptance, scope-appropriate edge-case coverage, `references/code-standards.md` plausibility, **scope & artifact necessity** (a consumer for every created artifact, a real host path for every reuse, a reason for every omission), and contract completeness (`functional`, `security & data protection`, `data integrity`, `state, lifecycle & recovery`, `resource limits & abuse`, `operational entrypoints`, `metric traceability`, `consistency`).
4. Emits `VERDICT`, the full `COVERAGE:` table, and findings classified **BLOCKING** (contradicts an agreed requirement, an accepted decision, or a stated invariant), **NIT** (cosmetic), or **OBSERVATION** (a capability nobody asked for). A missing table is incomplete → treat as `ISSUES`.

**The verifier does not invent requirements.** A missing capability that no PRD, decision, `answers.yaml` or code-standard asked for is an OBSERVATION — one line, never blocking, never a fix demand. Without this rule the gate keeps discovering new features and the plan never converges.

### Fix discipline — batch per file AND per code, one pass

When `ISSUES` returns: group findings by file and by CODE, and apply every fix to that file in ONE pass. NITs are not fixed and never justify another round. If you disagree with a finding, surface it verbatim to the user rather than silently overriding it.

### The floor's codes — group fixes by code, not by sentence

Every finding carries a stable code, so fixes can be batched and counted:

| Code | Meaning |
|---|---|
| `PROFILE_NOT_RECORDED` | no profile was recorded — artifact necessity cannot be checked |
| `PROFILE_CREATE_MISSING` / `PROFILE_OMIT_PRESENT` / `PROFILE_REUSE_MISSING` | the recorded decision and the files on disk disagree |
| `PROFILE_UNRECORDED` | an artifact exists with no recorded decision |
| `MIRROR_MISSING` | a source-owning task has no mirrored test path |
| `MATRIX_UNKNOWN_TASK` / `MATRIX_INDEX_OUT_OF_RANGE` / `MATRIX_CLAIM_MISMATCH` / `MATRIX_DANGLING_CLAIM` | the edge-case matrix and the acceptances disagree |
| `REQ_UNCITED` / `REQ_UNKNOWN` | the PRD and the acceptances disagree |
| `DECISION_MISSING` / `PATH_UNOWNED` / `WAVE_LABEL_DRIFT` / `WAVE_GROUP_SPANS` | the declared structure and the plan disagree |
| `NO_ACCEPTANCE` / `EMPTY_OWNERSHIP` / `OWNERSHIP_OVERLAP` / `CYCLE` / `DANGLING_DEP` / `PLAN_TASK_COVERAGE` / `UNKNOWN_TASK_ID` | the task file itself is defective |

Warnings carry their own codes (`CONFIG_NOT_ENFORCED`, `OWNERSHIP_CONTAINED`, `WAIVER_COUNT_MISMATCH`, `GATE_IDENTITY_MISSING`) and never block.

### Waivers and gate metrics — the audit trail

- **A waiver is a file, not a sentence.** When the user accepts a residual finding, write it to `.archgen/<slug>/waivers.yaml` (`scope`, `finding`, `reason`, `approved_by`, `approved_at`) BEFORE proceeding, and say so in the completion report. A waived finding is not a defect to fix and the verifier must not re-raise it unless it regressed.
- **The gate measures itself, and it names its subject.** After the gate, record `plan_profile.gate` in `answers.yaml` (MEDIUM/LARGE) or the plan's `## Profile` (SMALL): `verifier` (who approved it), `rounds` used, findings by class, waived count, residual, and the ISO timestamp. The floor checks the recorded waived count against the ledger and warns when no verifier is recorded — an approval without a subject is not an approval.

### Gate protocol — TWO rounds, then the user

1. **Round 1:** dispatch the verifier on the clean floor. `APPROVE` → `§plan-review`. `ISSUES` → batch-fix every BLOCKING finding → re-run the floor until `APPROVE` → Round 2.
2. **Round 2 — DELTA:** the verifier re-checks ONLY the Round 1 findings (fixed / still open / regressed) and the floor. It does not restate what is fixed. A finding it did not see in Round 1 must be marked `NEW` and must be BLOCKING-grade.
3. **There is no Round 3.** If Round 2 still reports open BLOCKING findings, fix what is safe, then present the outstanding findings verbatim and ask: *"These N findings remain after two rounds. 1. Waive them and proceed (recommended) 2. Keep the plan open for another look."* Never run a third pass on your own initiative, and never cite token/cost numbers when reporting rounds. A waiver chosen here is written to `waivers.yaml` first.
4. **No `APPROVE` on record:** quote every outstanding finding and obtain an **explicit user waiver** before `§plan-review`.

### The floor in CI

The deterministic floor is a build gate, not only an agent step:

```bash
npx archgen-mcp exec archgen_plan '{"action":"verify","tasksYaml":".archgen/<slug>/tasks.yaml","planDir":".archgen/<slug>/plans"}' --fail-on verdict:ISSUES
```

Exit 3 when the verdict is ISSUES, 0 when it is APPROVE. Warnings never fail the build — that is what keeps the gate from being bypassed.

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
