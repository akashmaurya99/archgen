# Interview playbook — requirement elicitation

Goal: complete, conflict-free requirements in the FEWEST round-trips.
Batch 3–5 questions per message. Never ask what you can infer.

## Round 0 — calibration exchange (skippable)

Two or three rapid questions, asked once at the very start:

1. Rough scale: prototype, MVP, or production-bound?
2. Team size + convention constraints? (solo? existing lint/CI/style guides?)
3. Deadline pressure: none, moderate, crunch?

Purpose is ONLY to pick question-set depth and right-size later verification
rigor — never to collect requirements. SKIP the whole exchange when the user's
opening message already answers these items (e.g. "quick prototype by Friday").
Record whatever was captured under `calibration:` in answers.yaml.

## Step 1 — classify intent (decide during round 1)

From the opening message + calibration, decide ONE intent class, state it to
the user in one sentence, and record it as `intent_class` in answers.yaml:

| intent_class | Signal | Question depth | Round cap |
|---|---|---|---|
| GREENFIELD-SYSTEM | net-new product/system from scratch; no host repo | full PRD-grade discovery | ≤6 |
| GREENFIELD-MODULE | net-new capability inside an existing system/repo | targeted; infer from host repo first | ≤3 |
| BROWNFIELD-FEATURE | existing repo, additive behavior | survey-first; ask only survey gaps (max ~5 questions) | ≤3 |
| BROWNFIELD-CHANGE | modify existing behavior in place | survey-first; diff current vs desired | ≤3 |

Never interrogate a BROWNFIELD-FEATURE with PRD-grade questions — token waste,
user annoyance. Round caps INCLUDE round 0 when it runs.

Default `scope_class` from the intent class (user's choice wins — scope_class
is agreed in GENERATE step 1 and recorded in answers.yaml):
GREENFIELD-SYSTEM→LARGE, GREENFIELD-MODULE→MEDIUM,
BROWNFIELD-FEATURE→MEDIUM/SMALL, BROWNFIELD-CHANGE→SMALL.

## GREENFIELD-SYSTEM — professional discovery (≤6 rounds)

Creating a system from scratch demands PRD-grade inputs. Each round below
lists its questions and where the answers land (`feeds:` tags — see
Traceability).

### R1 — problem, users, success → PRD

1. What problem does this solve, for whom — and what is explicitly NOT a goal?
2. Who uses it? Sketch 1–3 personas: role, key job-to-be-done, environment.
3. What does success look like — measurable (activation, conversion,
   time-saved, error rate)? Adjectives are not metrics.

### R2 — shape & module decomposition → architecture.yaml `modules`

Infer stack/hosting from stated preferences, then confirm:

4. Stack + hosting target correct? (state your inference)
5. Integration surfaces: auth, payments, email, existing APIs?

Then PROPOSE a strawman module map from the domain talk — one line per
candidate module as `name — responsibility` (mirroring `modules[]`:
name/responsibility/owns) — and ask the user to react:

6. React to this strawman module map: [list]. What is missing, misnamed, or
   should be merged/split? Iterate until agreement — this seeds
   architecture.yaml `modules`.

### R3 — data & API sketches → `data_contracts`, `api_contracts`

7. Core data entities and relationships — one line each: Entity — key fields —
   belongs-to / has-many? (seeds `data_contracts`)
8. Primary API surface: the 5–10 operations users/systems perform, verb +
   resource? (seeds `api_contracts`)

### R4 — NFRs with numbers → PRD

Numbers or it didn't happen — reject "fast"/"scalable" without figures.

9. Performance budgets: p95 latency, throughput at peak?
10. Scale targets: users, reqs/day, data growth per year?
11. Security/compliance checklist level (GDPR/HIPAA/PCI)? i18n locales?
    Accessibility level (e.g. WCAG 2.2 AA)?

### R5 — environment & naming → `environment_matrix`, `naming_conventions`

12. Environment/deploy reality: which environments exist (dev/staging/prod),
    hosting, config/secrets handling, deploy cadence? (seeds
    `environment_matrix`)
13. Naming/brand conventions that already exist: product-name casing, domain
    terms to preserve, UI copy language(s)? (seeds `naming_conventions`;
    "none" is a valid answer)

### R6 — close-out → PRD

14. Explicit out-of-scope list — adjacent things on record as NOT in this build?
15. Top 2 risks you already know about?

Close by presenting the agreed module map + captured NFR numbers for final
confirmation ([wait for user]).

### Traceability — `feeds:` tags

Every recorded answer MAY carry a `feeds:` tag naming the artifact section it
lands in. Keep the vocabulary literal — downstream templates consume these
exact names:

- PRD sections: `prd.problem`, `prd.goals`, `prd.non_goals`, `prd.personas`,
  `prd.metrics`, `prd.nfrs`, `prd.constraints`, `prd.integrations`,
  `prd.risks`, `prd.out_of_scope`
- architecture.yaml keys: `arch.modules`, `arch.data_contracts`,
  `arch.api_contracts`, `arch.environment_matrix`, `arch.naming_conventions`

Multiple targets join with `|`, e.g. `feeds: prd.goals|arch.modules`.

## GREENFIELD-MODULE — net-new inside an existing system (≤3 rounds)

