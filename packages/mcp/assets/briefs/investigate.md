TASK: Investigate a recurring post-execution defect in this repository.
TRIGGER: User reports repetitive/recurring issues AFTER implementation waves completed. This is NOT a patch-fix task.
SCOPE: Read-only analysis and reporting (unless the brief explicitly authorizes edits).

DELIVERABLE — all four sections are MANDATORY:
1. ROOT CAUSE: One sentence identifying the underlying defect (never merely the symptom).
2. EVIDENCE: Exact file paths, line numbers, and reproduction steps proving the root cause.
3. BLAST RADIUS: Affected tasks and artifacts, computed with `archgen_plan{action:'impact', tasksYaml: TASKS_YAML_PATH, target: TASK-ID}` — put the absolute tasks.yaml path from the CONTEXT block in TASKS_YAML_PATH, and the FAILING TASK's id (or an owned artifact path) in TASK-ID. This is the only archgen call you may make.
4. REMEDIATION: Proposed fix tasks (new task IDs inheriting affected `file_ownership` globs) routed through normal Verifier, Review, and User gates.

SIZING
- SMALL: Main agent investigates directly.
- MEDIUM / LARGE: 1 investigator by default. Dispatch a 2nd investigator ONLY when the suspected defect spans disjoint subsystems—split strictly by SUBSYSTEM with zero file overlap.

DISCIPLINE
- Read narrowly around evidence paths; avoid whole-repo sweeps.
- Patch-fixing without a verified root-cause statement is FORBIDDEN.
- Write working notes to `<slug dir>/.agent/notes/<topic>.md` and final report to `<slug dir>/.agent/reports/investigate-<round>.md`. Never create ad-hoc root directories.

REUSE
For any follow-up question, verification, or fix touching these files, CONTINUE THIS AGENT'S SESSION rather than spawning a new agent.
