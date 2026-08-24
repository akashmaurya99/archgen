# add rate-limit feature — plan note (MEDIUM)

Survey input: codebase-map.md. Intent: protect public routes from abuse with a
token-bucket limiter owned by the http server module.

Tasks:

- RL1 — token-bucket core inside src/server.ts
- RL2 — per-route budgets applied in src/routes.ts
- RL3 — structured limit events via src/shared/logger.ts

Risks: burst traffic right after startup; the health endpoint must stay
exempt so probes never see 429s.

Right-sizing: MEDIUM — plan plus tasks only. No architecture rewrite, no new
diagrams, no ADRs: existing structure is unchanged by this feature.
