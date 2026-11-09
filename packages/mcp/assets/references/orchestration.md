# Orchestration playbook — survey, verify, dispatch

Sub-agent briefs and wave-execution rules for the orchestrator (`SKILL.md`). Workers never read this file.

## §survey — brownfield codebase analysis brief

Dispatch 1–2 survey sub-agents with `archgen_plan{action:'brief', kind:'survey'}` verbatim. Accept `.archgen/<slug>/codebase-map.md` only when all required sections (`Structure`, `Modules`, `Conventions`, `Affected`) are present and non-empty.

## §verifier — plan review brief

Dispatch AFTER artifacts exist and `archgen_plan{action:'validate'}` returns `data.valid:true`.

### Agent tier — EVERY verifier dispatch
- **SMALL / MEDIUM plan:** 1 strong mid/high-tier reasoning agent.
- **LARGE plan:** 1 top-tier reasoning agent.
- **FORBIDDEN:** Never use explore, quick, fast, or cheap/low-tier models—weak verifiers miss defects and cause extra rounds.

### ONE agent, the WHOLE plan, ONE pass
- **Never split verification across concerns.** One holistic verifier detects cross-artifact contradictions that sliced agents miss. (If a plan exceeds context limits, split strictly by artifact volume—e.g., `plans/` vs `docs/`—never by verification dimension).
- **Exhaustive single pass.** The verifier MUST return a complete `COVERAGE:` table (`PASS` / `FAIL` / `N/A` for every dimension) so all issues surface in Round 1.

### Verification pass — FULL-DEPTH, every run

Pass the output of `archgen_plan{action:'brief', kind:'verifier'}` verbatim (includes pre-rendered evidence map, Mermaid dependency graph, and `archgen_docs` validation status). The verifier executes all four steps:
1. Runs `archgen_plan{action:'verify', tasksYaml, planDir}` → requires `APPROVE` (checks cycles, dangling refs, wave ownership overlap, acceptance criteria, bidirectional plan↔task coverage).
2. Runs `archgen_docs{action:'validate', slugDir}` (if markdown exists) → requires `valid:true` (zero broken links/anchors).
3. Audits judgment dimensions across `plans/` and `tasks.yaml`:
   - Wave boundary sanity (no artificial serialization).
   - Objectively verifiable acceptance criteria (runnable command or observable output).
   - Scope-appropriate edge-case coverage (`SKILL.md` Hard Rule 3).
   - `references/code-standards.md` compliance.
   - **Contract-completeness sweep** across all applicable dimensions: `functional coverage`, `security & data protection`, `data integrity`, `state, lifecycle & recovery`, `resource limits & abuse`, `operational entrypoints`, `metric traceability`, and `consistency`.
4. Outputs the strict deliverable format:
   ```
   VERDICT: APPROVE | ISSUES
   COVERAGE:
   | dimension | status | reason |  <- every dimension marked PASS / FAIL / N/A
   FINDINGS:                        <- present when VERDICT: ISSUES
   1. file § section — defect — impact — concrete fix
   ```
   *Any report missing the `COVERAGE:` table is incomplete—treat as `ISSUES` and require examination of omitted dimensions.*

### Efficiency — fewer rounds, never shallower checks
Never weaken or skip checks. Efficiency comes only from the exhaustive coverage table, the 2-round cap, batching fixes per file, and never re-applying a failed edit.

### Fix discipline — batch per file, dedupe repeats
When `VERDICT: ISSUES` returns:
- Group findings by file and apply all fixes to a file in a single edit pass.
- If Round N reports the identical finding as Round N-1, re-read the target file and apply a structural fix rather than repeating the prior edit.
- If you disagree with a verifier finding, surface it verbatim to the user rather than ignoring or silently overriding it.

