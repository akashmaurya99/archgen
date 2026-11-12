# Architecture Conventions

Normative shape of `.archgen/<slug>/architecture.yaml` — the architecture contract archgen writes into a project before any task graph is planned.

The shape is **generated**, not remembered: `archgen_plan{action:'scaffold'}` serves the skeleton from `packages/mcp/assets/templates/architecture.yaml`, and the deterministic floor (`archgen_plan{action:'verify'}`) proves the rules named under **Validation rules** below. This document explains that shape; it is not a second source of it.

## File location

`<project-root>/.archgen/<slug>/architecture.yaml`

`<slug>` is derived from the architecture's `slug` key (see below) and **becomes the dot-folder name**: a project with `slug: acme-shop` stores all artifacts under `.archgen/acme-shop/`. The slug must be lowercase-hyphen (`^[a-z0-9]+(-[a-z0-9]+)*$`) — it is a path segment, so it can never carry a slash, a dot-dot or a space.

## Top-level keys

| Key | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Human-readable project name. |
| `slug` | lowercase-hyphen string | yes | URL/filesystem-safe id. Names the `.archgen/<slug>/` dot-folder. Immutable after first generation. |
| `toolchain` | map | yes | The host ecosystem: `language`, `runtime`, `package_manager`, `build`, `test`, `lint`, `typecheck`, and the two roots below. |
| `existing_docs[]` | sequence of maps | no | Host sources of truth — `{path, kind, status}` — so a task cites them instead of regenerating them. |
| `structure[]` | sequence of maps | yes | Every planned directory, as `{path, purpose}`. The canonical statement of "what folders exist" — every path must be owned by a task. |
| `naming_conventions` | map | no | `file_naming`, `dir_layout`, `symbol_casing`, `test_placement`. Every task step and ownership glob cites these. |
| `modules[]` | sequence of maps | yes | One entry per cohesive module. Each has `name`, `responsibility`, `owns[]` globs, `depends_on_modules[]` and `key_interfaces[]`. |
| `data_contracts` | map | no | One block per entity: `storage` and `fields[]`. |
| `api_contracts` | map | no | One block per module: `endpoint`, `auth`, `request_payload`, `success`, `error_shape`. |
| `environment_matrix[]` | sequence of maps | no | `{var, dev, ci, prod, required}` — an unparsed var fails fast at the config boundary. |
| `decisions[]` | sequence of maps | no | ADR-lite index. Each has `id`, `title`, `context`, `decision`, `consequences`. |

`stack` is **not** a key of `architecture.yaml` — the stack (language, runtime, hosting) is elicited into `answers.yaml`, and the host ecosystem belongs in `toolchain`.

The file opens with the provenance header the scaffold serves (`# schema_version: 1`, `# generator: archgen vX.Y.Z`, `# generated_at: …`). Paste it verbatim; never type a version by hand.

### `toolchain` — the two roots

`source_root` and `test_root` are the roots the floor mirrors between: a task that owns source under `source_root` also owns the mirrored path under `test_root`. `test_root` is the root of the tree that **mirrors** the source tree (`tests/unit` in the common layout) — the floor never guesses a prefix or a level. Without both roots the mirrored-tree rule cannot run, and the floor says so (`CONFIG_NOT_ENFORCED`) rather than quietly passing.

### `structure[]` entry

| Field | Type | Description |
| --- | --- | --- |
| `path` | path | The planned directory, repo-root-relative. A path that still holds a `<…>` placeholder is skipped until it is filled in. |
| `purpose` | string | One line: what lives there. |

A folder tree is expressed as **paths**, never as an indented ASCII tree: archgen's YAML subset refuses block scalars (`|`, `>`), so a tree block is not expressible — and the floor reads `structure[].path`, one entry per directory.

### `modules[]` entry

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Module identifier. The module filter of `archgen_plan{action:'graph'}` matches this name against the ownership globs. |
| `responsibility` | string | Single sentence: exactly one concern this module answers. |
| `owns[]` | glob paths | Paths this module exclusively owns. Ownership here is mirrored one-to-one into task-level `file_ownership` in `tasks.yaml`; overlapping `owns[]` between two modules is a validation error. |
| `depends_on_modules[]` | strings | The module DAG. It drives the task `depends_on` edges — the reviewer compares the two graphs. |
| `key_interfaces[]` | strings | ONLY the exports other modules may consume. |

