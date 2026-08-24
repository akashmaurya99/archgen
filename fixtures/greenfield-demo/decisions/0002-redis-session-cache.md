# 0002. Redis for session-scoped caches
Date: 2026-08-25 · Status: accepted
## Context
The admin console polls list endpoints that recompute the same aggregates per
request under load.
## Decision
Cache aggregate reads in Redis with short TTLs keyed by route plus query.
## Consequences
Redis becomes availability-relevant for read paths; cache invalidation is
explicit on writes.
