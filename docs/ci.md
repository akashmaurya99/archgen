# The plan gate in CI

The deterministic floor is a **build gate**, not only an agent step. It reads
artifacts — never code — so it behaves identically in every ecosystem.

## The one command

```bash
npx archgen-mcp exec archgen_plan \
  '{"action":"verify","tasksYaml":".archgen/<slug>/tasks.yaml","planDir":".archgen/<slug>/plans"}' \
  --fail-on verdict:ISSUES
```

| Exit | Meaning |
|---:|---|
| `0` | The floor is green (or only warnings) — the build continues. |
| `3` | The floor found blocking issues (`--fail-on` matched) — the build fails. |
| `1` | The tool call itself failed (bad arguments, unreadable plan). |
| `2` | Usage error. |

**Warnings never fail the build.** That is deliberate: a gate that cries wolf
gets bypassed, and a bypassed gate is worse than no gate. Blocking issues are
the ones that make the plan wrong.

## What the floor checks

- cycles, dangling `depends_on` references, and plan↔task coverage;
- a plan section of its own for every task (`PLAN_TASK_SECTION_MISSING`);
- same-wave ownership overlap, and one task's glob *containing* another's
  (reported as a warning — a later wave can overwrite the earlier task);
- the mirrored test tree (when `architecture.yaml` declares
  `toolchain.source_root` / `toolchain.test_root`);
- edge-case matrix citations that resolve, and the explicit
  `(covers E4)` claim link between a row and the acceptance it points at;
- every PRD requirement cited by an acceptance, and no dangling requirement
  citation;
- **the recorded profile honoured** — every `create` artifact exists, every
  `omit` artifact does NOT, every `reuse` cites a file that exists, and every
  artifact on disk has a decision;
- every declared path owned by a task, and every declared decision backed by
  its file;
- every waiver carrying the fields that make it an approval
  (`WAIVER_INVALID`);
- `parallel_group` labels that match the computed wave.

A rule that cannot run — because the plan declares no `toolchain` roots, or
has no `architecture.yaml` — is reported as **NOT ENFORCED** rather than
silently skipped.

## The codes

Every finding carries a stable code, so CI can group and count:

| Group | Codes |
|---|---|
| Profile | `PROFILE_NOT_RECORDED`, `PROFILE_CREATE_MISSING`, `PROFILE_OMIT_PRESENT`, `PROFILE_REUSE_MISSING`, `PROFILE_UNRECORDED`, `PROFILE_DECISION_INVALID` |
| Traceability | `MATRIX_UNKNOWN_TASK`, `MATRIX_INDEX_OUT_OF_RANGE`, `MATRIX_CLAIM_MISMATCH`, `MATRIX_DANGLING_CLAIM`, `MATRIX_CITATION_UNRESOLVED`, `MATRIX_CLAIMS_UNDECLARED`, `REQ_UNCITED`, `REQ_UNKNOWN` |
| Structure | `MIRROR_MISSING`, `DECISION_MISSING`, `PATH_UNOWNED`, `WAVE_LABEL_DRIFT`, `WAVE_GROUP_SPANS`, `WAIVER_INVALID` |
| Task file | `UNPARSEABLE`, `NO_TASKS`, `DUPLICATE_TASK_ID`, `NO_ACCEPTANCE`, `EMPTY_OWNERSHIP`, `OWNERSHIP_OVERLAP`, `CYCLE`, `DANGLING_DEP`, `PLAN_TASK_COVERAGE`, `PLAN_TASK_SECTION_MISSING`, `UNKNOWN_TASK_ID` |
| Warnings (never blocking) | `CONFIG_NOT_ENFORCED`, `OWNERSHIP_CONTAINED`, `WAIVER_COUNT_MISMATCH`, `GATE_IDENTITY_MISSING`, `TASK_FIELD_UNKNOWN`, `ARTIFACT_NOT_OWNED`, `PLAN_TASK_TITLE_DRIFT`, `CONFIG_UNPARSEABLE`, `PROFILE_UNPARSEABLE`, `ARG_IGNORED` |

`archgen_plan{action:'verify'}` returns `issues`, `warnings`, and the counts
`issueCodes` / `warningCodes`.

## A GitHub Actions step

```yaml
- name: archgen plan gate
  run: |
    npx archgen-mcp exec archgen_plan \
      '{"action":"verify","tasksYaml":".archgen/demo/tasks.yaml","planDir":".archgen/demo/plans"}' \
      --fail-on verdict:ISSUES
```

The slug is the only thing that changes per project.

## Waivers and metrics

- A waived finding is a **file**, not a sentence: `.archgen/<slug>/waivers.yaml`
  records `scope`, `finding`, `reason`, `approved_by` and `approved_at`. The
  floor reports the ledger's size and the gate brief shows it, so a waived
  deviation is visible to every later reader.
- The gate measures itself: `answers.yaml` → `plan_profile.gate` records the
  rounds used, findings by class, the waived count and the residual. The floor
  checks that the recorded waived count matches the ledger.

Both files are committed with the plan of record, so the audit trail is in the
repository's history — not in a chat transcript.
