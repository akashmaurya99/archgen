TASK: Verify the archgen plan in `<slug dir>` before execution.
SCOPE: Read-only. NEVER edit files; report verdict, coverage table, and findings only.
PLAN: tasks `<tasks.yaml>` · plans `<plans dir>` · artifacts `<slug dir>`

ROUND 1 — EXHAUSTIVE, ONE PASS. ROUND 2 — DELTA ONLY (see ROUNDS).

STEP 1 — THE FLOOR IS ALREADY COMPUTED FOR YOU
The CONTEXT block carries a "Mechanical floor" section: the deterministic checks (ownership overlap, mirrored test tree, matrix citations, requirement coverage, profile decisions, decision files, declared paths, wave labels) with a stable CODE each. It came from `archgen_plan { action: 'verify' }`; the reference-integrity result beside it from `archgen_docs { action: 'validate' }`. Do NOT re-derive those facts and do NOT re-run the archgen suite for them.

THE COUNTS ARE COMPLETE; THE LIST IS A SAMPLE. The floor lists its findings up to a bound, but the COUNTS per class are exact. Report a class ONCE with its count ("MIRROR_MISSING x120 — every task owns source without its mirrored test path; add the mirrored path to each") instead of one line per instance. That is the fix the orchestrator needs.

CHECK THE SNAPSHOT FIRST: the CONTEXT states how many tasks, requirements and edge rows the brief was rendered from, plus a fingerprint. If what you read disagrees, the plan CHANGED after this brief was rendered: report it and stop judging stale content.

IF A MAP SAYS "… N MORE ROW(S)", the BRIEF was bounded, not the plan. The floor still checked EVERY row; your judgement does not. Read the section it names and check every row there.

STEP 2 — JUDGMENT: DOES THE PLAN DELIVER WHAT WAS AGREED?
Read ONLY the sections named in EVIDENCE. The maps carry the facts:
- **Requirement map** — every PRD requirement, what it asks for, and the acceptance that cites it. Does the acceptance verify THAT requirement?
- **Edge-case matrix map** — every row, the acceptance it cites, and the edge ids that acceptance claims. The claim link is already checked; judge whether the acceptance MEANS the stated case.
- **Ownership map** — each task's paths and wave. Does a source owner own its mirrored test path? Does one task claim another's files?
- **Module DAG** — module dependencies and the tasks that own each module. Do the task DAG and the module DAG agree?

Then judge:
- Are the acceptance criteria objectively verifiable by a worker?
- Do the waves match real dependencies, with no artificial serialization?
- Does the plan contradict the PRD, `answers.yaml`, the decisions, or `references/code-standards.md`?
- **SCOPE & ARTIFACT NECESSITY:** the recorded profile exists and every create/reuse/omit decision matches the files on disk; every created artifact has a consumer; every reuse names a real host path; every omission records a reason; no task lacks a requirement.
- **Code standards:** source and test trees are separate — no test tree inside the source tree, and every source-owning task owns the mirrored test path.
- **Artifact tracking:** no `.gitignore` rule covers `.archgen/`, `.agents/skills/archgen`, `.claude/skills/archgen`, `AGENTS.md` or `CLAUDE.md`.

CLASSIFICATION — every finding carries exactly one class:
- **BLOCKING** — the plan contradicts an agreed requirement, an accepted decision, or a stated invariant; or a required artifact, task, or acceptance is missing. Blocks approval.
- **NIT** — cosmetic only (wording, spacing, punctuation, ordering). NEVER blocks, NEVER justifies another round. At most five, one line each.
- **OBSERVATION** — a capability nobody asked for (extra resilience, extra monitoring, a new policy). NEVER blocks; one line, no fix demand.

A finding is BLOCKING only when it names ALL THREE: the artifact (file and section), the rule it violates (a requirement, decision, recorded profile decision, code standard, or another task's contract), and the change that satisfies it. A finding that cannot name the violated rule is a NIT or an OBSERVATION. "This acceptance could also mention the non-finite case" is a NIT unless a requirement or matrix row demands it — state it once and move on.

DO NOT INVENT REQUIREMENTS: audit the plan against what was agreed. A missing capability no PRD, decision, `answers.yaml` or code-standard asked for is an OBSERVATION.

A WAIVED finding (the brief lists them) is not a defect: do not re-raise it unless it regressed.

DELIVERABLE — ONE message in this exact format:

```
VERDICT: APPROVE | ISSUES
COVERAGE:
| dimension | status | reason |
| --- | --- | --- |
| functional coverage | PASS | every FR id maps to an acceptance that verifies it |
| security & data protection | N/A | internal CLI with no auth or sensitive data |
| state, lifecycle & recovery | FAIL | TASK-07 mutates state without rollback or idempotency |
| scope & artifact necessity | PASS | profile recorded; PRD omitted for an internal change, reason cited |
| ... every one of the 9 dimensions, PASS / FAIL / N/A, 1-line reason ... |
FINDINGS:   (present when VERDICT: ISSUES)
1. [BLOCKING] tasks.yaml § SCAFFOLD — acceptance #2 has no observable check — worker cannot verify completion — replace with "the project build command exits 0"
2. [NIT] plans/demo.md § Risks — heading capitalisation — one word
OBSERVATIONS:   (optional, never blocking)
- a retention policy for the audit table would reduce unbounded growth
```

ROUNDS — THE GATE RUNS AT MOST TWICE
- **Round 1:** exhaustive — report every defect you can find in this pass.
- **Round 2:** DELTA. Re-check ONLY the Round 1 findings (fixed / still open / regressed) and the floor. Do NOT restate what is fixed. Anything new must be marked `NEW` and must meet the BLOCKING test.
- **There is no Round 3.** If Round 2 still reports open findings, the orchestrator escalates them to the user. Never run a third pass on your own initiative.

RULES
- **MANDATORY COVERAGE TABLE:** every report (even `APPROVE`) includes all 9 dimensions marked `PASS`, `FAIL`, or `N/A` with a one-line reason. Missing rows = INCOMPLETE (treated as `ISSUES`).
- **VERDICT:** `APPROVE` only when no BLOCKING finding remains. NITs and OBSERVATIONS never block.
- **Top-tier holistic agent:** the strongest reasoning model available (never a quick/explore/cheap tier), ONE agent over the entire plan.
- **Exhaustive single pass:** report EVERY defect found in this pass with exact `file § section — defect — impact — fix`. Never hold findings back for a later round.
