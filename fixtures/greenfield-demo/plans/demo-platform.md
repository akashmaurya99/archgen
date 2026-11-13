# Demo Platform — generation plan (LARGE)

Intent: stand up a two-feature service (notes API plus admin web console)
with a shared kernel, a docs track, and an end-to-end verification gate.

Wave plan (resolved by archgen_tasks{action:'next'}):

1. SCAFFOLD — project skeleton plus typed config loading
2. SHARED and DOCS — shared kernel helpers; user guide and decision records
3. API and WEB — feature modules in parallel under disjoint file_ownership
4. VERIFY — cross-feature smoke suite over both features

Risks: config drift between features, mitigated by the typed config owned by
SCAFFOLD; shared-kernel scope creep, mitigated by the no-feature-imports rule.

Every task id above carries objective acceptance criteria in tasks.yaml, and
every task has a section of its own below — one heading per task, in
dependency order.

## SCAFFOLD — Scaffold project skeleton and typed config loading

Approach: create the package manifest, the TypeScript build, and the config
module that parses the environment into a typed schema. Everything else reads
its configuration through this one module.

Edge cases: an unset required variable fails at the config boundary and never
at first use; a malformed value is reported with the variable name and the
expected type; the defaults apply only to variables declared optional.

Out of scope: the feature modules, the database schema, and any runtime
framework wiring beyond the config loader.

## SHARED — Implement shared logging and error envelope helpers

Approach: one structured logger and one error-envelope helper in the shared
kernel. No feature module may import from another feature module — only from
this kernel.

Edge cases: a log line with a missing field is emitted with an explicit null
rather than the key being dropped; the error envelope covers every handler
path, including the ones that fail before a handler is chosen; a failure while
logging does not mask the original error.

Out of scope: transport-level retries and any feature-specific logging.

## API — Notes REST API with validation

Approach: the notes resource — list and create — over the seeded store, with
the request body validated against the schema before it reaches the handler.

Edge cases: an empty body is rejected with a 400 and a structured error shape;
an unknown field is ignored rather than stored; a concurrent create of the
same title produces two records with distinct ids, never one.

Out of scope: authentication, pagination beyond the first page, and the admin
console.

## WEB — Admin console pages wired to the API client

Approach: the console reads the notes list from the live API through the
shared client module. Its file ownership is disjoint from the API module's,
so the two run in the same wave without a write clash.

Edge cases: an API error renders the error envelope instead of an empty list;
a slow response leaves the page in its loading state rather than a blank
screen; the list renders empty — not broken — when the store holds no notes.

Out of scope: editing a note, and any client-side routing.

## DOCS — Author user guide and record architecture decisions

Approach: the user guide covers install and first-run, and the architecture
decisions are recorded as ADRs whose filenames match the ids the architecture
contract declares.

Edge cases: every decision recorded here has a matching ADR file, so the
floor's decision check can resolve it; the guide names the exact commands
rather than describing them in prose.

Out of scope: API reference material beyond what the guide links to.

## VERIFY — End-to-end smoke suite across api and web

Approach: one smoke suite that exercises the journey a user takes — list the
notes, create one, see it in the console — against a seeded store.

Edge cases: the suite runs in ci mode against a seeded store and exits 0; a
re-run against the same seed produces the same result, so a failure is a real
failure; the health endpoint stays exempt from the rate limiter.

Out of scope: load testing and long-running soak tests.
