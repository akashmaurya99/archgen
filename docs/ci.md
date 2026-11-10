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
- same-wave ownership overlap, and one task's glob *containing* another's
  (reported as a warning — a later wave can overwrite the earlier task);
- the mirrored test tree (when `architecture.yaml` declares
  `toolchain.source_root` / `toolchain.test_root`);
- edge-case matrix citations that resolve, and the explicit
  `(covers E4)` claim link between a row and the acceptance it points at;
- every PRD requirement cited by an acceptance, and no dangling requirement
  citation;
- every declared path owned by a task, and every declared decision backed by
  its file;
- `parallel_group` labels that match the computed wave.

A rule that cannot run — because the plan declares no `toolchain` roots, or
has no `architecture.yaml` — is reported as **NOT ENFORCED** rather than
silently skipped.

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
