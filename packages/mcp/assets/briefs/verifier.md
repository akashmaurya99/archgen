TASK: Verify the archgen plan in `<slug dir>` before execution.
SCOPE: Read-only. NEVER edit files; report verdict, coverage table, and findings only.
PLAN: tasks `<tasks.yaml>` · plans `<plans dir>` · artifacts `<slug dir>`

ROUND 1 — EXHAUSTIVE, ONE PASS. ROUND 2 — DELTA ONLY (see ROUNDS).

STEP 1 — THE FLOOR IS ALREADY COMPUTED FOR YOU
The CONTEXT block carries a "Mechanical floor" section: the floor's VERDICT, the counts per finding class, and the codes it reported (ownership overlap, mirrored test tree, matrix citations, requirement coverage, profile decisions, decision files, declared paths, wave labels). It came from `archgen_plan { action: 'verify' }`; the reference-integrity result beside it from `archgen_docs { action: 'validate' }`. The checks that found nothing are NOT listed — a class with a count of zero is a class that passed. Do NOT re-derive those facts and do NOT re-run the archgen suite for them.

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

<!-- include: _gate-protocol.md -->

DELIVERABLE — ONE message in this exact format:

```
VERDICT: APPROVE | ISSUES
COVERAGE:
| dimension | status | reason |
| --- | --- | --- |
| functional coverage | PASS | every FR id maps to an acceptance that verifies it |
| security & data protection | N/A | internal CLI with no auth or sensitive data |
| data integrity | PASS | every persisted write states its invariant |
| state, lifecycle & recovery | FAIL | TASK-07 mutates state without rollback or idempotency |
| resource limits & abuse | N/A | no unbounded input is accepted |
| operational entrypoints | PASS | one named entrypoint, runnable from the repo root |
| metric traceability | N/A | no metric is promised |
| consistency | PASS | one vocabulary across plan, tasks and contract |
| scope & artifact necessity | PASS | profile recorded; PRD omitted for an internal change, reason cited |
FINDINGS:   (present when VERDICT: ISSUES)
1. [BLOCKING] tasks.yaml § SCAFFOLD — acceptance #2 has no observable check — worker cannot verify completion — replace with "the project build command exits 0"
2. [NIT] plans/demo.md § Risks — heading capitalisation — one word
OBSERVATIONS:   (optional, never blocking)
- a retention policy for the audit table would reduce unbounded growth
```

THE NINE DIMENSIONS — every report marks all nine, `PASS` / `FAIL` / `N/A`, with a one-line reason:

1. **functional coverage** — every requirement maps to an acceptance that verifies it
2. **security & data protection** — auth, secrets, untrusted input, PII
3. **data integrity** — invariants, migrations, idempotency, concurrency
4. **state, lifecycle & recovery** — what happens on partial failure, retry, rollback
5. **resource limits & abuse** — unbounded input, unbounded growth, denial of service
6. **operational entrypoints** — how the thing is actually started, run and verified
7. **metric traceability** — every promised outcome has a measurable signal
8. **consistency** — one vocabulary and one shape across plan, tasks, contract and code
9. **scope & artifact necessity** — every artifact has a consumer; every omission a reason

`N/A` needs a reason too ("internal CLI with no auth or sensitive data"), not a blank cell.

RULES
- **MANDATORY COVERAGE TABLE:** every report (even `APPROVE`) includes all 9 dimensions marked `PASS`, `FAIL`, or `N/A` with a one-line reason. Missing rows = INCOMPLETE (treated as `ISSUES`).
- **VERDICT:** `APPROVE` only when no BLOCKING finding remains. NITs and OBSERVATIONS never block.
- **ONE agent, the whole plan, ONE pass.** Never split verification by concern; split only by artifact volume when context forces it (`plans/` vs `docs/`).
- **Exhaustive single pass:** report EVERY defect found in this pass with exact `file § section — defect — impact — fix`. Never hold findings back for a later round.
