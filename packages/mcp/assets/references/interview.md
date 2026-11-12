# Interview playbook — evidence first, questions second

Goal: complete, conflict-free requirements in minimal round-trips. Infer from context, profile scope, ask only material decision-forks, and state derivative choices as veto-able defaults.

## How to ask

- **Tool-first, inline-fallback:** use the harness's interactive question/choice tool when available; otherwise present numbered inline options.
- **Recommendation-first:** lead with your recommendation tagged `(recommended)` + one-line rationale. Never present bare options.
- **Ask forks, state decisions:** ask only questions that materially branch the architecture. For derivative choices: *"I'll use X because Y — let me know if you prefer Z."*
- **Scale volume to scope:** round caps are ceilings, not targets. For SMALL work, ask 1–2 core forks and infer the rest.
- **Never re-ask** what the prompt, repo, profile, `codebase-map.md`, or a host document already answers.

*Example:*
> Rollout strategy?
> 1. Feature flag + staged rollout **(recommended)** — zero impact on active users
> 2. Immediate cutover — simpler, higher risk
> 3. Versioned API alongside — if legacy clients cannot upgrade
> Reply 1–3, or "ok" to accept recommended.

## Round 0 — scope calibration (not a questionnaire)

1. **Profile first:** run `archgen_plan{action:'profile', intent, signals, slug}` with the intent and the signals the prompt/repo evidence supports (`SKILL.md` Step 2). `intent` is required—one of `GREENFIELD-SYSTEM`, `GREENFIELD-MODULE`, `BROWNFIELD-FEATURE`, `BROWNFIELD-CHANGE`.
2. **State one sentence:** scope class, the evidence, the artifact create/reuse/omit list. Ask the user to confirm or correct it. `[wait for user]`
3. **Ask at most ONE question** when `confidence` is low — the profile's `question`. Do not run a calibration interview when `confidence` is high.
4. **Record** the confirmed profile in `answers.yaml` (`plan_profile:`) or the plan's `## Profile` section. Keep `escalateIf` so a later signal can move the class.

## Step 1 — classify intent & collect signals

Classify ONE `intent_class`, state it in one sentence, and record it. Scope is **computed by the profile**, never inherited from this table.

| `intent_class` | Signal | Elicitation strategy | Max rounds (incl. R0) |
|---|---|---|---|
| `GREENFIELD-SYSTEM` | Net-new system; no host repo | Full discovery, PRD-grade only if the profile creates a PRD | 6 |
| `GREENFIELD-MODULE` | Net-new module in an existing repo | Infer from host repo first; targeted forks | 3 |
| `BROWNFIELD-FEATURE` | Additive behavior in an existing repo | Survey first; ask only unresolved gaps | 3 |
| `BROWNFIELD-CHANGE` | Modify existing behavior in place | Survey first; diff current vs target behavior | 3 |

**The cap comes from the profile:** `archgen_plan{action:'profile'}` returns `interviewRoundCap` for the intent it classified. These round caps are ceilings, not targets — for SMALL work, ask 1–2 core forks and infer the rest.

**Escalation signals** (pass them to `profile`): `new-module`, `multi-module`, `public-contract`, `data-migration`, `security-sensitive`, `multi-service`, `external-integration`, `cross-team`, `regulated`, `irreversible`, `product-facing`, `production`. **De-escalation:** `prototype`. **Reuse:** `existing-prd`, `existing-architecture`, `existing-adr`.

**Default down:** missing evidence never raises the class. A low-confidence result asks one question, and an unanswered or ambiguous answer keeps the lower class. Never interrogate brownfield work with greenfield PRD questions.

## GREENFIELD-SYSTEM — professional discovery (≤6 rounds)

Tag answers with `feeds:` targets for downstream traceability.

### R1 — problem, users, success → PRD
1. Core problem, target audience, explicit non-goals? (`feeds: prd.problem|prd.non_goals`)
2. 1–3 primary personas: role, job-to-be-done, environment? (`feeds: prd.personas`)
3. Measurable success metrics—no adjectives? (`feeds: prd.metrics`)

### R2 — shape & modules → architecture.yaml `modules`
4. Confirm inferred stack + hosting target? (`feeds: prd.constraints`)
5. External integrations (auth, payments, messaging, APIs)? (`feeds: prd.integrations`)
6. **Strawman module map:** propose modules (`name — responsibility`); ask the user to add, merge, split, or rename. (`feeds: arch.modules`)

### R3 — data & API → contracts
7. Core entities, key fields, relationships? (`feeds: arch.data_contracts`)
8. Primary operations (5–10 `VERB + resource`)? (`feeds: arch.api_contracts`)

### R4 — NFRs with numbers → PRD
9. Performance budgets: p95 latency, peak throughput? (`feeds: prd.nfrs`)
10. Scale targets: users, requests/day, annual data volume? (`feeds: prd.nfrs`)
11. Security/compliance, i18n locales, accessibility target? (`feeds: prd.nfrs`)

