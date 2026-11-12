# Artifact templates — copy, fill, never invent structure

## Provenance header (every NEW tasks.yaml / architecture.yaml)

Begin `tasks.yaml`, `architecture.yaml` and `answers.yaml` with the three YAML comment lines returned by `archgen_plan{action:'scaffold'}`:

```yaml
# schema_version: 1
# generator: archgen vX.Y.Z
# generated_at: 2026-08-26T09:00:00.000Z
```

**Never guess or hand-type a version:** paste the header verbatim. Manual backfill resolves from **one** source — the exact semver in `.agents/skills/archgen/.archgen-version`; when that stamp is absent or is not an exact `MAJOR.MINOR.PATCH`, the token is omitted (`# generator: archgen`) rather than guessed. `npx archgen-skill migrate --apply` backfills idempotently (`--check` is the dry run). All files from one run share one `generated_at`.

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

**No artifact without a consumer.** A generated copy of an existing PRD, architecture document, or ADR is a defect. So is an architecture file for a localized change, an ADR for a routine choice, a diagram for a trivial flow, or a task with no requirement. The floor checks the copy **inside the artifact space**; a duplicate written elsewhere in the host repository (a second PRD at the repo root) is the **reviewer's** judgement, not a floor check — look for it.

## Plan depth by scope class

Run `archgen_plan{action:'profile'}` first; fetch skeletons with `archgen_plan{action:'scaffold', scope, slug}`. **Required files must exist; a file the profile omits must not be created.** Authoring depth:

- **SMALL** (localized change): lean plan note only — no Context, PRD, architecture, ADRs, or diagrams; full repo-root paths still mandatory:
  ```markdown
  # <feature> — plan note (SMALL)
  Intent: <one paragraph>
  Tasks: see tasks.yaml entries <ids>
  Risks: <bullets or none>
  ```
- **MEDIUM**: plan includes **Context** (up to 4 paragraphs: why now, current state, delta), **per-task sections** (`## <id> — <title>` with approach, **Edge cases ≥3** feeding the matrix, out-of-scope), and ordered runnable verification steps. No PRD; architecture only when the profile finds a contract trigger.
- **LARGE**: MEDIUM sections plus **the artifacts the profile marks create** — a PRD when the profile creates it, an expanded `architecture.yaml` when it creates it, per-task edge matrices, and per-module/integration diagrams when the profile creates them. ADRs and diagrams remain conditional. A LARGE class does NOT create every artifact: the profile decides, one artifact at a time.

## Depth budgets

**The profile's `depth` block is the authority** — `archgen_plan{action:'profile'}` returns the ceilings for the class it computed, and they are the same numbers the floor enforces. Read them from that answer; do not copy them from here, because a copy is a second source that can disagree with the first.

Each ceiling is a limit per artifact: the plan context length, the edge cases per task, the PRD, the architecture, the diagrams, the ADRs, the task count and the plan length.

Stop when the consumer is satisfied; "complete" means the required decisions are covered, not that every possible document exists.

## Self-containment rules (anti-hallucination)

Artifacts are executed by sub-agents with zero conversation history. Enforce strictly:

1. **Full repo-root-relative paths:** every task step, `file_ownership` glob, artifact, and verification command uses the complete path (for example `src/features/catalog/api/<route file>`), sourced from `architecture.yaml` (`structure:`/`owns[]`) or surveyed code. Never bare filenames.
2. **Traceable naming:** every file, symbol, table, and env var cites its governing `naming_conventions` key. Add a missing key before citing it.
3. **Zero chat dependency:** `.archgen/<slug>/` must be 100% self-contained. Unwritten facts do not exist.
4. **Forbidden phrases:** never `"as discussed"`, `"the usual pattern"`, `"same as before"`, or `"see chat"`. Cite artifact paths/keys instead.
5. **Cross-reference, do not restate:** point at contracts (`../architecture.yaml data_contracts.orders`).
6. **How a reference resolves:** a target starting with `./` or `../` is relative to the **document's own directory** and must land inside the artifact space; any other target is relative to the **project root**. A project-root path that names an artifact of the artifact space must exist; one outside it is a repository path or an **output declaration** — a file the plan will create — and is not broken for not existing yet. `archgen_docs{action:'validate'}` judges every reference by this rule and carries it with each finding.
7. **GitHub-exact anchors:** lowercase, strip punctuation except `-` and `_`, and convert every whitespace character to `-` without collapsing runs (`## TASK-02 — Auth API` → `#task-02--auth-api`).
8. **Verifier-compatible IDs:** `verify` rejects a task-style id in `plans/*.md` that it cannot place — an unknown `TASK-NN`-style token whose prefix matches this plan's own task ids (or the generic `TASK-`/`T-`/`STEP-` prefixes) and is not an `FR-`/`REQ-`/`NFR-` id or a known technical constant such as `SHA-256` or `HTTP-404`. A bare `FOO-01` is not a task reference and is never rejected. Define `FR-<MODULE>-nn` in `docs/prd.md`, cite them in `tasks.yaml` acceptance, link via anchors inside plans, and keep every task ID present in `plans/*.md`.

