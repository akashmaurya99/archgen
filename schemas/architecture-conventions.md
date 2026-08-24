# Architecture Conventions

Normative shape of `.archgen/<slug>/architecture.yaml` — the architecture contract archgen writes into a project before any task graph is planned. Every generator, validator, and verifier in `skills/archgen/scripts/` treats this document as the source of truth.

## File location

`<project-root>/.archgen/<slug>/architecture.yaml`

`<slug>` is derived from the architecture's `slug` key (see below) and **becomes the dot-folder name**: a project with `slug: acme-shop` stores all artifacts under `.archgen/acme-shop/`. The slug must be lowercase-hyphen (`^[a-z0-9]+(-[a-z0-9]+)*$`).

## Top-level keys

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Human-readable project name. |
| `slug` | lowercase-hyphen string | yes | URL/filesystem-safe id. Names the `.archgen/<slug>/` dot-folder. Immutable after first generation. |
| `stack` | sequence of strings | yes | Languages, frameworks, runtimes, and key infrastructure, e.g. `typescript`, `nextjs@15`, `postgres`. |
| `structure` | folder-tree block | yes | An indented ASCII folder tree listing every planned top-level directory. This is the canonical statement of "what folders exist" — modules' ownership globs must resolve against it. |
| `modules[]` | sequence of maps | yes | One entry per cohesive module. Each has `name`, `responsibility`, and `owns[]` globs. |
| `decisions[]` | sequence of maps | yes | ADR-lite records. Each has `id`, `title`, `context`, `decision`, `consequences`. |

### `modules[]` entry

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Module identifier, matches its folder name under the structure tree where applicable. |
| `responsibility` | string | Single sentence: exactly one concern this module answers. |
| `owns[]` | glob paths | Paths this module exclusively owns. Ownership here is mirrored one-to-one into task-level `file_ownership` in `tasks.yaml`; overlapping `owns[]` between two modules is a validation error. |

### `decisions[]` entry (ADR-lite)

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Stable reference, e.g. `ADR-001`. |
| `title` | string | Imperative summary ("Use Postgres over MongoDB"). |
| `context` | string | Forces at play when the decision was made. |
| `decision` | string | What was decided, stated affirmatively. |
| `consequences` | sequence of strings | Positive and negative outcomes accepted as a result. |

## Relationship to the task contract

`tasks.yaml` (see `schemas/tasks.schema.json`) consumes this document:

- Every task's `depends_on` ordering must respect module boundaries implied by `owns[]`.
- Task `file_ownership` globs must be subsets of some module's `owns[]` (or explicitly marked infra/tooling).
- `status` enum is exactly `pending | ready | running | blocked | done | failed` — no `cancelled`.

## Filled example — e-commerce

```yaml
name: Acme Shop
slug: acme-shop
stack:
  - typescript
  - nextjs
  - postgres
  - redis
structure: |
  .
  ├── src/
  │   ├── app/
  │   ├── features/
  │   │   ├── catalog/
  │   │   ├── cart/
  │   │   ├── checkout/
  │   │   └── accounts/
  │   └── shared/
  ├── migrations/
  ├── config/
  └── tests/
modules:
  - name: catalog
    responsibility: Browsing, searching, and rendering products and categories.
    owns:
      - src/features/catalog/**
      - migrations/catalog/**
  - name: cart
    responsibility: Session-scoped basket state, quantity rules, price totals.
    owns:
      - src/features/cart/**
      - src/shared/pricing/**
  - name: checkout
    responsibility: Order placement, payment hand-off, confirmation flows.
    owns:
      - src/features/checkout/**
  - name: accounts
    responsibility: Identity, sessions, addresses, order history.
    owns:
      - src/features/accounts/**
decisions:
  - id: ADR-001
    title: Use Next.js App Router server components by default
    context: Storefront is content-heavy and SEO-critical; client bundles were bloating LCP on the previous SPA.
    decision: Render catalog and checkout pages as server components; opt into client components only for interactive islands.
    consequences:
      - Faster first paint and better crawlability.
      - Stateful widgets need explicit client-component boundaries.
  - id: ADR-002
    title: Redis-backed cart sessions instead of cookie carts
    context: Carts exceed cookie size limits during promotions and must survive device switches for logged-in users.
    decision: Persist carts server-side in Redis keyed by session id; cookies carry only the session reference.
    consequences:
      - No payload-size ceiling on cart contents.
      - Redis becomes availability-critical for cart writes.
```

## Validation rules

1. `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and names the existing `.archgen/` dot-folder.
2. Every `module.name` appears in the `structure` tree.
3. `owns[]` globs across modules are pairwise disjoint.
4. At least one `decision` exists per non-trivial scope class.
