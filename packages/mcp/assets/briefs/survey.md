TASK: Survey this repository to prepare a feature plan for: `<feature request>`
SCOPE: Read-only exploration, writing ONLY `<slug dir>/codebase-map.md`.

DELIVERABLE: Write `<slug dir>/codebase-map.md` containing EXACTLY these six non-empty sections:
## Structure — Top 2 directory levels with 1-line purpose per folder; name the source and test roots.
## Modules — Table: `module | responsibility | key entry points`.
## Conventions — Observed naming, error handling, state management, and where tests actually live.
## Existing docs — Table: `document | path | what it decides | freshness`; include PRDs, architecture docs, ADRs, README/runbooks. Mark each `current` or `stale`.
## Toolchain — Source root, test root, build/test/lint/typecheck commands, package manager, runtime versions, naming/test-placement conventions.
## Affected — Files/modules impacted by the feature, citing exact evidence paths.

NAVIGATION & VERIFICATION
- Prefer CodeGraph MCP tools when `.codegraph/` is present (index is kept live by the watcher—never re-index); otherwise use systematic Glob + Grep.
- Every architectural claim MUST cite a real repository file path. Never guess APIs, commands, or conventions.
- Every section must be present and non-empty; document unresolved items as explicit unknowns rather than omitting sections.
- Downstream rule: the orchestrator will ask the user ONLY what this map could not answer, and will pass `existing-prd` / `existing-architecture` / `existing-adr` signals to the scope profile when the corresponding document is current.

SIZING & REUSE
- SMALL: Main agent surveys in one pass.
- MEDIUM / LARGE: 1–2 survey agents split strictly by disjoint SUBSYSTEM (zero file overlap).
- Continue this agent's session for any follow-up questions covering the surveyed subsystem.
