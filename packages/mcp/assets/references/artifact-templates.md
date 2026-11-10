# Artifact templates — copy, fill, never invent structure

## Provenance header (every NEW tasks.yaml / architecture.yaml)

Begin `tasks.yaml` and `architecture.yaml` with the three YAML comment lines returned by `archgen_plan{action:'scaffold'}`:

```yaml
# schema_version: 1
# generator: archgen v1.2.3
# generated_at: 2026-08-26T09:00:00.000Z
```

**Never guess or hand-type a version:** paste the header verbatim. Manual backfill resolves in order: exact semver from `.archgen-version` next to `SKILL.md`; the semver in adjacent `archgen.config.json`; otherwise omit the token. `npx archgen-skill migrate --apply` backfills idempotently (`--check` is the dry run). All files from one run share one `generated_at`.

## Artifact necessity & reuse

An artifact exists only when it has a consumer and changes a decision. Apply this test to every candidate:

1. **Consumer** — which worker, verifier, maintainer, or operator reads it?
2. **Decision** — what future choice does it change?
3. **Source** — is the fact already in code, `README`, a host ADR, or another artifact? If yes, cite that source; do not duplicate it.
4. **Risk** — what defect does omitting it cause? If "none", omit it and record the reason.

`archgen_plan{action:'profile'}` decides each artifact independently:

- **create** — the trigger is present; write it to the depth budget and stop.
- **reuse** — the host repository already owns the fact. Record the exact path in the plan Profile (and `answers.yaml` when present); write only the delta if the source is stale.
- **omit** — record the reason. Never create an unneeded artifact to look complete.

**No artifact without a consumer.** A generated copy of an existing PRD, architecture document, or ADR is a defect. So is an architecture file for a localized change, an ADR for a routine choice, a diagram for a trivial flow, or a task with no requirement.

## Plan depth by scope class

Run `archgen_plan{action:'profile'}` first; fetch skeletons with `archgen_plan{action:'scaffold', scope, slug}`. **Required files must exist; a file the profile omits must not be created.** Authoring depth:

- **SMALL** (localized change): lean plan note only — no Context, PRD, architecture, ADRs, or diagrams; full repo-root paths still mandatory:
  ```markdown
  # <feature> — plan note (SMALL)
  Intent: <one paragraph>
  Tasks: see tasks.yaml entries <ids>
  Risks: <bullets or none>
  ```
- **MEDIUM**: plan includes **Context** (2–4 paragraphs: why now, current state, delta), **per-task sections** (`## <id> — <title>` with approach, **Edge cases ≥3** feeding the matrix, out-of-scope), and ordered runnable verification steps. No PRD; architecture only when the profile finds a contract trigger.
- **LARGE**: MEDIUM sections plus the artifacts the profile marks create — PRD (~1 page/module), expanded `architecture.yaml` (`naming_conventions`, `data_contracts`, `api_contracts`, `environment_matrix`), per-task edge matrices, and per-module/integration diagrams (≤15 nodes each). ADRs and diagrams remain conditional.

## Depth budgets

The profile returns hard ceilings. Stop when the consumer is satisfied; "complete" means the required decisions are covered, not that every possible document exists.

| Scope | Plan context | Edge cases/task | PRD | Architecture | Diagrams | ADRs |
|---|---|---|---|---|---|---|
| SMALL | 1 paragraph | 0 | none | none | none | none |
| MEDIUM | 2–4 paragraphs | 3 | none | ≤20 lines/module, only for contracts | none | ≤1, only if irreversible |
| LARGE | 2–4 paragraphs | 3–7 | ≤1 page/module | ≤20 lines/module | ≤15 nodes each, when topology is non-obvious | ≤3 total |

Plan-length ceilings: SMALL ≤60 lines, MEDIUM ≤180, LARGE ≤400. Task ceilings: 5 / 12 / 30.

## Self-containment rules (anti-hallucination)

Artifacts are executed by sub-agents with zero conversation history. Enforce strictly:

1. **Full repo-root-relative paths:** every task step, `file_ownership` glob, artifact, and verification command uses the complete path (for example `src/features/catalog/api/<route file>`), sourced from `architecture.yaml` (`structure:`/`owns[]`) or surveyed code. Never bare filenames.
2. **Traceable naming:** every file, symbol, table, and env var cites its governing `naming_conventions` key. Add a missing key before citing it.
3. **Zero chat dependency:** `.archgen/<slug>/` must be 100% self-contained. Unwritten facts do not exist.
4. **Forbidden phrases:** never `"as discussed"`, `"the usual pattern"`, `"same as before"`, or `"see chat"`. Cite artifact paths/keys instead.
5. **Cross-reference, do not restate:** point at contracts (`../architecture.yaml data_contracts.orders`).
6. **GitHub-exact anchors:** lowercase, strip punctuation except `-` and `_`, and convert every whitespace character to `-` without collapsing runs (`## TASK-02 — Auth API` → `#task-02--auth-api`).
7. **Verifier-compatible IDs:** `verify` rejects unknown `UPPERCASE-NN` tokens in `plans/*.md`. Define `FR-<MODULE>-nn` in `docs/prd.md`, cite them in `tasks.yaml` acceptance, link via anchors inside plans, and keep every task ID present in `plans/*.md`.

