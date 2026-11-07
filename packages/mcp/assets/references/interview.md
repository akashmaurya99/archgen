# Interview playbook — requirement elicitation

Goal: achieve complete, conflict-free requirements in minimal round-trips. Batch 3–5 questions per turn, infer aggressively from context, ask only material decision-forks, and state derivative choices as veto-able defaults.

## How to ask

- **Tool-first, inline-fallback:** Use the harness's interactive question/choice tool if available; otherwise present numbered inline options.
- **Recommendation-first:** Lead every question with your recommended option tagged `(recommended)` + brief rationale. Never present bare options.
- **Ask forks, state decisions:** Ask ONLY questions that materially branch the architecture. For derivative choices, declare: *"I'll use X because Y — let me know if you prefer Z."*
- **Scale volume to scope:** Round caps are ceilings, not targets. For simple/SMALL prompts, ask 1–2 core forks and infer the rest.

*Example:*
> Rollout strategy?
> 1. Feature flag + staged rollout **(recommended)** — zero impact on active users
> 2. Immediate cutover — simpler, higher risk
> 3. Versioned API alongside — if legacy clients cannot upgrade
> Reply 1–3, or "ok" to accept recommended.

## Round 0 — calibration exchange (skippable)

Infer from the prompt and repo first; ask only if genuinely ambiguous (skip entirely for SMALL/simple prompts or when already stated):
1. **Target scale:** Prototype, MVP, or production-bound? (State inference + 1-line rationale for confirmation).
2. **Team & tooling constraints:** Solo vs team, existing CI/lint/style conventions?
3. **Timeline pressure:** None, moderate, or crunch?

Record under `calibration:` in `answers.yaml`.

## Step 1 — classify intent (decide during round 1)

Classify into ONE `intent_class`, state it in one sentence, and record in `answers.yaml`:

| `intent_class` | Signal | Elicitation Strategy | Max Rounds (incl. R0) | Default `scope_class` |
|---|---|---|---|---|
| `GREENFIELD-SYSTEM` | Net-new system; no host repo | Full PRD-grade discovery | $\le 6$ | `LARGE` |
| `GREENFIELD-MODULE` | Net-new module in existing repo | Infer from host repo first; targeted forks | $\le 3$ | `MEDIUM` |
| `BROWNFIELD-FEATURE` | Additive behavior in existing repo | Survey first; ask only unresolved gaps ($\le 5$ Qs) | $\le 3$ | `MEDIUM` / `SMALL` |
| `BROWNFIELD-CHANGE` | Modify existing behavior in place | Survey first; diff current vs target behavior | $\le 3$ | `SMALL` |

Infer `scope_class` (`SMALL`/`MEDIUM`/`LARGE`), state with 1-line reasoning, and let the user confirm or override. Never interrogate brownfield tasks with greenfield PRD questions.

## GREENFIELD-SYSTEM — professional discovery (≤6 rounds)

Tag recorded answers with `feeds:` targets for downstream traceability.

### R1 — problem, users, success → PRD
1. Core problem, target audience, and explicit non-goals? (`feeds: prd.problem|prd.non_goals`)
2. 1–3 primary personas: role, job-to-be-done, operating environment? (`feeds: prd.personas`)
3. Measurable success metrics (activation, latency, error rate—no adjectives)? (`feeds: prd.metrics`)

### R2 — shape & module decomposition → architecture.yaml `modules`
4. Confirm inferred tech stack + hosting target? (`feeds: prd.constraints`)
5. External integrations (auth, payments, messaging, 3rd-party APIs)? (`feeds: prd.integrations`)
6. **Strawman module map:** Propose candidate modules (`name — responsibility`) and ask user to add, merge, split, or rename until agreed. (`feeds: arch.modules`)

### R3 — data & API sketches → `data_contracts`, `api_contracts`
7. Core entities, key fields, and relationships (`belongs-to`/`has-many`)? (`feeds: arch.data_contracts`)
8. Primary API operations (5–10 core `VERB + resource` endpoints/actions)? (`feeds: arch.api_contracts`)

### R4 — NFRs with numbers → PRD
9. Performance budgets: p95 latency, peak RPS/throughput? (`feeds: prd.nfrs`)
10. Scale targets: active users, requests/day, annual data volume? (`feeds: prd.nfrs`)
11. Security/compliance (GDPR/HIPAA/PCI), i18n locales, accessibility target (e.g., WCAG 2.2 AA)? (`feeds: prd.nfrs`)

### R5 — environment & naming → `environment_matrix`, `naming_conventions`
12. Environments (dev/staging/prod), secret management, deploy cadence? (`feeds: arch.environment_matrix`)
13. Existing naming, domain glossary, or brand casing rules (`none` is valid)? (`feeds: arch.naming_conventions`)

### R6 — close-out → PRD
14. Explicit out-of-scope items excluded from this build? (`feeds: prd.out_of_scope`)
15. Top 2 known technical or product risks? (`feeds: prd.risks`)

