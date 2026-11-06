TASK: Review the plan in .archgen/<slug>/ READ-ONLY.
DELIVERABLE: a numbered findings list; each finding = what + where + why.
You NEVER edit files. You report only.

EXAMINE
- edge cases per module
- task ordering / parallelization sanity (waves vs real dependencies)
- cross-module contract mismatches (interfaces, paths, naming)
- enhancement recommendations
- documentation completeness

CONTEXT TO ATTACH
- `archgen_plan { action: 'graph', tasksYaml: <tasks.yaml>, format: 'mermaid', status: true }`
  — the wave-progress render; reviewer reads it to sanity-check ordering.
- `archgen_docs { action: 'validate', slugDir: <slug dir> }` — the reference
  integrity result; broken references are findings, not noise.

SIZING
- SMALL: the main agent's self-review is acceptable when the harness has no
  reviewer mechanism.
- MEDIUM: 1 reviewer.
- LARGE: 1 holistic reviewer on the strongest reasoning tier. A 2nd reviewer
  ONLY if the plan is genuinely too large for one reviewer's context — split by
  ARTIFACT/VOLUME (e.g. plans vs docs), never by concern.

ONE holistic reviewer analyzes ALL issues together: cross-issue reasoning catches
contradictions a narrow per-concern slice misses, and one reviewer costs far
fewer tokens than several. NEVER dispatch one sub-agent per individual issue.

BOUNDS
- A "more review" approval authorizes EXACTLY ONE additional pass — never a
  fresh loop, never more reviewers. The stage ends ONLY at zero findings or an
  explicit user waiver on record.
- The ORCHESTRATOR fixes the artifacts, re-runs validate + the verifier gate
  after every change, and re-dispatches. Reviewers never fix.
