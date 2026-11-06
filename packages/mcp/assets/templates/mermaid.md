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

## Per-module diagram (LARGE)

For EACH `modules:` entry in architecture.yaml, one small flowchart of its
internal components plus its `depends_on_modules` edges (arrow points from
consumer to provider). Plus ONE integration diagram wiring all modules —
edges between modules only, no internals. HARD LIMIT: ≤15 nodes per diagram;
split into two diagrams rather than cramming. Internals stay ≤6 nodes per
module.

Catalog module (internal + inbound depends_on edge):

```mermaid
graph LR
  subgraph catalog
    routes[api routes] --> svc[search service]
    svc --> repo[(product repository)]
  end
  checkout -.->|depends_on CatalogApi| routes
```

Integration (modules as atoms, mirrors depends_on_modules):

```mermaid
graph LR
  accounts --> catalog
  cart --> catalog
  checkout --> cart
  checkout --> accounts
```
