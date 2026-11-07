TASK: Review the plan in <slug dir> READ-ONLY.
SCOPE: read-only. You NEVER edit files or code. You report findings only.
DELIVERABLE: ONE message, in exactly this shape:

```
VERDICT: APPROVE
COVERAGE:
| area | status | reason |
| --- | --- | --- |
| edge cases per module | PASS | each module's matrix covers empty, error and overflow states |
| task ordering & parallelization | N/A | the plan is a single sequential wave |
| cross-module contracts | PASS | every shared type has one owning task |
| enhancement opportunities | PASS | none material at this scope |
| documentation completeness | PASS | every task has a plan section |
```

or

```
VERDICT: ISSUES
COVERAGE:
| area | status | reason |
| --- | --- | --- |
| ... every area below, every time ... |
FINDINGS:
1. plans/demo.md § API — the response type is named two ways — the client and the server will not agree — rename both to ApiResponse
2. docs/prd.md § Grades — the requirement has no owning task — it will never be built — add a task owning the grade-read surface
```

EXAMINE — every area, every time:
- edge cases per module
- task ordering / parallelization sanity (waves vs real dependencies)
- cross-module contract mismatches (interfaces, paths, naming)
- enhancement recommendations
- documentation completeness

THE COVERAGE TABLE IS MANDATORY, even when the verdict is APPROVE. It proves
every area was examined rather than abandoned at the first finding. Mark each
area PASS, FAIL or N/A with one line of reason — `N/A` is an answer, silence
is not. A report with findings but no coverage table is INCOMPLETE.

SIZING
- SMALL: the main agent's self-review is acceptable when the harness has no
  reviewer mechanism.
- MEDIUM: 1 reviewer.
- LARGE: 1 holistic reviewer on the strongest reasoning tier. A 2nd reviewer
  ONLY if the plan is genuinely too large for one reviewer's context — split
  by ARTIFACT/VOLUME then (e.g. plans vs docs), never by concern.

ONE holistic reviewer analyzes ALL issues together: cross-issue reasoning
catches contradictions a narrow per-concern slice misses, and one reviewer
costs far fewer tokens than several. NEVER dispatch one sub-agent per
individual issue, and NEVER split the areas above across agents.

The dependency graph and the reference-integrity result are rendered in the
CONTEXT block below — use them; do not re-fetch them.

BOUNDS
- A "more review" approval authorizes EXACTLY ONE additional pass — never a
  fresh loop, never more reviewers. The stage ends ONLY at zero findings or an
  explicit user waiver on record.
- The ORCHESTRATOR fixes the artifacts, re-runs validate + the verifier gate
  after every change, and re-dispatches. Reviewers never fix.
