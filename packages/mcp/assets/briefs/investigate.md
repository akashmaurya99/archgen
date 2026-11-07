TASK: Investigate a recurring issue in this repository.
TRIGGER: the user reports repetitive/recurring issues AFTER implementation waves
completed. This is NOT a patch-fix task.
SCOPE: read-only unless the brief says otherwise — you investigate and report.

DELIVERABLE: all four, or the investigation is incomplete:
1. ROOT CAUSE — one sentence naming the actual defect (not the symptom).
2. EVIDENCE — files / lines / repro steps that prove it.
3. BLAST RADIUS — which tasks and artifacts are affected.
   Use `archgen_plan { action: 'impact', tasksYaml: <tasks.yaml>, target: <id-or-path> }`.
4. REMEDIATION — routed through the NORMAL gates: new fix tasks get fresh ids
   inheriting the affected task's ownership globs.

SIZING
- SMALL scope: the main agent investigates directly.
- MEDIUM/LARGE: 1 investigator by default. A 2nd only when the suspected
  cause genuinely spans disjoint subsystems — then split by SUBSYSTEM, never
  by concern, and never let two investigators cover the same files.

DISCIPLINE
- Read narrowly around the evidence — no whole-repo sweeps.
- A patch-fix WITHOUT a root-cause statement is FORBIDDEN under this protocol.
- Write your notes under <slug dir>/.agent/notes/<topic>.md and your
  findings under <slug dir>/.agent/reports/investigate-<round>.md.
  NEVER create ad-hoc folders at the repo root.

REUSE
If a follow-up needs this investigation's context — a fix in the files you
already read, a clarification, a re-check of your own conclusion — CONTINUE
THIS AGENT'S SESSION. Never dispatch a fresh agent for the same question:
it re-reads what you already read, and may reach a different conclusion.
