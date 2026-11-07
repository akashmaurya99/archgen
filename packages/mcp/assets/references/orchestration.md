# Orchestration playbook — survey, verify, dispatch

Sub-agent briefs and the wave-execution mechanics. The orchestrator (SKILL.md)
calls into these sections; workers never read this file.

## §survey — brownfield codebase analysis brief

**The brief is a tool output:** `archgen_plan { action: 'brief', kind: 'survey' }`.
Dispatch 1–2 sub-agents with it verbatim — do not hand-write the prompt.

Accept the map only if every section is present and non-empty.

## §verifier — plan review brief

Dispatch AFTER artifacts exist and `archgen_plan{action:'validate'}` passes.

### Agent tier — EVERY verifier dispatch

Verification is judgment-heavy: a weak verifier misses real defects AND raises
false positives — costing MORE rounds, not fewer. Dispatch on the strongest
reasoning agent the harness offers (best agent present), or a mid/high-tier
sub-agent scaled to plan complexity:

- SMALL/MEDIUM plan → one strong (mid/high-tier) agent.
- LARGE plan → the stronger/highest tier available.
- NEVER an explore / research / quick / small / cheap / fast sub-agent,
  whatever the harness calls its low-end tiers.

### ONE agent, the WHOLE plan, ONE pass

**Never split the verifier across several agents.** One holistic verifier sees
cross-issue contradictions that per-dimension slices miss, and it costs a
fraction of several partial ones. If the plan is genuinely too large for one
context, split by ARTIFACT/VOLUME then (plans vs docs) — never by concern,
and never one agent per dimension.

**One pass must find everything.** A verifier that reports the first issue it
is confident about forces another round — another dispatch, another full
read, another fix cycle. The brief therefore REQUIRES a coverage table: every
dimension marked PASS / FAIL / N/A. The table is what proves the pass was
exhaustive, so the orchestrator never has to send a second agent to find out
what was never looked at.

### Verification pass — FULL-DEPTH, every run

**The brief is a tool output:** `archgen_plan { action: 'brief', kind: 'verifier' }`.
Dispatch it verbatim — do not hand-write the prompt.

The brief carries, already rendered:

- the **evidence map** — every artifact and its section anchors, so the
  verifier reads SECTIONS, never whole files;
- the **dependency graph** (mermaid) and the **reference-integrity result** —
  rendered into the brief, so the orchestrator spends no tool call fetching
  them and the verifier never runs without them.

Each verifier run executes ALL four steps:

1. Runs `archgen_plan{action:'verify', tasksYaml, planDir}` — deterministic
   floor: cycles, dangling refs, same-wave ownership overlap, missing acceptance
   criteria, plan↔task coverage. It returns a verdict of `APPROVE` or `ISSUES`.
2. When markdown artifacts exist under `.archgen/<slug>/`, runs
   `archgen_docs{action:'validate', slugDir}` — must be clean (`ok:true`, zero
   broken references) alongside the verifier's APPROVE; broken references block
   APPROVAL.
3. Reads plans + tasks.yaml and judges what the tools cannot (the full
   checklist is in the brief):
   - Are wave boundaries sensible (no artificial serialization)?
   - Do acceptance criteria objectively verify (command or observable)?
   - Edge cases covered per SKILL.md right-sizing class?
   - Code-standards compliance plausible for the planned structure?
   - the CONTRACT-COMPLETENESS sweep (functional coverage, security, data
     integrity, state/lifecycle/recovery, resource limits, operational
     entrypoints, metric traceability, consistency) — the brief lists every
     dimension and says when to apply it. These failure classes are the TOP
     cause of multi-round loops: round 1 MUST sweep the applicable dimensions
     exhaustively.
4. Returns the verdict AND the coverage table, in the shape the brief
   specifies:

   ```
   VERDICT: APPROVE | ISSUES
   COVERAGE:
   | dimension | status | reason |     <- every dimension, PASS / FAIL / N/A
   FINDINGS:                             <- only when the verdict is ISSUES
   1. file § section — what is wrong — why it matters — suggested fix
   ```

   A report with findings but NO coverage table is INCOMPLETE — treat it as
   ISSUES and name the dimensions it did not reach.

### Efficiency — fewer rounds + zero duplicate work, NEVER shallower checks

Every run stays FULL-DEPTH: both checks run to completion and the full
judgment checklist applies each time. Efficiency comes ONLY from:

- the coverage table (one exhaustive pass instead of a discovery loop);
- capping automatic rounds at 2 (gate protocol below);
- batching fixes per file (fix discipline below);
- never re-fixing an already-resolved finding.

