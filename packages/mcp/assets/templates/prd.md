# PRD — <project name>

## Problem statement & goals
- <quantified user/system pain>
- Goals: <3–5 measurable outcome bullets>

## Non-goals
- <explicit exclusions to prevent scope creep>

## Personas / stakeholders
- <persona>: <core job-to-be-done> -> <measurable success state>

## Functional requirements — <module-name> (repeat per module)
- FR-<MODULE>-01: <single objectively verifiable behavior>
- FR-<MODULE>-02: <single objectively verifiable behavior>
<!-- FR IDs are immutable once cited in tasks.yaml -->

## Non-functional requirements (concrete numbers mandatory; no adjectives)
- Perf: p95 API latency < 300 ms at 50 rps; LCP < 2.5 s
- Security: authz enforced on all routes; zero secrets in repo; OWASP Top 10 mitigated
- i18n: externalized copy; ICU pluralization; RTL-safe layout
- A11y: WCAG 2.2 AA compliance; full keyboard navigation; contrast >= 4.5:1

## Success metrics
- <metric>: <baseline> -> <target> within <evaluation window>

## Risks & mitigations
- <risk> -> <mitigation>, owned by <task ID or ADR ref>

## Open questions
- <question> — owner: <name/role>, blocks: <task ID | none>
