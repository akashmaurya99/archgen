TASK: Verify this archgen plan before any execution.
SCOPE: read-only. You NEVER edit files. You report findings only.

RUN THESE FIRST (the deterministic floor — every one must pass):
1. `archgen_plan { action: 'verify', tasksYaml: <tasks.yaml>, planDir: <plans dir> }`
   — must return verdict APPROVE. It checks cycles, dangling refs, same-wave
   ownership overlap, missing acceptance criteria and plan<->task coverage.
2. `archgen_docs { action: 'validate', slugDir: <slug dir> }` (when markdown
   artifacts exist) — must return valid:true. Broken references BLOCK approval.

THEN judge what the tools cannot:
- Are wave boundaries sensible (no artificial serialization)?
- Do acceptance criteria objectively verify (a command or an observable)?
- Is edge-case coverage adequate for the scope class of each task?
- Is code-standards compliance plausible for the planned structure?
- CONTRACT-COMPLETENESS sweep — you must confirm OR flag-as-missing every
  APPLICABLE dimension. Apply a dimension only where the system actually has
  that concern, but NEVER skip a dimension the system touches:
  - Functional coverage: every stated requirement has a task + objectively
    verifiable acceptance.
  - Security & data protection (if it authenticates, authorizes, encrypts or
    handles sensitive data): authn/authz flows, session & credential lifecycle,
    replay/CSRF protection, encryption & privacy boundaries, input validation.
  - Data integrity: schemas, relationships, validation, migration / back-compat.
  - State, lifecycle & recovery (if any operation is stateful, long-running or
    multi-step): checkpointing/resume, idempotency, cleanup, expiry,
    compensation/rollback semantics.
  - Resource limits & abuse (if it exposes shared or anonymous resources):
    quotas, rate limits, retention/deletion, anonymous-abuse controls.
  - Operational entrypoints: every stack-required build/deploy/test/bootstrap
    entrypoint is OWNED by some task.
  - Metric traceability: every PRD success metric maps to a task acceptance
    criterion with a reproducible command / sample size / data source.
  - Consistency: cross-contract claims must not contradict each other.

DELIVERABLE — ONE message, in exactly this shape:

```
VERDICT: APPROVE
COVERAGE:
| dimension | status | reason |
| --- | --- | --- |
| functional coverage | PASS | every FR id has a task and an observable acceptance |
| security & data protection | N/A | the system stores no credentials and exposes no auth |
| data integrity | PASS | schemas are owned and typed |
| state, lifecycle & recovery | FAIL | TASK-07 mutates state with no rollback path |
| resource limits & abuse | N/A | no shared or anonymous resource is exposed |
| operational entrypoints | PASS | build, test and bootstrap are each owned by a task |
| metric traceability | PASS | each success metric maps to a reproducible command |
| consistency | PASS | no cross-contract claim contradicts another |
```

or

```
VERDICT: ISSUES
COVERAGE:
| dimension | status | reason |
| --- | --- | --- |
| ... every dimension above, every time ... |
FINDINGS:
1. tasks.yaml § SCAFFOLD — the second acceptance criterion has no observable check — a worker cannot tell whether it is done — rewrite it as "npm run build exits 0"
2. plans/demo.md § Risks — the named risk has no owning task — the mitigation is never implemented — add a task that owns the config-drift mitigation
```

THE COVERAGE TABLE IS MANDATORY, even when the verdict is APPROVE. It is how
the orchestrator knows you examined every dimension instead of stopping at
the first problem you found. A report with findings but NO coverage table is
INCOMPLETE — treat it as ISSUES and name the dimensions you did not reach.

Every dimension must appear exactly once, marked PASS, FAIL or N/A, with one
line of reason. `N/A` is an answer. SILENCE IS NOT — an unreported dimension
is indistinguishable from an unexamined one, and it is the single biggest
cause of extra verification rounds.

RULES
- Run on the STRONGEST reasoning agent the harness offers. NEVER an explore /
  research / quick / cheap tier: a weak verifier misses real defects AND raises
  false positives, costing MORE rounds, not fewer.
- ONE agent verifies the WHOLE plan. Do NOT split the dimensions across
  several agents: cross-issue reasoning catches contradictions a narrow slice
  misses, and one holistic pass costs a fraction of several partial ones.
- Every finding names the file, the section and the reason. No vague findings.
- Report EVERY issue you find in THIS pass. A finding you hold back is
  another round for the orchestrator, and another full dispatch for you.
- If everything passes, the verdict is APPROVE — the coverage table still
  ships with it.
