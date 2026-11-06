TASK: Verify this archgen plan before any execution.
DELIVERABLE: exactly one line — `APPROVE` or `ISSUES:` followed by a numbered list.
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
- CONTRACT-COMPLETENESS sweep — round 1 must confirm OR flag-as-missing every
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
  These failure classes are the TOP cause of multi-round loops — round 1 MUST
  sweep the applicable dimensions exhaustively.

RULES
- Run on the STRONGEST reasoning agent the harness offers. NEVER an explore /
  research / quick / cheap tier: a weak verifier misses real defects AND raises
  false positives, costing MORE rounds, not fewer.
- Every finding names the file and the reason. No vague findings.
- If everything passes, return exactly `APPROVE` and nothing else.