### R5 — environment & naming → contracts
12. Environments, secret management, deploy cadence? (`feeds: arch.environment_matrix`)
13. Existing naming, glossary, brand casing (`none` is valid)? (`feeds: arch.naming_conventions`)

### R6 — close-out → PRD
14. Explicit out-of-scope items? (`feeds: prd.out_of_scope`)
15. Top 2 technical or product risks? (`feeds: prd.risks`)

Present the finalized module map + numeric NFRs for confirmation. `[wait for user]`

### Traceability — `feeds:` tags

`feeds:` targets are the `prd.*` keys (`problem`, `goals`, `non_goals`, `personas`, `metrics`, `nfrs`, `constraints`, `integrations`, `risks`, `out_of_scope`) and the `arch.*` keys (`modules`, `data_contracts`, `api_contracts`, `environment_matrix`, `naming_conventions`). Join multiple with `|`.

## GREENFIELD-MODULE — net-new inside an existing system (≤3 rounds)

Infer from the host repo first, then confirm only:
1. Host touchpoints: which modules it imports from or exposes interfaces to? (`feeds: arch.modules`)
2. Data/API delta: new entities, events, endpoints? (`feeds: arch.data_contracts|arch.api_contracts`)
3. NFRs: inherit host baselines or define custom targets? (`feeds: prd.nfrs`)
4. Confirm adherence to host `naming_conventions`? (`feeds: arch.naming_conventions`)

## BROWNFIELD classes — survey BEFORE questioning (mandatory)

Produce `.archgen/<slug>/codebase-map.md` first (`SKILL.md` BROWNFIELD steps 1–2, including `## Existing docs` and `## Toolchain`). Never ask what the code answers—cite the path and confirm.

### BROWNFIELD-FEATURE (additive; max ~5 questions, one batched message)
1. Target acceptance behavior and critical edge cases not evident from code?
2. Backward-compatibility requirements for existing data/clients?
3. Rollout mechanism (feature flag, staged, immediate)?
4. Protected paths outside `codebase-map.md`?
5. Corrections to `codebase-map.md`?

### BROWNFIELD-CHANGE (behavior modification; ≤3 rounds)
1. Exact behavioral diff: current vs desired, plus invariants that must remain?
2. Migration path: in-place, parallel versioned endpoint, or breaking cutover?
3. Verification proving legacy behavior is removed and new behavior holds?

## Conflict detection

Surface contradictions (scale vs budget, feature vs constraint, requirement vs `codebase-map.md`) one at a time:
*"I see a tension between X and Y. Which takes precedence?"* `[wait for user]`

## Token discipline

- Batch 3–5 questions per turn; never ping-pong single questions.
- Respect round ceilings (`GREENFIELD-SYSTEM` ≤6; all others ≤3 including R0).
- Re-profile instead of re-interviewing when a delta changes signals.

## Answers-file format (machine-readable, enables non-interactive runs)

When `.archgen/<slug>/answers.yaml` is present and valid, treat it as authoritative and skip conversational rounds.

**The skeleton is GENERATED, not written here.** `archgen_plan{action:'scaffold', scope, intent, signals, modules, tasks, slug}` serves it (`scope` is required; passing the profile's `intent` makes the scaffold serve exactly the profile's create set), so the field list you get is the one the floor reads. Copy it from that answer — a hand-written copy is a second source that can disagree with the one the floor parses.

What each field is FOR:

- `scope_class` — SMALL | MEDIUM | LARGE, from the profile.
- `intent_class` — the intent the profile classified.
- `calibration` — `scale` (prototype | mvp | production), `teamConstraints`, `pressure` (low | medium | high).
- `plan_profile` — **REQUIRED for MEDIUM/LARGE**; the floor reads it. It carries `confidence`, `signals`, `artifacts[]` (one entry per artifact family: `path`, `decision`, `reason`, and `host_path` for a reuse), `escalate_if`, and the `gate` block — the canonical block, in `§artifact-templates/gate-metrics`.
- `problem`, `success_criteria[]`, `constraints[]`, `stack`, `integrations[]`, `compliance[]`, `risks[]` — the elicited answers; `non_goals[]`, `personas[]`, `nfrs[]` and `out_of_scope[]` are optional.

`plan_profile` is **required for MEDIUM and LARGE** — the floor checks every artifact decision against the files on disk, and without it there is nothing to check (it warns `PROFILE_NOT_RECORDED`). For SMALL, put the same block in the plan's `## Profile` fence instead. Every other field beyond `scope_class`, `problem`, `success_criteria`, `constraints`, `stack`, `integrations`, `compliance` and `risks` is optional and backward-compatible. `feeds:` tags may be object keys or trailing `# feeds:` comments.

## Completion test

Elicitation is complete only when ALL hold:
- Applicable intent questions are answered or explicitly waived.
- Inferred decisions are confirmed or corrected by the user.
- Zero unresolved conflicts remain.
- The profile's `scopeClass`, artifact decisions, and `intent_class` are agreed and recorded.
- For `GREENFIELD-SYSTEM` with a created PRD: the module map is agreed and every NFR has a numeric target.
