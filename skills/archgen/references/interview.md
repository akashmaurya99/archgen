# Interview playbook — requirement elicitation

Goal: complete, conflict-free requirements in the FEWEST round-trips.
Batch 3–5 questions per message. Never ask what you can infer.

## Round 1 — business frame (ask the user)

1. What problem does this solve, and for whom? (one sentence is enough)
2. What does success look like — measurable if possible?
3. Hard constraints: deadline, budget, must-keep systems?

## Round 2 — technical frame (infer first, confirm second)

Draft answers from context (existing repo, stated stack), then confirm:
4. Stack + hosting target correct? (state your inference)
5. Scale expectation: users/reqs/day, data growth?
6. Integration surfaces: auth, payments, email, existing APIs?

## Round 3 — constraints & risks

7. Compliance needs? (GDPR/HIPAA/PCI — checklist level only)
8. What must NOT change?
9. Top 2 risks the user already knows about?

## Conflict detection

While collecting, watch for and surface immediately:
- Scale vs budget contradictions ("1M users" + "cheapest VPS")
- Feature vs constraint collisions ("real-time" + "no websockets allowed")
- Requirement vs existing-architecture conflicts (brownfield: check codebase-map)

Format: "I see a tension between X and Y. Which wins?" — one per message,
resolve before proceeding. [wait for user]

## Answers-file format (machine-readable, enables non-interactive runs)

For scripted E2E or re-runs, requirements may come from a file instead of
conversation — `.archgen/<slug>/answers.yaml`:

```yaml
scope_class: MEDIUM        # SMALL | MEDIUM | LARGE
problem: one-line problem statement
success_criteria:
  - measurable outcome
constraints:
  - must-not-change items
stack:
  language: typescript
  runtime: node
  hosting: vercel
integrations: [auth0, stripe]
compliance: []             # checklist placeholders only
risks:
  - known risk text
```

The orchestrator treats answers.yaml as authoritative user input and skips
the conversational rounds when it exists and parses cleanly.

## Completion test

Requirements are done when ALL hold:
- Every ROUND-1 question answered
- All drafted inferences confirmed or corrected
- Zero unresolved conflicts
- Scope class agreed (SMALL/MEDIUM/LARGE) — this gates artifact generation