### `decisions[]` entry (ADR-lite)

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Stable reference, e.g. `D1`. A `D<number>` id resolves to `decisions/<number>-<title>.md`, zero-padded to four digits; any other id falls back to the title slug. |
| `title` | string | Imperative summary ("Use Postgres over MongoDB"). |
| `context` | string | Forces at play when the decision was made. |
| `decision` | string | What was decided, stated affirmatively. |
| `consequences` | sequence of strings | Positive and negative outcomes accepted as a result. |

The full record lives in `decisions/NNNN-title.md`; `decisions[]` is the index that points at it.

## Relationship to the task contract

`tasks.yaml` (see `packages/mcp/schemas/tasks.schema.json`) consumes this document:

- The floor proves that every `structure[].path` and every `modules[].owns[]` glob has a task that owns it.
- The reviewer judges that each task's `depends_on` ordering respects the module DAG, and that a task's `file_ownership` sits inside some module's `owns[]` (or is explicitly marked infra/tooling). No tool can prove those two — they are judgement.
- The `status` enum is exactly `pending | ready | running | blocked | done | failed` — no `cancelled`. The validator enforces it.

## Filled example — e-commerce

```yaml
name: Acme Shop
slug: acme-shop
toolchain:
  language: typescript
  runtime: node 22
  package_manager: npm
  build: npm run build
  test: npm test
  lint: npm run lint
  typecheck: npx tsc --noEmit
  source_root: src
  test_root: tests/unit
existing_docs:
  - { path: docs/product-requirements.md, kind: prd, status: current }
structure:
  - path: src/features/catalog/
    purpose: browsing, searching and rendering products
  - path: tests/unit/features/catalog/
    purpose: unit tests mirroring the catalog source tree
  - path: src/features/cart/
    purpose: session basket state and price totals
  - path: tests/unit/features/cart/
    purpose: unit tests mirroring the cart source tree
naming_conventions:
  file_naming: kebab-case
  dir_layout: src/features/<module>/...; shared code under src/shared; tests mirror the source path under tests/unit/
  symbol_casing: camelCase
  test_placement: the test tree is a SIBLING of the source tree; tests/unit/<path under the source root>/
modules:
  - name: catalog
    responsibility: Browsing, searching, and rendering products and categories.
    owns:
      - src/features/catalog/**
      - tests/unit/features/catalog/**
    depends_on_modules: []
    key_interfaces:
      - CatalogApi (src/features/catalog/index.ts)
  - name: cart
    responsibility: Session-scoped basket state, quantity rules, price totals.
    owns:
      - src/features/cart/**
      - tests/unit/features/cart/**
    depends_on_modules:
      - catalog
    key_interfaces:
      - CartStore (src/features/cart/store.ts)
decisions:
  - id: D1
    title: Use Postgres over MongoDB
    context: Transactional orders plus reporting queries.
    decision: Postgres 16 with Prisma.
    consequences:
      - Schema migrations required per release.
      - Relational integrity enforced at the database level.
```

## Validation rules

The deterministic floor proves these; anything it cannot prove is reported as **NOT ENFORCED**, never silently skipped.

1. `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and names the existing `.archgen/` dot-folder.
2. Every `structure[].path` and every `modules[].owns[]` glob is owned by a task — a declared path with no owner is `PATH_UNOWNED`.
3. Every `decisions[].id` has a matching `decisions/` file — a declared decision with no file is `DECISION_MISSING`.
4. `toolchain.source_root` and `toolchain.test_root` are both declared, so the mirrored-test-tree rule can run — without them the floor reports `CONFIG_NOT_ENFORCED` and the layout becomes the reviewer's judgement.
5. A path or glob that still holds a `<…>` placeholder is skipped until it is filled in.
6. `structure` is a sequence of `{path, purpose}` entries — the YAML subset refuses block scalars, so an indented folder tree is not a legal shape.
