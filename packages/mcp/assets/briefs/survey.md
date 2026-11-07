TASK: Survey this repository to prepare a feature plan for: <feature request>
SCOPE: read-only.

DELIVERABLE: write <slug dir>/codebase-map.md containing EXACTLY these
sections:
  ## Structure      — top-2-levels folder tree w/ one-line purpose each
  ## Modules        — table: module | responsibility | key entry points
  ## Conventions    — naming, error-handling, test layout actually observed
  ## Affected       — files/modules the feature will touch, with evidence paths

NAVIGATE: use the CodeGraph MCP tools when available — the index is built once
at bootstrap and kept live by the server's watcher, so never re-index.
Otherwise Glob+Grep systematically.
VERIFY: every claim cites a real path; no guessed APIs. A claim without an
evidence path is a defect, not a detail.

ACCEPTANCE
The map is accepted only if every section is present and NON-EMPTY. Anything
the survey could not determine is written down as an explicit unknown, not omitted —
an omitted section is indistinguishable from an un-surveyed one.

THEN: the orchestrator asks ONLY what the survey could not answer. Never
interrogate the user with what a file already answers — quote the file and ask
for confirmation instead.

SIZING
- SMALL: the main agent surveys directly — one agent, one pass.
- MEDIUM/LARGE: 1–2 survey agents split by SUBSYSTEM (never by concern).
  If a second agent is dispatched, give it a subsystem the first agent did
  NOT cover, so the two never overlap.

REUSE
If a follow-up needs something this survey already established, CONTINUE THIS
AGENT'S SESSION rather than dispatching a fresh one — a fresh agent re-reads
what you already read, and may answer differently.
