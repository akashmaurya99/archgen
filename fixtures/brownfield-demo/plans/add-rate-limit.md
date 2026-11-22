# add rate-limit feature — plan note (SMALL)

Intent: protect public routes from abuse with a token-bucket limiter owned by
the http server module.

Tasks:

- RL1 — token-bucket core inside src/server.ts
- RL2 — per-route budgets applied in src/routes.ts
- RL3 — structured limit events via src/shared/logger.ts

Risks: burst traffic right after startup; the health endpoint must stay
exempt so probes never see 429s.

Right-sizing: SMALL — plan plus tasks with survey evidence embedded below. No
architecture rewrite, diagrams, or ADRs: existing structure is unchanged.

## Survey

- Structure/modules: `project/src/server.ts` owns HTTP lifecycle; `project/src/routes.ts` dispatches requests; `project/src/shared/logger.ts` owns structured logs.
- Conventions: named exports and dispatch-boundary errors observed under `project/src`; no test layout is present.
- Existing docs: no host PRD, architecture document, or ADR exists under `project/src`.
- Toolchain: TypeScript source on Node with source root `project/src`; no package manifest or build command is present in this fixture.
- Affected: limiter core in `project/src/server.ts`, route budgets in `project/src/routes.ts`, events in `project/src/shared/logger.ts`.

## Profile

```yaml
scope_class: SMALL
intent_class: BROWNFIELD-FEATURE
signals: []
artifacts:
  - path: .archgen/demo-brownfield/codebase-map.md
    decision: omit
    reason: localized change — survey evidence is embedded in this plan's Survey section
  - path: .archgen/demo-brownfield/plans/add-rate-limit.md
    decision: create
    reason: SMALL implementation narrative
  - path: .archgen/demo-brownfield/tasks.yaml
    decision: create
    reason: executable task contract
escalate_if: [multi-module, public-contract, data-migration]
```
