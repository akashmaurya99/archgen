# 0001. Postgres over MongoDB
Date: 2026-08-25 · Status: accepted
## Context
Transactional records plus reporting queries need joins and constraints that
document stores express poorly.
## Decision
Postgres 16 accessed through Prisma.
## Consequences
Schema migrations ship with every release; reporting queries stay simple.