## Mechanical invariants — proven by the floor, so make them true the first time

`archgen_plan{action:'verify'}` computes these. They are not style; each one is a fact the gate agent would otherwise have to prove by hand, every round. Author them correctly the first time:

1. **Mirrored test tree:** a task that owns source under `toolchain.source_root` also owns the mirrored path under `toolchain.test_root` (the test FILE NAME is the language's choice; the PATH is not). `test_root` is the root of the tree that **mirrors** the source tree — `tests/unit` in the common layout. Fill both roots in `architecture.yaml`: without them the floor reports `CONFIG_NOT_ENFORCED` and the layout becomes the reviewer's judgement.
2. **Disjoint ownership:** no two tasks' globs overlap, and no glob CONTAINS another task's glob (a later wave can overwrite the earlier task's files).
3. **Matrix citations resolve:** every edge-case row's `Covered by` cell names a task and an acceptance index that exists — and the acceptance it names must verify the stated case.
4. **Requirements are cited:** every `FR-<MODULE>-nn` defined in `docs/prd.md` is cited by at least one acceptance; every FR id an acceptance cites exists in the PRD.
5. **Declared things exist and are owned:** every path in `architecture.yaml` `structure:` and every module `owns[]` glob has a task that owns it; every `decisions[].id` has its `decisions/0001-*.md` file (the decision's number, zero-padded to four digits).
6. **Wave labels match the DAG:** a `parallel_group` labeled `wave-N` must equal the task's computed wave, and every task in one group shares a wave.
7. **Acceptance is runnable (reviewer judgement, not a floor check):** an acceptance a worker cannot run — live credentials, an unwritten script, an undefined fixture — is not a defect the floor reports. Mark it manual, record the artifact, or make it runnable.

### Traceability claims — the link, written down

An acceptance that verifies an edge case or a requirement **says so**:

```
- "the probe result is persisted with its evidence payload (covers E4)"
- "the api returns the list the caller asked for (covers FR-API-01)"
```

The floor then joins the two sides instead of asking a model to infer them: the matrix row `E4` cites `T9#1`, and `T9#1` claims `E4`. A row pointing at an acceptance that does not claim it is an issue, and an acceptance claiming a row that does not exist is an issue. Ids are artifact ids (`E4`, `FR-API-01`) — never code names, never language-specific.

Claims are optional per plan, but the convention is detected: as soon as one acceptance claims an edge id, the mutual link is enforced for every row. A plan that has edge-case rows and declares NO claim at all is `MATRIX_CLAIMS_UNDECLARED` — the rows exist, but nothing proves they are verified. A row still carrying the template's placeholder (`<ID>#1`) is `MATRIX_CITATION_UNRESOLVED` — it was never bound to an acceptance.

### The plan profile record — where the decisions live

The profile is recorded, not remembered, and the floor checks it against the files on disk:

- **MEDIUM / LARGE** → `answers.yaml` → `plan_profile.artifacts[]`.
- **SMALL** → the plan's `## Profile` section, as the fenced YAML block the scaffold writes.

Every entry is `{path, decision, reason}` — and a **`reuse` decision also carries `host_path`** — the existing repository file it cites. A reuse without a `host_path` is `PROFILE_DECISION_INVALID`: it names no file, so nothing can be checked and the reader cannot find what the plan reused.

```yaml
plan_profile:
  artifacts:
    - path: .archgen/acme/architecture.yaml
      decision: create
      reason: cross-module contract
    - path: .archgen/acme/docs/prd.md
      decision: omit
      reason: internal tool; no product personas
    - path: .archgen/acme/docs/prd.md
      decision: reuse
      reason: the host PRD is current
      host_path: docs/product-requirements.md
```

The floor then checks, per **family** (not per literal filename): every `create` family has a file on disk, every `omit`/`reuse` family does NOT, every `reuse` cites a host file that exists, and every artifact on disk belongs to a recorded family. An artifact with no recorded decision is `PROFILE_UNRECORDED` — the defect this whole mechanism exists to prevent. **The check runs only when a profile is recorded**: with none it reports `PROFILE_NOT_RECORDED`, and with no `toolchain.source_root`/`test_root` it reports `CONFIG_NOT_ENFORCED`. Both are warnings — the plan still reaches `APPROVE`, so the decisions are simply unchecked.

A family is a path pattern (`plans/*.md`, `decisions/*.md`, `docs/prd.md`): the plan may name its files as it likes, and the decision still proves.

### Waivers — approved deviations, recorded

A waived finding is an audit event, not a conversation. Write it to `.archgen/<slug>/waivers.yaml` **before** proceeding past it:

```yaml
waivers:
  - id: W1
    scope: ["T19#2", "T19#3"]   # a CODE (MIRROR_MISSING) covers that whole class; a subject covers one instance
    finding: "the live-mode acceptances need live credentials"
    reason: "the live gate runs on the operator machine; the checklist is the artifact"
    approved_by: user
    approved_at: 2026-11-10
```

Every field is required — the floor enforces it, and a waiver missing one is `WAIVER_INVALID` and suppresses nothing. A `scope` entry names the finding it approves: a **code** (`MIRROR_MISSING` — the whole class), a **task id** (`T19`), an **acceptance** (`T19#2`) or a **path glob** (`src/features/catalog/**`). It is matched against the paths and ids the finding names — never against the prose between them — so a waiver cannot approve an unrelated finding by sharing a word with it.

**A covered finding stops being an issue**: the plan can reach `APPROVE`, the floor reports the finding separately as a waived one, and the gate brief lists it. A waived finding is not a defect to fix (unless it regressed).

### Gate metrics — the gate measures itself

After the gate, record what it cost. **This is the canonical block — one shape, used in `answers.yaml` (`plan_profile.gate`), in a SMALL plan's `## Profile` fence, and nowhere else:**

```yaml
gate:
  verifier: "who approved it"   # an approval needs a subject
  rounds: 2
  findings:
    blocking: 12
    nit: 3
    observation: 2
  waived: 1        # must match the number of entries in waivers.yaml
  residual: 0      # findings still open after the last round
  at: "2026-11-10T09:00:00Z"   # ISO-8601 timestamp of the approval
```

`waived` must match `waivers.yaml` — a mismatch is the `WAIVER_COUNT_MISMATCH` warning. A missing `verifier` is the `GATE_IDENTITY_MISSING` warning. These numbers are how you prove the process improved instead of assuming it.

## Structural correctness — verifier-enforced authoring rules

- **Topological waves:** wave / `parallel_group` labels match the `depends_on` order (`archgen_plan{action:'graph', format:'mermaid'}`). Dependents never precede or share a wave with prerequisites.
- **`artifacts` ⊆ `file_ownership`:** every artifact path matches the task's ownership globs. The floor REPORTS a mismatch (`ARTIFACT_NOT_OWNED`, a warning) — it never blocks on it, so a plan that was accepted yesterday is not blocked today.
- **Runnable verification:** repo-root-relative commands (no `../`, no `--plan .`) with exact flags, sample sizes, and thresholds.
- **Restricted YAML subset:** see `## The YAML subset` below — it is a FORMAT contract, not a reviewer rule.
- **Targeted edits:** small surgical edits or a clean full regeneration—never large multi-region patches.
- **Both trees:** `structure:` lists the source tree and its sibling test tree. **Every path in `structure:` and every `owns[]` glob must be owned by a task** — the floor checks it, and a path with `<...>` placeholders is skipped until you fill them in.

## The YAML subset — what `tasks.yaml` accepts

`archgen` parses a hand-rolled YAML subset. The rules are checked against the real parser by the test suite, so they are exactly what the server does — not an approximation.

**Supported**

| Rule | What it means |
|---|---|
| `nested-mappings` | Mappings nest by two-space indentation. |
| `block-sequence` | A block sequence item starts with `- `. |
| `block-sequence-of-mappings` | A block sequence item may be a mapping: `- key: value`. |
| `flow-sequence` | A flow sequence is single-line: `[a, b]`. |
| `flow-mapping` | A flow mapping is single-line and flat: `{k: v, k2: v2}`. |
| `quoted-scalars` | Single and double quotes are both supported, and both keep their text exactly. |
| `comments` | A `#` starts a comment — full-line or after a value. |
| `plain-value-with-colon` | **A plain value MAY contain `": "`** — `title: Refactor: the auth module` reads as one scalar. |
| `quoted-item-with-colon` | **A quoted sequence item is a SCALAR**, never a mapping. Quote a criterion that contains `": "`. |

**Refused — the parser says so, with the line**

| Rule | What is refused |
|---|---|
| `unquoted-item-with-colon` | An UNQUOTED `key: value` sequence item is a MAPPING — so an unquoted criterion containing `": "` becomes an object. Quote it. |
| `block-scalars-banned` | Block scalars (`|`, `>`). Write one line. |
| `anchors-banned` | Anchors and tags (`&`, `*`, `!`). |
| `duplicate-keys-banned` | Duplicate keys are refused, never silently last-wins. |
| `tabs-banned` | Tabs in the indentation. Spaces only. |
| `nested-flow-mapping-banned` | A flow mapping inside a flow mapping. |
| `nested-sequence-banned` | A nested sequence item (`- - x`). |
| `scalar-root-banned` | A bare scalar as the document. A plan is always a mapping. |

Two habits remove every failure this subset can cause: **quote every acceptance criterion** (`- "the api returns the list"`), and **quote every value that contains `": "`**. A flow collection splits on commas — use a block list for a value that contains one.

## Agent workspace & artifact location — the two-tier rule

- **INSIDE `.archgen/<slug>/`:** `tasks.yaml`, `plans/`, `architecture.yaml`, `answers.yaml`, `codebase-map.md`, `docs/prd.md`, `decisions/0001-title.md`, `waivers.yaml` (the approved-deviation ledger), and `.agent/`:
  - `.agent/decisions/NNNN-<slug>.md` — runtime implementation decisions.
  - `.agent/learnings.md` — append-only discovered repo conventions.
  - `.agent/notes/<task-id-or-topic>.md` — working notes.
  - `.agent/reports/<verifier|reviewer|investigate>-<round>.md` — gate/investigation reports.
  - `.agent/resume.md` — the compaction snapshot written by `archgen_tasks{action:'snapshot'}` after every wave. Its length grows with the number of remaining tasks (a fixed header plus a few lines per task), so it is not a fixed line count.
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

Generated via `scaffold` (the provenance header carries `# schema_version: 1`; the task contract itself is defined by the server's validator):
- `depends_on` lists prerequisites only.
- Same-wave `file_ownership` globs are strictly disjoint.
- `acceptance` is objectively checkable; cite edge rows (`E1`–`En`) and PRD IDs where the profile created a PRD.

## Edge-case matrix (MEDIUM+)

Generated via `scaffold`, placed in each MEDIUM/LARGE task's plan section (≤10 rows; split by concern):
- **Coverage classes:** empty/null, boundary values, authz denied, concurrent/conflicting write, failure/retry path, i18n/formatting edge.
- **Infra tasks add:** partial-failure recovery and rollback.
- **Traceability:** every row maps to `Covered by` (`<task-id>#<1-based acceptance index>`); zero orphan rows.

## ADR & diagrams

Generated via `scaffold` only when the profile's trigger fired (`decisions/0001-title.md`, `docs/mermaid-snippets.md`). An ADR records an irreversible or hard-to-reverse decision — never a routine choice.

- **The file name IS the link.** `architecture.yaml` `decisions[].id` `D1` matches `decisions/0001-<title>.md` (zero-padded, then the title slug). The floor looks for a file whose name starts with the decision's number, and falls back to the title slug for a non-numeric id.
- One flowchart per `modules:` entry showing internals (≤6 nodes) plus inbound `depends_on_modules` edges; one integration diagram with modules as atomic nodes.
- **Hard limit:** ≤15 nodes per diagram (split if larger). No diagram for a trivial or single-module flow.