"Efficient" NEVER means skipping or lightening the verifier, the docs
integrity check, or any judgment-checklist item. It NEVER means telling the
verifier to be shorter or to report less: a thin verifier costs MORE rounds,
not fewer — every finding it holds back is another dispatch for somebody.

### Fix discipline — batch per file, dedupe repeats

On `ISSUES:` the orchestrator fixes ALL findings before re-dispatching:

- Group findings BY FILE; apply each file's fixes in ONE edit pass — open
  each file once per round, not once per finding.
- Round N reports the SAME finding as round N-1 (same file + same issue) →
  the prior fix did not land: re-read the file and fix it properly — never
  re-apply the identical edit.
- A finding the orchestrator cannot act on (a disagreement with the verdict)
  is NOT fixed silently: it goes to the user with the finding quoted.

### Gate protocol — 2 automatic rounds, then ask the user

The initial VERIFIER GATE flow (GENERATE step 5). Rounds 1–2 run
automatically; fix ALL findings between rounds (fix discipline above):

1. Round 1: dispatch verifier. `APPROVE` → gate passed → §plan-review.
   `ISSUES:` → fix ALL findings → round 2.
2. Round 2: dispatch verifier.
   - Clean `APPROVE` → ask the user once more, recommending NO, proceed.
   - `ISSUES:` → fix ALL findings → ask the user once more, recommending
     YES, one more pass.
   Ask recommendation-first per §interview/how-to-ask: "Run the verifier
   once more to make sure everything passes?"
3. On YES → run another round; if it returns `ISSUES:`, fix all and ask again
   — every round beyond 2 is user-approved. On NO → proceed to §plan-review.
4. On NO with findings still outstanding and no verifier `APPROVE` on record:
   surface every outstanding finding verbatim and require an EXPLICIT user
   waiver — never proceed silently. Hard rule 2 stands: the plan MUST NOT
   reach the USER GATE without at least one verifier `APPROVE` (or that
   explicit waiver on the record). An earlier `APPROVE` on record → proceed
   to §plan-review, noting the latest unverified fixes.

### What to tell the user when a round is exhausted

Quote the outstanding findings verbatim, and say what each round found — not
how many tokens it cost. A cost number becomes a target the next run
optimises for, and the cheapest thing to cut is the depth of the check.
Depth is what makes the gate worth running.

## §plan-review — post-plan review stage

Run AFTER the verifier returns APPROVE and BEFORE the user gate. Dispatch
REVIEWER sub-agents sized by the right-sizing class — always ONE holistic
review of the WHOLE plan, never per-concern splits:

- SMALL: main-agent self-review acceptable if no reviewer mechanism exists.
- MEDIUM: 1 reviewer.
- LARGE: 1 holistic reviewer on the strongest reasoning tier. A 2nd reviewer
  ONLY if the plan is genuinely too large for one reviewer's context — split
  by ARTIFACT/VOLUME then (e.g. plans vs docs), never by concern.

One holistic reviewer analyzes ALL issues together: cross-issue reasoning
catches contradictions a narrow per-concern slice misses, and one reviewer
costs far fewer tokens than several. NEVER dispatch one sub-agent per
individual issue/concern.

**The brief is a tool output:** `archgen_plan { action: 'brief', kind: 'review' }`.
Dispatch it verbatim — it already carries the mermaid graph, the
docs-validate result and the evidence map, rendered into it. The reviewer
therefore makes NO archgen call of its own: it reads the sections it is
pointed at and reports.

Reviewers are read-only and report-only — they never edit artifacts or code.
The orchestrator fixes the artifacts itself, re-runs validate +
re-dispatches the verifier gate after every change.

### Review loop — bounded passes, then ask

The fix→re-verify cycle stays, but reviewer passes are countable and bounded:

1. Pass 1: holistic review. Zero findings → stage done.
2. Findings → fix ALL (batched per file), re-run validate + the verifier
   gate → pass 2.
3. Pass 2 still yields findings → do NOT spawn more reviewers. Consolidate
   the outstanding findings and ask the user once, recommendation-first per
   §interview/how-to-ask: "Run one more targeted review pass on the N
   open findings? 1. One more pass (recommended) 2. Waive these findings and
   proceed."
4. On YES → run EXACTLY ONE more pass, then consolidate and STOP. Zero
   findings → stage done; findings remain → surface them and require an
   explicit user waiver before the user gate. On NO → record the explicit
   waiver, proceed.

A "more review" approval authorizes EXACTLY ONE additional pass — never a
fresh loop, never more reviewers. The stage ends ONLY at zero findings or an
explicit user waiver on record.

