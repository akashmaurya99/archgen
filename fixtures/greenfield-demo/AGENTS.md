<!-- archgen:start (managed block - do not edit between markers) -->
# ArchGen - Architecture Generation & Autonomous Task Execution

This project uses the **archgen** skill, installed at `.agents/skills/archgen/`.

**Before running any archgen workflow, read its instructions:**
read `.agents/skills/archgen/SKILL.md` first - it defines every mode, gate, and rule.

Quick triggers:
- "generate architecture for X" -> greenfield GENERATE mode
- "add feature X" -> BROWNFIELD survey-first mode (analyzes this codebase)
- "start work" -> execute pending tasks in `.archgen/*/tasks.yaml` wave-by-wave
- "roll back ..." / "install mcp ..." / "fetch design skill" -> auxiliary modes

Rules of the road:
- Generated artifacts live ONLY under `.archgen/<slug>/`
- Never hand-edit task statuses - use `scripts/set-status.mjs` (comment-safe)
- Two gates before any execution: verifier approval, then human approval

## Features registry

<!-- archgen:features:start -->
| Feature | Status | Updated |
| --- | --- | --- |
| demo | done | 2026-08-25 |
<!-- archgen:features:end -->
<!-- archgen:end -->