### Gate protocol — 2 automatic rounds, then ask the user
1. **Round 1:** Dispatch verifier. `APPROVE` → proceed to `§plan-review`. `ISSUES` → batch-fix all findings → Round 2.
2. **Round 2:** Dispatch verifier.
   - `APPROVE` → ask user recommendation-first: *"Run the verifier once more? 1. No, proceed (recommended) 2. Yes, run one more pass."*
   - `ISSUES` → batch-fix all findings → ask user recommendation-first: *"Run the verifier once more to confirm fixes? 1. Yes, one more pass (recommended) 2. Waive remaining findings and proceed."*
3. **Round 3+ (user-approved):** Each approval runs 1 pass.
4. **Proceeding without `APPROVE`:** If the user declines another pass without a prior `APPROVE` on record, quote all unverified/outstanding findings verbatim and obtain an **explicit user waiver** before entering `§plan-review` (Hard Rule 2). Never cite token/cost numbers when reporting rounds.

## §plan-review — post-plan review stage

Run AFTER Verifier `APPROVE` and BEFORE the User Gate. Dispatch read-only reviewer(s) using `archgen_plan{action:'brief', kind:'review'}` verbatim (pre-renders dependency graph, doc validation, and evidence map; reviewer makes zero `archgen_*` tool calls):
- **SMALL:** Main-agent self-review permitted if sub-agents are unavailable.
- **MEDIUM:** 1 holistic reviewer.
- **LARGE:** 1 top-tier holistic reviewer (2nd allowed ONLY if context size requires splitting `plans/` vs `docs/`; never split by concern).

Reviewers are strictly read-only. The orchestrator applies fixes, re-runs `validate` + Verifier Gate, and manages the bounded review loop:
1. **Pass 1:** Zero findings → stage complete. Findings → batch-fix per file, re-run `validate` + Verifier Gate → Pass 2.
2. **Pass 2:** Zero findings → stage complete. Findings remain → consolidate and ask user once (`§interview/how-to-ask`): *"Run one more targeted review pass on the N open findings? 1. One more pass (recommended) 2. Waive findings and proceed."*
3. **Pass 3 (final):** On `1`, run **EXACTLY ONE** final pass, then stop. If findings remain, require an explicit user waiver before the User Gate.

## §investigate — root-cause protocol

Triggered when the user reports recurring defects after wave execution. Pass `archgen_plan{action:'brief', kind:'investigate'}` verbatim:
- **SMALL:** Main agent investigates directly.
- **MEDIUM / LARGE:** 1–3 read-only investigator sub-agents split by disjoint suspected subsystem.

Mandatory 4-part deliverable (no patch-fixing allowed):
1. **Root cause statement:** One sentence identifying the underlying defect.
2. **Evidence:** Exact file paths, line numbers, and reproduction steps.
3. **Blast radius:** Affected tasks/artifacts via `archgen_plan{action:'impact', tasksYaml, target}`.
4. **Remediation plan:** New fix tasks with fresh IDs inheriting affected `file_ownership` globs, routed through normal Verifier/Review/User gates.

## §dispatch — wave execution

Dispatch tasks via the platform's native sub-agent mechanism (`archgen_setup{action:'harness_info'}`). If sub-agents are missing, fail to spawn, or lack file permissions, the **main agent executes tasks sequentially itself**. Never switch harnesses or spawn external CLIs without explicit user approval.

### WHEN to dispatch a sub-agent — and when NOT to

**Sub-agents are for bounded implementation/analysis work, NEVER for state lookups:**

| Operation | Executor |
|---|---|
| Wave frontier, task list, task status (`archgen_tasks{next\|list}`) | **MAIN AGENT** (1 tool call; NEVER a sub-agent) |
| Plan health, graph, coverage, impact (`archgen_plan`, `archgen_docs`) | **MAIN AGENT** (1 tool call; NEVER a sub-agent) |
| Registry update, resume snapshot, CodeGraph status | **MAIN AGENT** (1 tool call; NEVER a sub-agent) |
| Single task implementation | **Worker sub-agent** (prompt = `archgen_tasks{action:'contract'}`) |
| Brownfield codebase survey | **Survey sub-agent** (`brief: 'survey'`, CodeGraph-first) |
| Verifier / Plan-Review / Investigation | **Gate / Investigator sub-agent** (`brief: 'verifier'\|'review'\|'investigate'`) |

