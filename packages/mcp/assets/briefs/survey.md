TASK: Survey this repository to prepare a feature plan for: `<feature request>`
SCOPE: Read-only exploration, writing ONLY `<slug dir>/codebase-map.md`.

DELIVERABLE: Write `<slug dir>/codebase-map.md` containing EXACTLY these four non-empty sections:
## Structure — Top 2 directory levels with 1-line purpose per folder
## Modules — Table: `module | responsibility | key entry points`
## Conventions — Observed file naming, error handling, and test placement patterns
## Affected — Files/modules impacted by the feature, citing exact evidence paths

NAVIGATION & VERIFICATION
- Prefer CodeGraph MCP tools when `.codegraph/` is present (index is kept live by the watcher—never re-index); otherwise use systematic Glob + Grep.
- Every architectural claim MUST cite a real repository file path. Never guess APIs.
- Every section must be present and non-empty; document unresolved items as explicit unknowns rather than omitting sections.
- Downstream rule: The orchestrator will ask the user ONLY what this map could not answer.

SIZING & REUSE
- SMALL: Main agent surveys in one pass.
- MEDIUM / LARGE: 1–2 survey agents split strictly by disjoint SUBSYSTEM (zero file overlap).
- Continue this agent's session for any follow-up questions covering the surveyed subsystem.
