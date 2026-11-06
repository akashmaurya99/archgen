# PRD — <project name>

## Problem statement & goals
- <pain, quantified where possible>
- Goals: <3–5 outcome bullets, each measurable>

## Non-goals
- <explicitly out; prevents scope creep mid-execution>

## Personas / stakeholders
- <persona>: <need>, <success looks like>

## Functional requirements — <module-name>   (repeat per module)
- FR-<MODULE>-01: <single verifiable behavior statement>
- FR-<MODULE>-02: ...
<!-- ids are immutable once tasks reference them -->

## Non-functional requirements (measurable targets, no adjectives)
- Perf: p95 API latency < 300 ms at 50 rps; LCP < 2.5 s
- Security: authz check on every endpoint; no secrets in repo; OWASP top-10 reviewed
- i18n: all user-facing strings externalized; ICU plurals; RTL-safe layouts
- A11y: WCAG 2.1 AA; full keyboard nav; contrast ≥ 4.5:1

## Success metrics
- <metric>: <baseline> → <target> within <window>

## Risks & mitigations
- <risk> → <mitigation>, <owner task id or ADR ref>

## Open questions
- <question> — owner <name/role>, blocks <task id | none>
