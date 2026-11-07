TASK: Review the plan in `<slug dir>` READ-ONLY.
SCOPE: Read-only. NEVER edit files or code; output findings only.
DELIVERABLE: ONE message in this exact format:

```
VERDICT: APPROVE
COVERAGE:
| area | status | reason |
| --- | --- | --- |
| edge cases per module | PASS | matrices cover empty, boundary, authz, concurrency, retry, and i18n states |
| task ordering & parallelization | N/A | single sequential wave |
| cross-module contracts | PASS | every shared interface has a single owning task |
| enhancement opportunities | PASS | none material for this scope |
| documentation completeness | PASS | every task has a matching plan section |
```

or

```
VERDICT: ISSUES
COVERAGE:
| area | status | reason |
| --- | --- | --- |
| ... all 5 areas above marked PASS, FAIL, or N/A ... |
FINDINGS:
1. plans/demo.md § API — response type named inconsistently — client/server contract mismatch — standardize on ApiResponse
2. docs/prd.md § Grades — FR-GRADE-02 has no owning task — requirement will not be built — add task owning grade-read endpoint
```

EXAMINE ALL 5 AREAS EVERY RUN:
1. `edge cases per module`
2. `task ordering & parallelization` (waves vs real `depends_on` edges)
3. `cross-module contracts` (interfaces, paths, `naming_conventions`)
4. `enhancement opportunities`
5. `documentation completeness`

MANDATORY COVERAGE TABLE: Must appear in every report (even on `APPROVE`). Mark every area `PASS`, `FAIL`, or `N/A` with a 1-line reason. Omitting the table or any row makes the report INCOMPLETE.

SIZING & CONTEXT
- SMALL: Main-agent self-review permitted if no reviewer sub-agent exists.
- MEDIUM: 1 holistic reviewer.
- LARGE: 1 top-tier holistic reviewer (2nd allowed ONLY if context limits force splitting `plans/` vs `docs/`; never split by review area).
- Use the pre-rendered dependency graph and doc-validation results in the `CONTEXT` block below—make zero `archgen_*` tool calls.

BOUNDS
- A user "more review" approval grants EXACTLY ONE additional pass. The stage exits only on zero findings or an explicit user waiver.
- The ORCHESTRATOR applies all fixes and re-runs `validate` + Verifier Gate; reviewers never edit files.