## §investigate — root-cause protocol

Triggered when the USER reports repetitive/recurring issues AFTER implementation
waves completed. Do NOT patch-fix under this protocol.

**The brief is a tool output:** `archgen_plan { action: 'brief', kind: 'investigate' }`.
Complexity-sized dispatch:

- SMALL scope: main agent investigates directly.
- MEDIUM/LARGE: 1–3 investigator sub-agents split by suspected subsystem.

Investigators produce ALL four:

1. Root cause statement — one sentence naming the actual defect.
2. Evidence — files/lines/repro steps.
3. Blast radius — which tasks/artifacts are affected
   (`archgen_plan{action:'impact', tasksYaml, target}`).
4. Remediation plan — routed through the normal gates: new fix tasks get fresh
   ids inheriting the affected task's ownership globs.

Token discipline: investigators read narrowly around evidence, not whole-repo
sweeps. Patch-fixes without a root-cause statement are forbidden under this
protocol.

## §dispatch — wave execution

Dispatch policy: dispatch each task to the harness's NATIVE sub-agent mechanism
when available AND functional. If sub-agents do not exist on this platform, or
the sub-agent fails, or lacks required tool permissions (read/write/etc.), the
MAIN AGENT executes the task ITSELF — sequentially, respecting waves and
ownership globs. Cross-harness/platform delegation is allowed ONLY through an
explicit user gate (below). There is NO automatic fallback to other harnesses,
platforms, or CLIs — ever.

### WHEN to dispatch a sub-agent — and when NOT to

**A sub-agent is a WORK unit, not a lookup.** Dispatching one to read a field
the orchestrator can read with one tool call costs a whole agent — its
prompt, its context, its exploration, its output — and returns less than the
tool call did.

| Need | Do this |
|---|---|
| wave frontier, task list, task status | **MAIN AGENT, one MCP call.** `archgen_tasks{action:'next'\|'list'}`. NEVER a sub-agent. |
| plan health, graph, coverage, impact | **MAIN AGENT, one MCP call.** `archgen_plan{...}`, `archgen_docs{...}`. NEVER a sub-agent. |
| registry refresh, snapshot, CodeGraph status | **MAIN AGENT, one MCP call.** NEVER a sub-agent. |
| ONE task's implementation | worker sub-agent — the contract IS the prompt. |
| a brownfield survey | survey sub-agent — bounded, CodeGraph-first, one pass. |
| the VERIFIER gate | verifier sub-agent — mandatory, holistic, ONE agent, ONE pass. |
| the PLAN-REVIEW stage | reviewer sub-agent — mandatory, holistic, ONE agent. |
| a recurring-issue investigation | investigator sub-agent — ONE by default. |

**Status is never a sub-agent's job.** If a read is one tool call, the
orchestrator makes it. A sub-agent dispatched to "check where we are" re-reads
the whole plan to answer a question the resolver answers exactly.

### Reuse the agent's session — NEVER re-dispatch for the same context

**If a follow-up needs what an agent already knows, CONTINUE THAT AGENT'S
SESSION.** Concretely:

- a fix in files that agent already touched;
- a clarifying question about its own conclusion;
- a re-check of its own output after the orchestrator applied a fix.

A fresh agent re-reads everything the previous one read, and may reach a
different conclusion from the same evidence. Reuse is both cheaper and more
consistent. Only dispatch a NEW agent when the work is genuinely independent
— a different task, a different subsystem, a fresh context.

The orchestrator keeps a **dispatch ledger** while a stage runs:
`dispatchKey → agent session`. `archgen_tasks{action:'contract'}` returns the
`dispatchKey` for the task, so the ledger is keyed by the tool's own value —
never by a hand-written label.

### Parallel dispatch — no overlap, and never more than three at once

**MAXIMUM 3 PARALLEL SUB-AGENTS AT A TIME.** Never four. If a wave has more
than three tasks, dispatch them in batches of three and let the first batch
settle before the next. Three is the point where the orchestrator can still
track which agent owns which files and still read the results as they land;
past that, ownership drift and lost findings cost more than the extra
parallelism saves.

Before dispatching two or more agents at once, ALL of these hold:

1. **Same wave only.** A task's prerequisites are DONE before it starts.
   `archgen_tasks{action:'next'}` returns the wave; dispatch only that wave.
2. **Disjoint write footprints.** The resolver already rejects same-wave
   tasks with overlapping `file_ownership` (`OWNERSHIP_CONFLICT`) — that is
   the write-side guarantee. Do not work around it.