Infer first from the host repo (structure, conventions, neighboring modules),
confirm second:

1. Where does it plug in — which host modules does it read from / expose to?
2. Contract with the host: data it consumes/produces, APIs or events it
   exposes? (seeds `data_contracts` / `api_contracts` deltas)
3. Inherited vs new NFRs: follow host perf/a11y/i18n baselines or set new ones?
4. Naming follows host conventions — confirm? (seeds `naming_conventions`)

## BROWNFIELD classes — survey BEFORE questioning (mandatory)

Run the survey first (SKILL.md BROWNFIELD steps 1–2): prefer the codegraph MCP
(`codegraph_explore`) when configured, else structured glob/grep; produce or
update `.archgen/<slug>/codebase-map.md`. Then ask ONLY what the survey could
not answer. NEVER ask what a file already answers — quote the file and ask for
confirmation instead.

### BROWNFIELD-FEATURE (additive; max ~5 questions, one batched message)

Ask only unresolved gaps, typically:

1. Acceptance criteria the code cannot reveal — exact expected behavior, edge
   cases that matter.
2. Back-compat expectations for existing records or clients.
3. Rollout preference: feature flag, staged, immediate?
4. Must-NOT-touch paths beyond what the map shows?
5. Anything the codebase-map got wrong?

### BROWNFIELD-CHANGE (behavior modification; ≤3 rounds)

Survey focus: current behavior + blast radius (callers, tests, consumers).

1. Current vs desired behavior — precise diff, including what must stay.
2. Compatibility: migrate in place, version alongside, or breaking change?
3. Acceptance for "changed": how do we prove old behavior is gone and the new
   behavior holds?

## Conflict detection

While collecting, watch for and surface immediately:
- Scale vs budget contradictions ("1M users" + "cheapest VPS")
- Feature vs constraint collisions ("real-time" + "no websockets allowed")
- Requirement vs existing-architecture conflicts (brownfield: check codebase-map)

Format: "I see a tension between X and Y. Which wins?" — one per message,
resolve before proceeding. [wait for user]

## Token discipline

- Batch 3–5 questions per message; never ping-pong one-per-message.
- Hard round caps: GREENFIELD-SYSTEM ≤6 rounds, every other class ≤3
  (round 0 counts when it runs).
- Skip any question already answered by the opening message, calibration, or
  survey artifacts.

## Answers-file format (machine-readable, enables non-interactive runs)

For scripted E2E or re-runs, requirements may come from a file instead of
conversation — `.archgen/<slug>/answers.yaml`:

```yaml
scope_class: MEDIUM        # SMALL | MEDIUM | LARGE — UNCHANGED; SKILL.md reads
                           # this for right-sizing. Never remove or rename.
intent_class: GREENFIELD-SYSTEM  # optional: GREENFIELD-SYSTEM |
                           # GREENFIELD-MODULE | BROWNFIELD-FEATURE |
                           # BROWNFIELD-CHANGE
calibration:               # optional — from round 0
  scale: production        # prototype | mvp | production
  teamConstraints: solo dev, repo lint rules apply
  pressure: medium         # low | medium | high
problem: one-line problem statement
success_criteria:
  - text: measurable outcome          # structured entries MAY carry feeds:
    feeds: prd.metrics
constraints:
  - must-not-change item              # plain scalars stay valid; tag via
                                      # trailing comment:  # feeds: prd.constraints
non_goals:                 # optional (GREENFIELD-SYSTEM)
  - multi-tenant accounts
personas:                  # optional (GREENFIELD-SYSTEM)
  - role: shopper
    goal: find and buy in under two minutes
nfrs:                      # optional; NUMBERS required for GREENFIELD-SYSTEM
  - "p95 API latency < 300ms at 50 rps"
  - "locales: en, de"
  - "accessibility: WCAG 2.2 AA"
out_of_scope: []           # optional
stack:
  language: typescript
  runtime: node
  hosting: vercel
integrations: [auth0, stripe]
compliance: []             # checklist placeholders only
risks:
  - known risk text
```

Backward compatibility: ALL additions (`intent_class`, `calibration`,
`non_goals`, `personas`, `nfrs`, `out_of_scope`, per-answer `feeds:` tags) are
OPTIONAL. Existing fields keep their names and semantics; `scope_class` is
retained verbatim because SKILL.md consumes it. Consumers that do not trace
provenance ignore `feeds:` tags in both forms (sibling key on structured
entries, trailing comment on plain scalars).

The orchestrator treats answers.yaml as authoritative user input and skips
the conversational rounds when it exists and parses cleanly.

## Completion test

Requirements are done when ALL hold:
- Every applicable question in the chosen intent class's question set answered
  (or explicitly waived by the user)
- All drafted inferences confirmed or corrected
- Zero unresolved conflicts
- Scope class agreed (SMALL/MEDIUM/LARGE) — this gates artifact generation
  (unchanged; SKILL.md consumes it)
- Chosen `intent_class` recorded in answers.yaml
- GREENFIELD-SYSTEM only: module-map agreement reached (user reacted to the
  strawman and the revision is confirmed) AND NFR numbers captured — an NFR
  without a number fails this gate
