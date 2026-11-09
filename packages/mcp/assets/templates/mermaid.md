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

Rules: One flowchart per `modules:` entry in `architecture.yaml` showing internal components (≤6 nodes) + inbound `depends_on_modules` edges (consumer → provider), plus ONE integration diagram wiring modules as atomic nodes. **Hard limit:** ≤15 nodes per diagram.

Catalog module (internals + inbound `depends_on` edge):
```mermaid
graph LR
  subgraph catalog
    routes[api routes] --> svc[search service]
    svc --> repo[(product repository)]
  end
  checkout -.->|depends_on CatalogApi| routes
```

Integration (module-level DAG mirroring `depends_on_modules`):
```mermaid
graph LR
  accounts --> catalog
  cart --> catalog
  checkout --> cart
  checkout --> accounts
```