Present the finalized module map + numeric NFRs for confirmation. `[wait for user]`

### Traceability — `feeds:` tags

Valid literal `feeds:` targets (join multiple with `|`, e.g., `feeds: prd.goals|arch.modules`):
- **PRD:** `prd.problem`, `prd.goals`, `prd.non_goals`, `prd.personas`, `prd.metrics`, `prd.nfrs`, `prd.constraints`, `prd.integrations`, `prd.risks`, `prd.out_of_scope`
- **Architecture:** `arch.modules`, `arch.data_contracts`, `arch.api_contracts`, `arch.environment_matrix`, `arch.naming_conventions`

## GREENFIELD-MODULE — net-new inside an existing system (≤3 rounds)

Infer from the host repo first, then confirm:
1. Host touchpoints: which existing modules does it import from or expose interfaces to? (`feeds: arch.modules`)
2. Data & API delta: new entities, events, or endpoints vs existing ones? (`feeds: arch.data_contracts|arch.api_contracts`)
3. NFRs: inherit host perf/a11y/i18n baselines or define custom targets? (`feeds: prd.nfrs`)
4. Confirm adherence to host `naming_conventions`? (`feeds: arch.naming_conventions`)

## BROWNFIELD classes — survey BEFORE questioning (mandatory)

Execute the codebase survey (`SKILL.md` BROWNFIELD steps 1–2) to produce `.archgen/<slug>/codebase-map.md` BEFORE asking questions. Never ask what the code already answers—cite the file path and confirm.

### BROWNFIELD-FEATURE (additive; max ~5 questions, 1 batched message)
1. Target acceptance behavior and critical edge cases not evident from code?
2. Backward-compatibility requirements for existing data/clients?
3. Rollout mechanism (feature flag, staged, immediate)?
4. Protected paths outside `codebase-map.md` that must not be modified?
5. Any corrections to `codebase-map.md`?

### BROWNFIELD-CHANGE (behavior modification; ≤3 rounds)
1. Exact behavioral diff: current vs desired behavior, plus invariants that must remain unchanged?
2. Migration path: in-place update, parallel versioned endpoint, or breaking cutover?
3. Verification criteria proving legacy behavior is removed and new behavior holds?

## Conflict detection

Immediately surface contradictions (scale vs budget, feature vs technical constraint, requirement vs `codebase-map.md`) one at a time:
*"I see a tension between X and Y. Which takes precedence?"* `[wait for user]`

## Token discipline

- Batch 3–5 questions per turn; never ping-pong single questions.
- Respect round ceilings (`GREENFIELD-SYSTEM` $\le 6$, all others $\le 3$ including R0).
- Never re-ask facts provided in the prompt, calibration, or `codebase-map.md`.

## Answers-file format (machine-readable, enables non-interactive runs)

When `.archgen/<slug>/answers.yaml` is present and valid, treat it as authoritative input and skip conversational rounds. Generate its skeleton via `archgen_plan{action:'scaffold'}`:

```yaml
scope_class: MEDIUM              # SMALL | MEDIUM | LARGE (REQUIRED by SKILL.md)
intent_class: GREENFIELD-SYSTEM  # optional: GREENFIELD-SYSTEM | GREENFIELD-MODULE | BROWNFIELD-FEATURE | BROWNFIELD-CHANGE
calibration:                     # optional
  scale: production              # prototype | mvp | production
  teamConstraints: solo dev, repo lint rules apply
  pressure: medium               # low | medium | high
problem: one-line problem statement
success_criteria:
  - text: measurable outcome
    feeds: prd.metrics
constraints:
  - must-not-change item # feeds: prd.constraints
non_goals:                       # optional (GREENFIELD-SYSTEM)
  - multi-tenant accounts
personas:                        # optional (GREENFIELD-SYSTEM)
  - role: shopper
    goal: find and buy in under two minutes
nfrs:                            # optional; numeric values required for GREENFIELD-SYSTEM
  - "p95 API latency < 300ms at 50 rps"
  - "locales: en, de"
  - "accessibility: WCAG 2.2 AA"
out_of_scope: []                 # optional
stack:
  language: typescript
  runtime: node
  hosting: vercel
integrations: [auth0, stripe]
compliance: []
risks:
  - known risk text
```

All fields added beyond `scope_class`, `problem`, `success_criteria`, `constraints`, `stack`, `integrations`, `compliance`, and `risks` are optional and backward-compatible. `feeds:` tags may appear as object keys or trailing `# feeds:` comments.

## Completion test

Elicitation is complete only when ALL hold:
- All applicable intent-class questions are answered or explicitly waived.
- Inferred decisions are confirmed or corrected by the user.
- Zero unresolved conflicts remain.
- `scope_class` (`SMALL`/`MEDIUM`/`LARGE`) and `intent_class` are agreed and recorded in `answers.yaml`.
- For `GREENFIELD-SYSTEM`: strawman module map is agreed AND every NFR contains a concrete numeric target.
