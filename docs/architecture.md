# ArchGen architecture

ArchGen has one deterministic runtime (`archgen-mcp`) and a thin agent skill. The CLI installs and repairs the runtime; it does not duplicate planning logic. The design goal is accurate execution with the smallest sufficient model context, not the smallest prompt.

## Control and data planes

```text
archgen-skill CLI / install.sh
  → install and repair the skill store
  → archgen-mcp bootstrap / doctor / admin commands

MCP stdio or `archgen-mcp exec`
  → Zod input validation
  → anchored Context and projectRoot selection
  → action authorization and argument tracking
  → tool handler
  → typed {ok,data,error,meta} envelope
```

The default `lean` profile publishes planning, task execution, document/reference navigation, read-only capability skills, help, and platform facts. `full` adds setup and CodeGraph administration. Skill installation belongs to the full-profile `archgen_setup{action:'install_skill'}` action, never the lean tool surface. An approval flag confirms user intent; it does not create that intent.

## Request and filesystem safety

All tool calls use one `runTool` path. Project selection is inside the typed error boundary, so invalid roots return `PERMISSION_DENIED` instead of a protocol exception.

Filesystem writes use shared containment rules:

- realpath checks catch symlinked parents, not just `..` spelling;
- symlink targets are refused before reading or writing;
- containment runs before locks and directory creation;
- dry runs perform no locks or writes;
- atomic sibling-temp renames protect readers;
- file locks protect read-modify-write cycles;
- no-op status and registry updates leave bytes unchanged.

Task status updates replace only the status token when its provenance line is known. Registry rows are derived from `tasks.yaml`; `AGENTS.md` is never an independent status source.

## Planning model

`depth-ladder.json` owns scope profiles, artifact rules, depth budgets, and dependency order. `archgen_plan.profile` computes create/reuse/omit decisions from evidence. `archgen_plan.scaffold` serves exactly that create set:

- default `index`: artifact decisions, dependencies, and write order;
- `file`: one skeleton plus dependency checks;
- `view:'all'`: legacy bulk output for compatibility.

Task examples are scope-specific: SMALL stays minimal, MEDIUM teaches disjoint parallel ownership, and LARGE adds integration/recovery. `testLayout:'colocated'` removes mirrored roots and ownership for host-native tests; the default `mirrored` mode preserves compatibility. Mermaid snippets are authoring inputs only, never a second diagram artifact. Non-obvious systems create one `docs/topology.md` integration view by default; additional module views require their own consumer and cannot exist without an architecture contract or reused host architecture.

`tasks.yaml` is the canonical task and execution record. `answers.yaml.plan_profile` is canonical for MEDIUM/LARGE; SMALL uses the plan profile fence. PRDs require `product-facing`, architecture requires cross-module/public/data/service contracts, and diagrams require non-obvious topology. Brownfield surveying starts read-only: complex or uncertain work creates `codebase-map.md`, while a proven localized SMALL change embeds `## Survey` in its plan and writes only tasks plus plan. Waivers and ADRs remain evidence-dependent.

The verifier reads one immutable Markdown snapshot for coverage and artifact audit. Shared graph functions distinguish `matches`, `intersects`, and `contains`; mirror coverage requires containment rather than intersection.

## Four-stage gate

1. deterministic floor (`archgen_plan{action:'verify'}`) reaches `APPROVE`;
2. verifier judgment reaches zero BLOCKING findings or an explicit waiver;
3. plan review reaches zero BLOCKING findings or an explicit waiver;
4. user approves execution.

NITs and observations never block. Each judgment stage has at most two rounds by default. Only a user-requested extra pass changes that. Planning artifacts exist before the user gate; “nothing is written” is not the contract.

## Execution

`archgen_tasks.next` returns the executable frontier by default, with `view:'waves'` for pagination. Failed and explicitly blocked tasks are not satisfied dependencies. Capability discovery failure, unreadable skills, missing acceptance, or missing ownership makes a worker non-dispatchable.

Worker contracts carry acceptance, ownership, dependency context, required skill rules, repository-root-relative document paths, and a `.agent/` working-state exception. Every required skill gets its own compliance line. Wave closeout includes a bounded standards/diff review and a derived resume snapshot.

## References and progressive disclosure

`packages/mcp/assets/mode-routes.json` maps modes and phases to deduplicated sections. `archgen_refs.route` serves only the current bundle and its `nextPhase`; intent-specific discovery is filtered to the selected intent. Optional cross-references use `archgen_refs.read` with `include:'own'` by default.

The skill contains universal invariants and the router, not complete copies of every protocol. Gate instructions load at gate time, not during initial scoping.

## Token controls

- `lean` and `full` wire catalogs are measured from real `tools/list` responses.
- CodeGraph defaults to `codegraph_explore`; specialized tools are explicit configuration or CLI options.
- Scaffolds and task frontiers are concise by default.
- Skill sections and registry results are bounded with executable, scope-preserving continuations.
- Legacy MCP results use minified JSON. Verified structured clients may use `ARCHGEN_MCP_RESULT_MODE=structured`, which keeps full structured content and a short success summary; errors always keep full JSON.
- Empty warnings are omitted. Stable version/project metadata remains for compatibility.

Dispatch prompts retain their instructions and exact floor counts under a 6,000-token final safety ceiling. Ordinary briefs are unchanged; pathological evidence falls back to counts/snapshots plus explicit continuations instead of silently dropping defect classes.

`internal/tools/budget/context-budget.mjs` separates generated instructions, triggered skill content, catalogs, artifacts, and worker contexts. Measure model-visible results and complete successful-task cost, not only prompt bytes.

## Artifact formats

- **YAML:** human/agent-edited structured contracts — tasks, answers, architecture, waivers.
- **Markdown:** narrative — plans, PRDs, ADRs, surveys, diagrams, reports, protocol guidance.
- **JSON:** runtime registries, schemas, manifests, lockfiles, wire records, golden contracts.
- **JSONC:** user-owned harness configuration where comments must survive.

Team plan artifacts are committed. Install manifests, wiring records, indexes, dependencies, coverage, and backups are local state. Vendor mirrors and golden files are build/test outputs, not competing sources of truth.

## Verification

The suite combines unit tests, action matrices, real stdio clients, parser corpora, negative plans, greenfield/brownfield fixtures, continuation checks, symlink/security tests, schema contracts, token budgets, and version/sync checks. Golden fixtures are reviewed, never regenerated merely to make a failure disappear.
