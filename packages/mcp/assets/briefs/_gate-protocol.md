CLASSIFICATION — every finding carries exactly one class:
- **BLOCKING** — the plan contradicts an agreed requirement, an accepted decision, or a stated invariant; or a required artifact, task, or acceptance is missing. Blocks approval.
- **NIT** — cosmetic only (wording, spacing, punctuation, ordering). NEVER blocks, NEVER justifies another round. At most five, one line each.
- **OBSERVATION** — a capability nobody asked for (extra resilience, extra monitoring, a new policy). NEVER blocks; one line, no fix demand.

A finding is BLOCKING only when it names ALL THREE:
1. the artifact (file and section),
2. the rule it violates — a PRD requirement, an accepted decision, a recorded profile decision, a code standard, or another task's contract,
3. the change that satisfies it.

A finding that cannot name the violated rule is a NIT or an OBSERVATION. "This could be phrased more precisely" is a NIT: state it once, in one line, and move on.

DO NOT INVENT REQUIREMENTS: audit the plan against what was agreed. A missing capability no PRD, decision, `answers.yaml` or code-standard asked for is an OBSERVATION.

A WAIVED finding (the brief lists them) is not a defect: do not re-raise it unless it regressed.

ROUNDS — THE GATE RUNS AT MOST TWICE
- **Round 1 is exhaustive:** report every finding of every area in one pass, area by area. Holding a finding back to see what a fix does is a defect in Round 1.
- **Round 2 is a DELTA:** re-check only the Round 1 findings (fixed / still open / regressed) and the artifacts the fix touched. Do not restate what is fixed. Anything new must be marked `NEW` and must meet the BLOCKING test.
- **There is no Round 3.** After Round 2 the residual is the orchestrator's to fix (and the floor to re-check) or the user's to decide.
- A user "more review" approval grants EXACTLY ONE additional pass, with a stated purpose. The stage exits only on **zero BLOCKING findings** or an explicit user waiver — a NIT and an OBSERVATION never hold the stage open.
- The ORCHESTRATOR applies all fixes and re-runs the deterministic floor; the gate agent never edits files, and the review stage does not re-open the verifier stage.
