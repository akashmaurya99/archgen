TASK: Verify the archgen plan in `<slug dir>` before execution.
SCOPE: Read-only. NEVER edit files; report verdict, coverage table, and findings only.
PLAN: tasks `<tasks.yaml>` · plans `<plans dir>` · artifacts `<slug dir>`

ROUND 1 — EXHAUSTIVE, ONE PASS. ROUND 2 — DELTA ONLY (see ROUNDS below).

STEP 1 — THE MECHANICAL FLOOR IS ALREADY COMPUTED FOR YOU
The CONTEXT block carries a "Mechanical floor" section: the deterministic checks (ownership overlap, mirrored test tree, matrix citations, requirement coverage, profile decisions, decision files, declared paths, wave labels) with their results and a stable CODE for each. It was produced by `archgen_plan { action: 'verify' }` before you were dispatched, and the reference-integrity result beside it by `archgen_docs { action: 'validate' }`. Do NOT re-derive those facts and do NOT re-run the archgen tool suite for them. Report every BLOCKING issue the floor lists — it is already proven, so it needs no argument.

CHECK THE SNAPSHOT FIRST. The CONTEXT block states how many tasks, requirements and edge rows the brief was rendered from, plus a fingerprint. If what you read disagrees with those numbers, the plan CHANGED after the brief was rendered: report that as a finding and stop judging stale content.

IF A MAP SAYS "… N MORE ROW(S)", the brief was bounded — not the plan. The floor still checked EVERY row (links, citations, claims); your judgement does not. Read the section it names and check every row there.

STEP 2 — JUDGMENT: DOES THE PLAN DELIVER WHAT WAS AGREED?
Read ONLY the sections named in EVIDENCE. Use the rendered maps; they carry the facts:
- **Requirement map** — every PRD requirement, what it asks for, and the acceptance that cites it. Check the acceptance actually verifies that requirement, not a neighbouring one.
- **Edge-case matrix map** — every matrix row, the acceptance text it cites, and the edge ids that acceptance claims. The claim link is already checked by the floor; judge whether the acceptance MEANS the stated case.
- **Ownership map** — each task's paths and its wave. Check a source-owning task owns its mirrored test path and that one task never claims another's files.
- **Module DAG** — module dependencies and the tasks that own each module. Check the task DAG and the module DAG agree.
Then judge:
- Are the acceptance criteria objectively verifiable by a worker?
- Do the waves match real dependencies, with no artificial serialization?
- Does the plan contradict the PRD, `answers.yaml`, the decisions, or `references/code-standards.md`?
- **SCOPE & ARTIFACT NECESSITY:** the recorded profile exists and every create/reuse/omit decision matches the files on disk; every created artifact has a consumer and a trigger; every reuse names a real host path; every omission records a reason; no omitted artifact was created; no host document was duplicated; no task lacks a requirement.
- **Code standards:** the source and test trees are separate — no test tree inside the source tree, and every source-owning task owns the mirrored test path.
- **Artifact tracking:** the repository does not hide archgen artifacts — no `.gitignore` rule covers `.archgen/`, `.agents/skills/archgen`, `.claude/skills/archgen`, `AGENTS.md` or `CLAUDE.md`.

CLASSIFICATION — every finding carries exactly one class:
- **BLOCKING** — the plan contradicts an agreed requirement, an accepted decision, or a stated invariant; or a required artifact, task, or acceptance is missing. Blocks approval.
- **NIT** — cosmetic only (wording, spacing, punctuation, ordering). NEVER blocks and NEVER justifies another round. Report at most five, in one line each.
- **OBSERVATION** — a capability you believe the system should have but that no agreed requirement asked for (extra resilience, extra monitoring, a new policy). NEVER blocks; it is a suggestion to the user, not a defect to fix. Put these in one "OBSERVATIONS" list, one line each.

A finding is BLOCKING only when it names ALL THREE: the artifact (file and section), the rule it violates (a PRD requirement, an accepted decision, a recorded profile decision, a code standard, or another task's contract), and the change that satisfies it. A finding that cannot name the violated rule is a NIT or an OBSERVATION. "This acceptance could also mention the non-finite case" is a NIT unless a requirement or a matrix row demands it — state it once, in one line, and move on.

A WAIVED finding (the brief lists them) is not a defect: do not re-raise it unless it regressed.

DO NOT INVENT REQUIREMENTS: you audit the plan against what was agreed (PRD, `answers.yaml`, decisions, code-standards, the recorded profile). You do not propose new features, controls, or policies. A missing capability is an OBSERVATION.

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
- **Round 1:** exhaustive. Report every defect you can find in this pass. The orchestrator fixes them in one batch.
- **Round 2:** DELTA. Re-check ONLY (a) the findings from Round 1 — fixed, still open, or regressed — and (b) the mechanical floor. Do NOT restate a Round 1 finding that is fixed. A finding not seen in Round 1 must be marked `NEW` and must be BLOCKING-grade to be reported.
- **There is no Round 3.** If Round 2 still reports open findings, the orchestrator escalates them to the user with the outstanding list. Never run a third pass on your own initiative.

RULES
- **MANDATORY COVERAGE TABLE:** every report (even `APPROVE`) includes all 9 dimensions marked `PASS`, `FAIL`, or `N/A` with a one-line reason. Missing rows = INCOMPLETE (treated as `ISSUES`).
- **VERDICT:** `APPROVE` only when no BLOCKING finding remains. NITs and OBSERVATIONS never block.
- **Top-tier holistic agent:** run on the strongest reasoning model available (never a quick/explore/cheap tier) as ONE agent over the entire plan.
- **Exhaustive single pass:** report EVERY defect found in this pass with exact `file § section — defect — impact — fix`. Never hold findings back for a later round.
