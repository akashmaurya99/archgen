# Artifact templates — copy, fill, never invent structure

## architecture.yaml (LARGE scope)

```yaml
name: Acme Shop
slug: acme-shop            # becomes .archgen/acme-shop/
stack:
  language: typescript
  runtime: node20
  framework: nextjs
  database: postgres
structure:                 # planned folder tree — planned BEFORE code exists
  - path: src/features/<feature>/
    purpose: feature modules (api, internal, tests colocated)
  - path: src/shared/
    purpose: cross-feature utilities, no feature imports
  - path: src/config/
    purpose: env parsing + constants
modules:
  - name: catalog
    responsibility: product browsing + search
    owns: ["src/features/catalog/**"]
  - name: checkout
    responsibility: cart → payment orchestration
    owns: ["src/features/checkout/**"]
decisions:                 # ADR-lite; full ADRs live in decisions/
  - id: D1
    title: Postgres over MongoDB
    context: transactional orders + reporting queries
    decision: Postgres 16 with Prisma
    consequences: schema migrations required per release
```

## tasks.yaml (canonical shape)

```yaml
# comment lines are preserved by set-status.mjs — annotate freely
tasks:
  # Core pipeline — do first
  - id: C
    title: Scaffold project skeleton + config loading
    depends_on: []
    file_ownership: ["src/config/**", "package.json"]
    acceptance:
      - "npm run build exits 0"
      - "config loads from env with typed schema"
  - id: B
    title: Catalog API endpoints
    depends_on: [C]
    file_ownership: ["src/features/catalog/**"]
    acceptance:
      - "GET /products returns seeded list"
  - id: A
    title: Checkout flow wired to catalog
    depends_on: [B]
    parallel_group: wave-final
    file_ownership: ["src/features/checkout/**"]
    artifacts: ["docs/checkout-flow.md"]
    acceptance:
      - "e2e test completes purchase with stub payment"
```

Rules encoded above: depends_on = prerequisites; ownership globs disjoint
within a wave; acceptance = objectively checkable statements.

## SMALL-scope plan note (plans/<feature>.md)

```markdown
# <feature> — plan note (SMALL)
Intent: <one paragraph>
Tasks: see tasks.yaml entries <ids>
Risks: <bullets or none>
```

## ADR template (decisions/NNNN-title.md)

```markdown
# NNNN. <decision title>
Date: YYYY-MM-DD · Status: accepted
## Context
<forces at play>
## Decision
<what we chose>
## Consequences
<positive / negative / neutral>
```

## Mermaid snippets

C4 context:
```mermaid
graph TB
  user([Customer]) --> sys[Acme Shop]
  sys --> pay[Stripe]
  sys --> mail[Email Service]
```

Container:
```mermaid
graph LR
  web[Next.js App] --> api[API Routes]
  api --> db[(Postgres)]
  api --> cache[(Redis)]
```