3. **Disjoint READ footprints too, for gate agents.** A verifier or reviewer
   reading a plan while a worker edits the same tree reads a moving target.
   **Gate agents never run while a wave is in flight.**
4. **One writer per path.** If two agents could write the same file — a
   config, a lockfile, a shared entry point — they run sequentially, not in
   parallel.
5. **Record it.** Write the dispatch ledger entry BEFORE the spawn, so a
   second dispatch of the same task is visibly a duplicate.
6. **Count only LIVE agents.** The cap counts agents that are still running.
   A finished agent waiting on a fix does not occupy a slot — but it still
   holds its session, so it is reused rather than replaced (§dispatch/reuse).

### Native sub-agents (preferred)

- Claude Code: background Agent tool per task; add worktree isolation for
  tasks whose ownership might brush shared files.
- Cursor: background subagents; request isolation when >2 parallel workers.
- Antigravity: invoke_subagent async.
- Codex: spawn_agent works but children can't nest — flatten the plan instead.
- Gemini CLI: parallel @agents are hub-and-spoke only AND have no isolation →
  use them ONLY for read-only/research waves unless wrapping in worktrees.

### When sub-agents are unavailable or fail

Detect first — one of:

- mechanism missing on this platform;
- spawn failure (sub-agent never started / crashed at launch);
- tool-permission gaps (sub-agent runs but cannot read/write/edit files).

Then, in order:

1. DEFAULT — main agent executes the task itself, sequentially, respecting
   waves and file_ownership globs. No user permission needed for this.
2. USER GATE — cross-harness/platform delegation ONLY. When the sub-agent
   problem looks platform-specific, STOP and tell the user the concrete issue,
   propose using another platform/harness for that specific task (name the
   harness + its command shape), and proceed ONLY after the user explicitly
   allows it. Log the user's choice in the final report.

Never silently switch harnesses. Never ask permission to fall back for routine
failures the main agent can simply do itself.

A sub-agent MECHANISM failure (missing/spawn/permissions) is not a TASK
failure — run the diagnose-and-ask flow above first. Mark a task failed only
after execution was actually attempted (by sub-agent or main agent) and did
not complete.

Isolation for native sub-agents when ownership borders are tight:

```bash
git worktree add ".worktrees/$id" -b "task-$id"
# point the sub-agent's cwd at .worktrees/$id, then merge task-$id on success
```
### Worker prompt contract

**The contract is a tool output — never hand-assemble it:**

```
archgen_tasks { action: 'contract', tasksYaml: <tasks.yaml>, taskId: <id> }
```

It assembles, from the same sources everything else reads:

- the task id + title;
- the acceptance criteria **VERBATIM**;
- the `file_ownership` globs ("edit NOTHING outside these");
- the dependency neighbourhood (prerequisites + what depends on this task);
- the code-standards reference path;
- the **capability skills** — EVERY matched required skill, each with its
  **normative rules inline** (the MUST / SHOULD / NEVER lines), its file path
  and its section index. The rules travel WITH the contract on purpose: a
  path pointer is a file the worker may never open, and a skill that is never
  opened is a skill that is never applied. The section index is the lens for
  pulling more when the worker decides it needs it;
- the **pre-located doc sections** — the sections that mention the task id, never
  the whole plan;
- the working-state location;
- the finish procedure (set_status + the `Skill compliance:` line + commit scope);
- the **rules the worker must NOT break** — do not read the archgen skill or
  its references, do not run the archgen tool suite beyond the one set_status
  call, edit nothing outside the owned files, do not talk to other workers;
- the **CodeGraph directive**, when the project is indexed — the server
  detects it, so the worker never has to work out whether it exists;
- the `dispatchKey` — the ledger key for session reuse.

**CODEGRAPH:** if `.codegraph/` is present, the worker must navigate with the
CodeGraph MCP tools for anything needing understanding — never guess architecture
from prose. The contract says so; the orchestrator does not need to.

**Workers do NOT talk to each other;** coordination happens only through
tasks.yaml state.

**Before dispatching**, check the contract's `warnings`: a task with no acceptance
criteria, no file ownership, or a REQUIRED capability skill that is not
installed is not dispatchable — fix the plan (or install the skill) first.

## Failure policy

- Sub-agent mechanism failure (missing/spawn/permissions) → §dispatch
  diagnose-and-ask flow FIRST. It is not yet a task failure.
- Task exit ≠ 0 OR status=failed → leave it failed. NEVER auto-retry.
- Downstream tasks stay blocked by the resolver (blockedByFailure).
- Report to user: failed id, log path, proposed fix-task description.
  [wait for user] A fix task gets fresh id, depends_on=[], ownership of the
  failed task's globs.
