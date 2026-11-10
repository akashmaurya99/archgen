## Mermaid snippets

System context (only when the profile creates diagrams):
```mermaid
graph TB
  actor([<actor>]) --> system[<system>]
  system --> external[<external service>]
```

Container view:
```mermaid
graph LR
  client[<client>] --> service[<service>]
  service --> store[(<data store>)]
  service --> queue[(<queue or cache>)]
```

Per-module diagram (one per `modules:` entry in `architecture.yaml`):
```mermaid
graph LR
  subgraph <module>
    entry[<entry point>] --> core[<core component>]
    core --> store[(<store>)]
  end
  <consumer> -.->|depends_on <InterfaceName>| entry
```

Integration (module-level DAG mirroring `depends_on_modules`):
```mermaid
graph LR
  <module-a> --> <module-b>
  <module-c> --> <module-a>
```
