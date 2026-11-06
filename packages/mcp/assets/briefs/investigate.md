TASK: Investigate a recurring issue in this repository.
TRIGGER: the user reports repetitive/recurring issues AFTER implementation waves
completed. This is NOT a patch-fix task.

DELIVERABLE: all four, or the investigation is incomplete:
1. ROOT CAUSE — one sentence naming the actual defect (not the symptom).
2. EVIDENCE — files / lines / repro steps that prove it.
3. BLAST RADIUS — which tasks and artifacts are affected.
   Use `archgen_plan { action: 'impact', tasksYaml: <tasks.yaml>, target: <id-or-path> }`.
4. REMEDIATION — routed through the NORMAL gates: new fix tasks get fresh ids
   inheriting the affected task's ownership globs.

SIZING
- SMALL scope: the main agent investigates directly.
- MEDIUM/LARGE: 1–3 investigator sub-agents split by suspected subsystem.

DISCIPLINE
- Read narrowly around the evidence — no whole-repo sweeps.
- A patch-fix WITHOUT a root-cause statement is FORBIDDEN under this protocol.
- Write your notes under .archgen/<slug>/.agent/notes/<topic>.md and your
  findings under .archgen/<slug>/.agent/reports/investigate-<round>.md.
  NEVER create ad-hoc folders at the repo root.