## Mechanical invariants — proven by the floor, so make them true the first time

`archgen_plan{action:'verify'}` computes these. They are not style; each one is a fact the gate agent would otherwise have to prove by hand, every round. Author them correctly the first time:

1. **Mirrored test tree:** a task that owns source under `toolchain.source_root` also owns the mirrored path under `toolchain.test_root` (the test FILE NAME is the language's choice; the PATH is not). Fill `toolchain.source_root` / `toolchain.test_root` in `architecture.yaml` — without them the floor cannot check it.
2. **Disjoint ownership:** no two tasks' globs overlap, and no glob CONTAINS another task's glob (a later wave can overwrite the earlier task's files).
3. **Matrix citations resolve:** every edge-case row's `Covered by` cell names a task and an acceptance index that exists — and the acceptance it names must verify the stated case.
4. **Requirements are cited:** every `FR-<MODULE>-nn` defined in `docs/prd.md` is cited by at least one acceptance; every FR id an acceptance cites exists in the PRD.
5. **Declared things exist and are owned:** every path in `architecture.yaml` `structure:` and every module `owns[]` glob has a task that owns it; every `decisions[].id` has its `decisions/NNNN-*.md` file.
6. **Wave labels match the DAG:** a `parallel_group` labeled `wave-N` must equal the task's computed wave, and every task in one group shares a wave.
7. **Acceptance is runnable:** an acceptance a worker cannot run (live credentials, an unwritten script, an undefined fixture) is a defect — mark it manual and record the artifact, or make it runnable.

### Traceability claims — the link, written down

An acceptance that verifies an edge case or a requirement **says so**:

```
- "the probe result is persisted with its evidence payload (covers E4)"
- "the api returns the list the caller asked for (covers FR-API-01)"
```

The floor then joins the two sides instead of asking a model to infer them: the matrix row `E4` cites `T9#1`, and `T9#1` claims `E4`. A row pointing at an acceptance that does not claim it is an issue, and an acceptance claiming a row that does not exist is an issue. Ids are artifact ids (`E4`, `FR-API-01`) — never code names, never language-specific.

Claims are optional per plan, but the convention is detected: as soon as one acceptance claims an edge id, the mutual link is enforced for every row. Until then the floor reports that the claims are not declared, so the gap is visible.

### The plan profile record — where the decisions live

The profile is recorded, not remembered, and the floor checks it against the files on disk:

- **MEDIUM / LARGE** → `answers.yaml` → `plan_profile.artifacts[]`, each `{path, decision, reason}` plus `host_path` for a `reuse` decision (the existing file it cites).
- **SMALL** → the plan's `## Profile` section, as the fenced YAML block the scaffold writes.

The floor then proves: every `create` artifact exists, every `omit` artifact does NOT exist, every `reuse` cites a file that exists, and every artifact on disk has a decision. An artifact without a decision is `PROFILE_UNRECORDED` — the defect this whole mechanism exists to prevent.

### Waivers — approved deviations, recorded

A waived finding is an audit event, not a conversation. Write it to `.archgen/<slug>/waivers.yaml` **before** proceeding past it:

```yaml
waivers:
  - id: W1
    scope: ["T19#2", "T19#3"]
    finding: "the live-mode acceptances need live credentials"
    reason: "the live gate runs on the operator machine; the checklist is the artifact"
    approved_by: user
    approved_at: 2026-11-10
```

`scope`, `finding`, `reason`, `approved_by` and `approved_at` are required — a waiver without a reason is not a waiver. The floor reports the ledger's size, the gate brief shows it, and a waived finding is not a defect to fix (unless it regressed).

### Gate metrics — the gate measures itself

After the gate, record what it cost in the plan Profile (`answers.yaml` → `plan_profile.gate`, or the plan's `## Profile`):

```yaml
gate:
  rounds: 2
  findings:
    blocking: 12
    nit: 3
    observation: 2
  waived: 1
  residual: 0
```

`waived` must match `waivers.yaml`. These numbers are how you prove the process improved instead of assuming it.

## Structural correctness — verifier-enforced authoring rules

- **Topological waves:** wave / `parallel_group` labels match the `depends_on` order (`archgen_plan{action:'graph', format:'mermaid'}`). Dependents never precede or share a wave with prerequisites.
- **`artifacts` ⊆ `file_ownership`:** every artifact path matches the task's ownership globs.
- **Runnable verification:** repo-root-relative commands (no `../`, no `--plan .`) with exact flags, sample sizes, and thresholds.
- **Restricted YAML subset:** block mappings/sequences and single-line flow collections only. **BANNED:** block scalars (`|` / `>`), duplicate keys, and multi-line flow collections.
- **Targeted edits:** small surgical edits or a clean full regeneration—never large multi-region patches.
- **Both trees:** `structure:` lists the source tree and its sibling test tree; a task that owns source owns the mirrored test path (`references/code-standards.md`).

## Agent workspace & artifact location — the two-tier rule

- **INSIDE `.archgen/<slug>/`:** `tasks.yaml`, `plans/`, `architecture.yaml`, `answers.yaml`, `codebase-map.md`, `docs/prd.md`, `decisions/NNNN-title.md`, `waivers.yaml` (the approved-deviation ledger), and `.agent/`:
  - `.agent/decisions/NNNN-<slug>.md` — runtime implementation decisions.
  - `.agent/learnings.md` — append-only discovered repo conventions.
  - `.agent/notes/<task-id-or-topic>.md` — working notes.
  - `.agent/reports/<verifier|reviewer|investigate>-<round>.md` — gate/investigation reports.
  - `.agent/resume.md` — ≤10-line compaction snapshot, updated after every wave.
- **OUTSIDE `.archgen/`:** product deliverables at their `file_ownership` paths (`src/...`, `README.md`, API docs, runbooks). Promote durable decisions from `.archgen/<slug>/decisions/` to the project's canonical ADR directory (`docs/adr/`); supersede rather than delete or renumber accepted ADRs.

Every path under `.archgen/<slug>/` is committed, `.agent/` included — it is the audit trail (`§artifact-tracking`).

## Artifact tracking — every archgen artifact is committed

The plan of record belongs in the repository and its history: `git log` must show what was decided, when it changed, and what shipped.

**Committed:** `.archgen/<slug>/` (tasks, plans, docs, architecture, decisions, `.agent/`), `.agents/skills/archgen/` (canonical installed skill), `.claude/skills/archgen` (harness bridge), `AGENTS.md` and `CLAUDE.md` (registry hub + pointer), and the project MCP config (`.mcp.json`, `.cursor/mcp.json`, `opencode.json`, `.vscode/mcp.json`, …).

**Never committed:** `.codegraph/` (local symbol index), `.archgen/.runtime/` (legacy heartbeat), the `.archgen-version` deploy stamp.

**Rules:**
1. **NEVER gitignore an archgen artifact.** A rule covering `.archgen/`, `.agents/`, `.claude/`, or `AGENTS.md` is a defect—remove it.
2. **Commit the plan before the first wave**, then each wave's artifact state (statuses, notes, decisions, reports, snapshot) with that wave's commits.
3. **Fix the ignore rule before force-adding**; if you must force-add, say so in the completion report.
4. **Never rewrite published history** to hide an artifact—the plan of record is append-only, like the code it plans.

## architecture.yaml

Generated only when the profile marks it create. Rules for the anti-hallucination blocks:
- Keep each module/domain contract ~10–20 lines; split before 40.
- `modules[].depends_on_modules` is a DAG (drives task `depends_on`).
- `key_interfaces` lists only exports other modules may consume.
- `environment_matrix` vars fail fast when unparsed at the config boundary.
- Record `toolchain:` (language, build/test/lint/typecheck commands, source and test roots) and `existing_docs:` (host sources of truth) so tasks cite them instead of guessing.

## Product requirements document (PRD)

Generated only when the profile marks it create. Author it BEFORE `tasks.yaml` (~1 bullet-dense page per module):
- `FR-<MODULE>-nn` IDs are immutable once referenced by `tasks.yaml`.
- NFRs need concrete numbers (latency, throughput, compliance standard); adjectives fail verification.
- Success metrics state `<baseline> -> <target> within <window>`.

## tasks.yaml

Generated via `scaffold` (`schemas/tasks.schema.json`, `schema_version: 1`):
- `depends_on` lists prerequisites only.
- Same-wave `file_ownership` globs are strictly disjoint.
- `acceptance` is objectively checkable; cite edge rows (`E1`–`En`) and PRD IDs where the profile created a PRD.

## Edge-case matrix (MEDIUM+)

Generated via `scaffold`, placed in each MEDIUM/LARGE task's plan section (≤10 rows; split by concern):
- **Coverage classes:** empty/null, boundary values, authz denied, concurrent/conflicting write, failure/retry path, i18n/formatting edge.
- **Infra tasks add:** partial-failure recovery and rollback.
- **Traceability:** every row maps to `Covered by` (`<task-id>#<1-based acceptance index>`); zero orphan rows.

## ADR & diagrams

Generated via `scaffold` only when the profile's trigger fired (`decisions/NNNN-title.md`, `docs/mermaid-snippets.md`). An ADR records an irreversible or hard-to-reverse decision — never a routine choice.

- One flowchart per `modules:` entry showing internals (≤6 nodes) plus inbound `depends_on_modules` edges; one integration diagram with modules as atomic nodes.
- **Hard limit:** ≤15 nodes per diagram (split if larger). No diagram for a trivial or single-module flow.
