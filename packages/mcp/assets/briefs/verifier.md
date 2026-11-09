TASK: Verify the archgen plan in `<slug dir>` before execution.
SCOPE: Read-only. NEVER edit files; report verdict, coverage table, and findings only.

STEP 1 — RUN DETERMINISTIC CHECKS FIRST (both must pass):
1. `archgen_plan { action: 'verify', tasksYaml: <tasks.yaml>, planDir: <plans dir> }` → must return `verdict: 'APPROVE'` (validates DAG, dangling refs, wave ownership disjointness, acceptance presence, and bidirectional plan↔task coverage).
2. `archgen_docs { action: 'validate', slugDir: <slug dir> }` (if markdown artifacts exist) → must return `valid: true` (zero broken links or heading anchors).

STEP 2 — AUDIT JUDGMENT & CONTRACT COMPLETENESS:
- Wave boundaries match true dependencies without artificial serialization.
- Acceptance criteria are objectively verifiable (runnable command or observable output).
- Edge-case coverage satisfies the profile's depth budget (`SMALL` / `MEDIUM` / `LARGE`).
- Planned structure and naming obey `references/code-standards.md` — including the separate source and test trees: no test tree inside the source tree, and every task that owns source owns the mirrored test path.
- The repository does not hide archgen artifacts: no `.gitignore` rule covers `.archgen/`, `.agents/skills/archgen`, `.claude/skills/archgen`, `AGENTS.md` or `CLAUDE.md`.
- **SCOPE & ARTIFACT NECESSITY:** the plan records a profile (`## Profile` or `answers.yaml plan_profile:`); every created artifact is marked `create` and has a consumer; every `reuse` names a real host path; every `omit` records a reason; no omitted PRD, architecture file, ADR, or diagram was created; no host PRD/architecture/ADR was duplicated; no task lacks a requirement.
- **CONTRACT-COMPLETENESS SWEEP** (evaluate every dimension; mark `N/A` only when the system genuinely lacks that surface):
  1. `functional coverage`: Every requirement maps to a task + objective acceptance check.
  2. `security & data protection`: Authn/authz flows, session/credential lifecycle, CSRF/replay defense, encryption/privacy boundaries, boundary input validation.
  3. `data integrity`: Schemas, foreign keys/relations, validation rules, migrations & backward compatibility.
  4. `state, lifecycle & recovery`: Checkpointing/resume, idempotency, cleanup/TTL, rollback/compensation for stateful or multi-step flows.
  5. `resource limits & abuse`: Quotas, rate limiting, data retention/deletion, unauthenticated abuse controls.
  6. `operational entrypoints`: Build, test, deploy, and bootstrap entrypoints are each owned by a task.
  7. `metric traceability`: Every PRD success metric maps to a task acceptance check with a reproducible command, sample size, or data source.
  8. `consistency`: Zero contradictions across PRD, `architecture.yaml`, `plans/*.md`, and `tasks.yaml`.
  9. `scope & artifact necessity`: The profile is recorded and every artifact/reuse/omit decision is justified and respected.

DELIVERABLE — ONE message in this exact format:

```
VERDICT: APPROVE | ISSUES
COVERAGE:
| dimension | status | reason |
| --- | --- | --- |
| functional coverage | PASS | all FR IDs map to tasks with runnable checks |
| security & data protection | N/A | internal CLI with no auth or sensitive data |
| state, lifecycle & recovery | FAIL | TASK-07 mutates state without rollback or idempotency |
| scope & artifact necessity | PASS | profile recorded; PRD omitted for an internal change with the reason cited |
| ... every one of the 9 dimensions, PASS / FAIL / N/A, 1-line reason ... |
FINDINGS:   (present when VERDICT: ISSUES)
1. tasks.yaml § SCAFFOLD — acceptance #2 has no observable check — worker cannot verify completion — replace with "the project build command exits 0"
2. plans/demo.md § Risks — config-drift risk has no owning task — mitigation never built — assign mitigation to TASK-01
3. .archgen/demo/docs/prd.md — created although the profile says omit (internal tool) — unneeded artifact and duplicated host PRD — delete it and cite docs/product/prd.md in the Profile
```

RULES
- **MANDATORY COVERAGE TABLE:** Every report (even `APPROVE`) must include all 9 dimensions marked `PASS`, `FAIL`, or `N/A` with a 1-line reason. Missing rows = INCOMPLETE report (treated as `ISSUES`).
- **Top-tier holistic agent:** Run on the strongest reasoning model available (never a quick/explore/cheap tier) as ONE holistic agent across the entire plan.
- **Exhaustive single pass:** Report EVERY defect found in this pass with exact `file § section — defect — impact — fix`. Never hold findings back for a later round.
