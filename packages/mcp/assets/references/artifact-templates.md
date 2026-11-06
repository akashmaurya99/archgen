# Artifact templates — copy, fill, never invent structure

## Provenance header (SHOULD on every NEW tasks.yaml / architecture.yaml)

Begin both files with three YAML comment lines. Comments are ignored by every
consumer (the MCP server, the VS Code extension, any YAML toolchain), so this is
purely additive metadata — it can never break a parser:

**NEVER type the version yourself.** The `scaffold` action writes the generator
line with the RUNNING server's version, and you paste its output verbatim. A
version you write by hand is either stale or made up — and the provenance
header exists precisely so it is never either.

The shape of what `scaffold` returns (the version below is a sample of the
running server's, not a value to copy):

```yaml
# schema_version: 1
# generator: archgen v1.2.3
# generated_at: 2026-08-26T09:00:00.000Z
```

The scaffold action returns these three lines ready to paste.

Version token rules — code-defensive, NEVER guess:

1. The `scaffold` action already resolved the version for you. Copy its
   header as-is.
2. If you must write the header yourself (backfilling an artifact the tool
   did not create), resolve the version in this order and never invent one:
   a. The `.archgen-version` stamp next to the installed `SKILL.md`, when it
      reads as exact `MAJOR.MINOR.PATCH`.
   b. Otherwise the `"version"` field of an adjacent `archgen.config.json`,
      when it is semver-shaped.
   c. Otherwise omit the version token entirely: plain `# generator: archgen`.
3. `npx archgen-skill migrate --apply` applies rules 2(a)–(c) to existing
   artifacts for you, and backs each file up before it touches it.

`generated_at` is one ISO-8601 timestamp per generation run (all files written
by the same run share it). Keep the header at the very top of the file; never
place content above it and never encode meaning anywhere except these three
lines.

Older artifacts without the header are backfilled by
`npx archgen-skill migrate --apply` (dry-run `--check` is the default), which
snapshots each file into `.archgen/.backup/<ts>/migrate/` before touching it
and skips already-stamped files, so re-running is always safe.

## Self-containment rules (anti-hallucination)

Artifacts are executed by sessions and sub-agents that were NEVER part of the
conversation that produced them. Hard rules, no exceptions:

1. **Full paths, always.** Every task step, `file_ownership` glob, artifact,
   and verification command uses complete repo-root-relative paths
   (`src/features/catalog/api/routes.ts`), never bare filenames (`routes.ts`)
   and never invented directories. Paths come from `structure:` /
   `owns[]` in architecture.yaml or from surveyed code — nowhere else.
2. **Names derive from naming_conventions.** Every file, symbol, table, and
   env-var name you introduce cites WHICH convention key produced it, e.g.
   `camelCase symbols per naming_conventions.symbol_casing`. If no key covers
   it, add the key first, then use it.
3. **Plans survive context summarization alone.** Any session reading ONLY
   `.archgen/<slug>/` must execute correctly with zero chat history. If a fact
   matters, it is written in an artifact; if it is not written, it does not
   exist.
4. **Forbidden phrases** (in any artifact): "as discussed", "the usual
   pattern", "same as before", "see chat". Replace each with the concrete
   artifact reference it was standing in for.
5. **Cross-references are artifact-relative**, e.g.
   `see ../architecture.yaml data_contracts.orders` or
   `payload per ../architecture.yaml api_contracts.payments.request_payload`.
   Never restate a contract from memory — point at it.
6. **Markdown heading anchors are GitHub-exact slugs.** Lowercase, punctuation
   dropped, every whitespace character becomes a hyphen (runs are NOT
   collapsed): `## TASK-02 — Auth API` slugs to `#task-02--auth-api`. A link
   whose anchor does not resolve against the target document's real heading
   slugs is a broken `anchor` finding (verifier-blocking). Underscores and
   hyphens survive; letters/digits are never dropped.
7. **Verifier-compatible ids in plans.** `archgen_plan{action:'verify'}` rejects
   any UPPERCASE-numbered token in `plans/*.md` that is not a real tasks.yaml id
   (`TASK-999` fails; your actual ids pass). So: requirement ids
   (`FR-<MODULE>-nn`) are cited from `tasks.yaml` acceptance lines and
   `docs/prd.md` itself; inside plan prose link the anchor instead —
   `../docs/prd.md#fr-catalog-01`. Every tasks.yaml id MUST appear in some
   plan file (coverage check runs both directions).

## Plan depth by scope class

Pick ONE class before writing any artifact; depth scales with risk, not
enthusiasm. Misclassifying is a defect: inflating SMALL wastes tokens,
shrinking LARGE hallucinates.

**The required artifact set is a tool output — never hand-assemble it:**

```
archgen_plan { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }
```

It returns the scope class's REQUIRED artifacts (with paths), the plan sections,
the minimum edge cases per task, the prohibitions, and ready-to-fill skeletons for
`answers.yaml`, `tasks.yaml`, the plan, `docs/prd.md`, `architecture.yaml`, the
ADR and the edge-case matrix. Adding or dropping files is a right-sizing defect.

What follows is the AUTHORING content for each class — what to WRITE, not WHICH
files to create.

- **SMALL** (add/touch few things): a lean plan note —

  ```markdown
  # <feature> — plan note (SMALL)
  Intent: <one paragraph>
  Tasks: see tasks.yaml entries <ids>
  Risks: <bullets or none>
  ```

  Every task entry STILL carries absolute-from-repo-root paths verbatim —
  in `file_ownership`, in each step, in verification commands. No Context
  section, no diagrams, no PRD.

- **MEDIUM**: the plan gains, in order:
  - **Context** — 2–4 paragraphs max: why now, what exists, what changes.
  - **Per-task sections** (one `<id> — <title>` heading per task):
    Approach (short bullets) + **Edge cases** (min 3 bullets each, feeding
    the edge-case matrix below) + **Out-of-scope** (explicit non-goals).
  - **Verification steps** — ordered, runnable, repo-root-relative.
  No PRD, no diagrams unless structure changed.

- **LARGE / greenfield-from-scratch**: the FULL professional stack — PRD
  (~1 page per major module) + expanded `architecture.yaml` (naming_conventions,
  data_contracts, api_contracts, environment_matrix) + per-task edge-case
  matrices + per-module diagrams + MEDIUM-grade plan sections. Every diagram
  ≤15 nodes.

## Structural correctness — verifier-enforced authoring rules

- **Waves derive from `depends_on`.** Declared wave / `parallel_group` labels
  MUST match the dependency-derived topological order — never hand-label a
  task into a wave that contradicts its `depends_on`. A dependent task may not
  sit in an earlier (or parallel) wave than its prerequisite.
  `archgen_plan{action:'graph', format:'mermaid'}` is the ground truth for wave order.
- **artifacts ⊆ file_ownership.** Every path a task lists in `artifacts` must
  fall inside that task's `file_ownership` globs — workers can write ONLY
  owned paths. Listing a doc the task doesn't own is a verifier-blocking
  defect.
- **Verification commands**: repo-root-relative (no `../`, no `--plan .`),
  fully specific — exact commands, versions, sample sizes, thresholds — the
  same form a worker would actually run. Generic "run the tests" or
  wrong-root-resolved paths fail.
- **YAML subset**: the parser supports block mappings, block sequences, and
  SINGLE-LINE flow collections (`["a/**", "b.ts"]`, `{id: A}`). It REJECTS
  block scalars (`|` / `>`), duplicate keys, and UNTERMINATED flow sequences
  (a flow collection must open and close on the same line). Emit only what
  parses — the forbidden forms caused format-repair loops in the field.
- **tasks.yaml edits**: make small targeted edits or one clean full
  regeneration — never large multi-region patches (they corrupted tasks.yaml
  in the field).

## Agent workspace & artifact location — the two-tier rule

Location follows LIFETIME + AUDIENCE: the plan (and its rationale) travels as
ONE self-contained, reviewable, git-versioned unit; the product's deliverables
travel with the product.

INSIDE `.archgen/<slug>/` — the plan + everything needed to execute/review it:
- tasks.yaml, plans/, architecture.yaml, answers.yaml, codebase-map.md.
- `docs/prd.md` — a PLANNING artifact (defines the FR-ids tasks cite), not a
  shipped doc — stays inside so `archgen_docs` can validate FR references.
- `decisions/NNNN-title.md` — the plan's formal ADRs (its rationale). Inside
  keeps the feature folder self-contained and ADR↔task↔plan references valid.
- `.agent/` — ALL agent/sub-agent working state. The leading dot keeps it out
  of doc scans (process state, not a validated artifact):
  - `.agent/decisions/NNNN-<slug>.md` — EXECUTION-time decisions a sub-agent
    takes while working (distinct from the plan's formal ADRs in `decisions/`).
  - `.agent/learnings.md` — conventions/patterns discovered (append-only).
  - `.agent/notes/<task-id-or-topic>.md` — worker/survey/investigator notes.
  - `.agent/reports/<verifier|reviewer|investigate>-<round>.md` — persisted
    verifier/reviewer/investigation findings.
  - `.agent/resume.md` — the RE-ENTRY snapshot, rewritten after every wave:
    ≤10 lines carrying slug, wave index, done/failed/blocked ids, the one
    command to resume (`archgen_tasks{action:'next'}`), and the plan sections the remaining tasks
    own. This is the FIRST file to read after any context compaction.

OUTSIDE `.archgen/` — project DELIVERABLES an approved task produces, written
to the task's `file_ownership` paths at the repo root (never into `.archgen/`):
- source code (`src/...`), and
- shipped documentation: README, API reference, deployment/runbooks, user
  guides — the docs the running software ships to users/operators.

Enterprise refinement — durable ADRs: a decision that outlives this feature
(project-wide, e.g. "Postgres over MongoDB") SHOULD also be promoted to the
project's canonical ADR register (`docs/adr/` or the team's equivalent) so
future features discover it. `.archgen/<slug>/decisions/` is the working
record; the register is the durable project-wide copy. Never delete or
re-number an accepted ADR — supersede it.

## architecture.yaml (LARGE scope)

**The template is a tool output** — `archgen_plan{action:'scaffold', scope:'LARGE'}`
returns it with the provenance header and the slug filled in. Do not retype it.

The four contract blocks (`naming_conventions`, `data_contracts`,
`api_contracts`, `environment_matrix`) are THE anti-hallucination source of
truth: tasks cite them by key instead of re-describing shapes from memory.
Module entries extend `schemas/architecture-conventions.md` (its
`name`/`responsibility`/`owns[]` trio is unchanged and still normative).

**Authoring rules for the blocks:**
- One contract block per module/domain (~10–20 lines each); split further
  rather than letting any single block exceed ~40 lines.
- `modules[].depends_on_modules` MUST be acyclic — it drives the task
  `depends_on` edges.
- `key_interfaces` lists what OTHER modules may import — nothing else.
- `environment_matrix` variables are unparsed vars that fail fast in
  `src/config/`.


## Product requirements document (PRD) — LARGE/greenfield

**The template is a tool output** — the scaffold returns `docs/prd.md`.

Written BEFORE tasks.yaml. Bullet-dense prose, zero filler paragraphs; target
~1 page per major module. Requirement ids here are the stable handles every task
acceptance cites.

**Authoring rules:**
- `FR-<MODULE>-nn` ids are IMMUTABLE once tasks reference them.
- Non-functional requirements need NUMBERS — "fast"/"scalable" without figures
  fail the interview's completion test.
- Success metrics need a baseline → target within a window.


## tasks.yaml (canonical shape)

**The template is a tool output** — the scaffold returns `tasks.yaml` with the
provenance header, the YAML subset rules already applied, and a worked
MINIMAL + LARGE example.

**Rules encoded in the template:**
- `depends_on` = prerequisites (never dependents).
- Ownership globs are disjoint within a wave.
- Acceptance = objectively checkable statements.
- Acceptance bullets SHOULD reference edge-matrix rows (`E1`–`En`) and, on
  LARGE, the FR ids they implement.
- Schema stays stable (`schemas/tasks.schema.json`, schema_version 1) — no new
  required fields; guidance lives in comments and plan files.


## Edge-case matrix (per task, MEDIUM+)

**The matrix template is a tool output** — the scaffold returns a pre-filled
header with one row per coverage class.

Each MEDIUM/LARGE task carries a matrix in its plan section. Every row MUST map
to an acceptance bullet — no orphan rows; every acceptance bullet SHOULD trace to
≥1 row. Minimum coverage classes per task: empty/null, boundary values, authz
denied, concurrent/conflicting write, failure/retry path, i18n/formatting edge.
Tasks touching infra (migrations, deploys, queues) ADD: partial-failure
recovery, rollback story.

`Covered by` = `<task-id>#<acceptance index>` (1-based, matching the tasks.yaml
`acceptance` array). Rows are additive across waves; keep each matrix ≤10 rows —
split into per-concern tables beyond that.


## ADR template (decisions/NNNN-title.md)

**The template is a tool output** — the scaffold returns it.


## Mermaid snippets

**The snippets are a tool output** — the scaffold returns them
(`docs/mermaid-snippets.md`): the C4 context and container diagrams.


## Per-module diagram (LARGE)

**The diagram rules stay here; the template is a tool output.**

For EACH `modules:` entry in architecture.yaml, one small flowchart of its
internal components plus its `depends_on_modules` edges (arrow points from
consumer to provider). Plus ONE integration diagram wiring all modules — edges
between modules only, no internals. HARD LIMIT: ≤15 nodes per diagram; split
into two diagrams rather than cramming. Internals stay ≤6 nodes per module.
