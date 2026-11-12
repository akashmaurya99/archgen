TASK: Review the plan in `<slug dir>` READ-ONLY.
SCOPE: Read-only. NEVER edit files or code; output findings only.
PLAN: tasks `<tasks.yaml>` · plans `<plans dir>` · artifacts `<slug dir>`
DELIVERABLE: ONE message in this exact format:

```
VERDICT: APPROVE | ISSUES
COVERAGE:
| area | status | reason |
| --- | --- | --- |
| edge cases per module | PASS | matrices cover empty, boundary, authz, concurrency, retry, and i18n states, within the profile budget |
| task ordering & parallelization | PASS | waves follow depends_on; parallel groups are disjoint |
| cross-module contracts | FAIL | response type differs between client and server |
| scope fit & minimalism | PASS | every artifact has a consumer; omissions and reuse decisions are recorded |
| documentation completeness | PASS | every task has a plan section |
FINDINGS:   (present when VERDICT: ISSUES)
1. plans/demo.md § API — response type named inconsistently — client/server contract mismatch — standardize on ApiResponse
2. docs/prd.md § Grades — FR-GRADE-02 has no owning task — requirement will not be built — add a task owning the grade-read endpoint
3. .archgen/demo/docs/mermaid-snippets.md — diagram shipped for a single-module flow the profile says omit — unneeded artifact — delete it and record the omit reason
```

EXAMINE ALL 5 AREAS EVERY RUN: `edge cases per module` · `task ordering & parallelization` (waves vs real `depends_on` edges) · `cross-module contracts` (interfaces, paths, `naming_conventions`) · `scope fit & minimalism` (unneeded artifacts, unneeded tasks, duplicated host docs, missing omit/reuse reasons) · `documentation completeness` (every task has a plan section).

<!-- include: _gate-protocol.md -->

MANDATORY COVERAGE TABLE: Must appear in every report (even on `APPROVE`). Mark every area `PASS`, `FAIL`, or `N/A` with a 1-line reason. Omitting the table or any row makes the report INCOMPLETE.

SIZING & CONTEXT
- SMALL: Main-agent self-review; no reviewer sub-agent.
- MEDIUM: Main-agent review against the profile; no reviewer sub-agent.
- LARGE: 1 independent top-tier holistic reviewer (2nd allowed ONLY if context limits force splitting `plans/` vs `docs/`; never split by review area).
- Use the pre-rendered dependency graph and doc-validation results in the `CONTEXT` block below—make zero `archgen_*` tool calls.

BOUNDS
- The ORCHESTRATOR applies all fixes and re-runs the deterministic floor; reviewers never edit files, and the review stage does not re-open the verifier stage.