### Reuse the agent's session — NEVER re-dispatch for the same context

Maintain a **dispatch ledger** (`dispatchKey -> agent session` using the `dispatchKey` from `archgen_tasks{action:'contract'}`). If a task requires a follow-up fix, clarification, or re-verification in files the agent already touched, **continue that agent's existing session** rather than spawning a fresh agent.

### Parallel dispatch — no overlap, and never more than three at once

**HARD CAP: MAX 3 LIVE PARALLEL SUB-AGENTS.** Execute larger waves in batches of ≤3. Before parallel dispatch, verify all six invariants:
1. **Same wave only:** Dispatch only tasks returned in the current wave by `archgen_tasks{action:'next'}`.
2. **Disjoint write globs:** Enforced by `next` (`OWNERSHIP_CONFLICT` blocks overlap).
3. **No concurrent gate agents:** Never run Verifier or Reviewer agents while worker waves are executing.
4. **Single writer per shared file:** Serialize tasks that touch shared configs, lockfiles, or entrypoints.
5. **Ledger pre-registration:** Record `dispatchKey` in the dispatch ledger BEFORE spawning.
6. **Live-agent counting:** Completed/paused sessions awaiting follow-up do not count against the 3-agent active cap.

### Native sub-agents (preferred)
- **Claude Code:** Background `Agent` tool per task; use `git worktree` isolation when globs border shared files.
- **Cursor:** Background subagents; enable isolation when running >2 parallel workers.
- **Antigravity:** Async `invoke_subagent`.
- **Codex:** `spawn_agent` (children cannot nest—flatten orchestration).
- **Gemini CLI:** Parallel `@agents` lack write isolation—use only for read-only/survey waves unless wrapped in `git worktree`.

### When sub-agents are unavailable or fail

If the sub-agent mechanism is missing, crashes at launch, or lacks read/write permissions (a **mechanism failure**, not a task failure):
1. **Default:** Main agent executes the task sequentially itself, honoring wave order and `file_ownership`. No user prompt required.
2. **Cross-harness fallback (USER GATE):** Only if the issue is platform-blocking, report the exact error, propose a specific alternative harness/CLI command, and wait for explicit user approval. Log the decision in the final report.

Optional worktree isolation for tight ownership boundaries:
```bash
git worktree add ".worktrees/$id" -b "task-$id"
# run sub-agent in .worktrees/$id, then merge task-$id on completion
```

### Worker prompt contract

Always generate the worker prompt via:
```
archgen_tasks { action: 'contract', tasksYaml: <tasks.yaml>, taskId: <id> }
```
It bundles: task ID/title, verbatim acceptance criteria, `file_ownership` globs, dependency neighborhood, `references/code-standards.md` path, inline normative rules (`MUST`/`SHOULD`/`NEVER`) + paths/indexes for all matched required skills, pre-located plan sections, `.agent/` workspace paths, completion protocol (`set_status` + `Skill compliance:` line + commit scope), worker prohibitions, CodeGraph usage directive, and `dispatchKey`.

**Pre-dispatch check:** Inspect `contract.warnings`. Never dispatch a task with missing acceptance criteria, empty `file_ownership`, or an uninstalled required skill.

## Failure policy

- **Mechanism failure** (missing/spawn crash/permissions) → follow fallback flow above (do not mark task `failed`).
- **Task execution failure** (non-zero exit or unmet acceptance) → mark `failed` via `set_status`. **NEVER auto-retry.**
- Downstream dependents are automatically held in `blockedByFailure` by the resolver.
- Report failed task ID, logs, and a proposed fix task (`new ID`, `depends_on: []`, inheriting failed `file_ownership` globs) to the user. `[wait for user]`
