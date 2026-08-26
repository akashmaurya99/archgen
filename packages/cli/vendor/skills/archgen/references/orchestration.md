# Orchestration playbook — survey, verify, dispatch

Sub-agent briefs and the wave-execution mechanics. The orchestrator (SKILL.md)
calls into these sections; workers never read this file.

## §survey — brownfield codebase analysis brief

Dispatch 1–2 sub-agents with this prompt shape:

```
TASK: Survey this repository to prepare a feature plan for: <feature request>
DELIVERABLE: write .archgen/<slug>/codebase-map.md containing EXACTLY these
sections:
  ## Structure      — top-2-levels folder tree w/ one-line purpose each
  ## Modules        — table: module | responsibility | key entry points
  ## Conventions    — naming, error-handling, test layout actually observed
  ## Affected       — files/modules the feature will touch, with evidence paths
SCOPE: read-only. Use codegraph MCP tools when available
(codegraph_explore / codegraph_files); otherwise Glob+Grep systematically.
VERIFY: every claim cites a real path; no guessed APIs.
```

Accept the map only if every section is present and non-empty.

## §verifier — plan review brief

Dispatch AFTER artifacts exist and validate.mjs passes. The verifier:

1. Runs `node <skill>/scripts/verify-plan.mjs .archgen/<slug>/tasks.yaml --plan .archgen/<slug>/plans`
   — deterministic floor: cycles, dangling refs, same-wave ownership overlap,
   missing acceptance criteria, plan↔task coverage.
2. Reads plans + tasks.yaml and judges what scripts cannot:
   - Are wave boundaries sensible (no artificial serialization)?
   - Do acceptance criteria objectively verify (command or observable)?
   - Edge cases covered per SKILL.md right-sizing class?
   - Code-standards compliance plausible for the planned structure?
3. Returns EXACTLY one line verdict: `APPROVE` or `ISSUES:` + numbered list.

Orchestrator fixes issues (edits artifacts) and re-dispatches. Loop until
APPROVE — never present to the user before verifier approval.

## §plan-review — post-plan review stage

Run AFTER verify-plan returns APPROVE and BEFORE the user gate. Dispatch one
or more REVIEWER sub-agents; count scales with the right-sizing class:

- SMALL: main-agent self-review acceptable if no reviewer mechanism exists.
- MEDIUM: 1 reviewer.
- LARGE: 2–3 reviewers split by concern (correctness / ordering / docs).

```
TASK: Review the plan in .archgen/<slug>/ READ-ONLY.
EXAMINE:
  - edge cases per module
  - task ordering / parallelization sanity (waves vs real dependencies)
  - cross-module contract mismatches (interfaces, paths, naming)
  - enhancement recommendations
  - documentation completeness
DELIVERABLE: numbered findings list; each finding = what + where + why.
You NEVER edit files. Report only.
```

Reviewers are read-only and report-only — they never edit artifacts or code.
The orchestrator fixes the artifacts itself, re-runs validate.mjs + re-dispatches
the verifier gate after every change, and loops until zero findings remain or
findings are explicitly waived by the user.

## §investigate — root-cause protocol

Triggered when the USER reports repetitive/recurring issues AFTER implementation
waves completed. Do NOT patch-fix under this protocol. Complexity-sized dispatch:

- SMALL scope: main agent investigates directly.
- MEDIUM/LARGE: 1–3 investigator sub-agents split by suspected subsystem.

Investigators produce ALL four:

1. Root cause statement — one sentence naming the actual defect.
2. Evidence — files/lines/repro steps.
3. Blast radius — which tasks/artifacts are affected.
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

Every worker receives ALL of:

- task id + title;
- its acceptance criteria VERBATIM;
- its file_ownership globs ("edit NOTHING outside these");
- the code-standards reference (`references/code-standards.md`);
- instruction to run set-status done/failed immediately upon finishing:
  `node <skill>/scripts/set-status.mjs .archgen/<slug>/tasks.yaml <id> done|failed`;
- commit guidance: commit completed work scoped to the owned files;
- BEFORE writing code run
  `node <skill>/scripts/plan-graph.mjs --node <task-id> --tasks <tasks.yaml>`
  and honor every connected dependency shown;
- all file paths come from tasks.yaml/architecture.yaml VERBATIM — never
  reconstruct paths from memory.

Workers do NOT talk to each other; coordination happens only through
tasks.yaml state.

## Failure policy

- Sub-agent mechanism failure (missing/spawn/permissions) → §dispatch
  diagnose-and-ask flow FIRST. It is not yet a task failure.
- Task exit ≠ 0 OR status=failed → leave it failed. NEVER auto-retry.
- Downstream tasks stay blocked by the resolver (blockedByFailure).
- Report to user: failed id, log path, proposed fix-task description.
  [wait for user] A fix task gets fresh id, depends_on=[], ownership of the
  failed task's globs.
