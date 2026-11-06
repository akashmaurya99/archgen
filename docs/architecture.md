# Architecture

How archgen works internally. This document describes the system as implemented in [`skill/SKILL.md`](../skill/SKILL.md) and its references — nothing here is aspirational.

## MCP-first operation

archgen has ONE implementation of every deterministic capability, and it is the
`archgen-mcp` server (`packages/mcp/`). The skill ships **no code** — it is
orchestration guidance for the agent. Three consumers reach the same
implementation:

1. **Agent.** The MCP server over stdio. Eight domain tools
   (`archgen_plan`, `archgen_tasks`, `archgen_docs`, `archgen_registry`,
   `archgen_codegraph`, `archgen_setup`, `archgen_ui`, `archgen_help`); every
   result is a typed envelope `{ ok, data, error, meta }`.
2. **CLI installer.** `archgen-skill init` / `install` shells out to
   `archgen-mcp bootstrap` to wire the MCP server into every detected harness
   and ensure CodeGraph. The CLI itself stays zero-dependency.
3. **VS Code extension.** `packages/extension/` calls
   `archgen-mcp exec archgen_tasks '{"action":"next"}'` to resolve the frontier,
   and drives the board through the filesystem UI bridge
   (`.archgen/.runtime/cmd/` → `ack/`). It never edits artifacts itself.

All three read the same artifacts and the same task-file schema
(`schemas/tasks.schema.json`); a shared YAML corpus (`fixtures/yaml-corpus/`)
plus a parity test keep the MCP core's parser and the extension's TS port from
diverging.

## The two-gate flow

No task executes until two gates pass, in order — never skipped, even for SMALL scopes:

1. **Verifier gate.** A verifier sub-agent runs `archgen_plan{action:'verify'}` (deterministic floor: cycles, dangling refs, same-wave ownership overlap, missing acceptance criteria, plan↔task coverage), then judges what the tools cannot: wave-boundary sanity, objectively verifiable acceptance criteria, edge-case coverage, code-standards plausibility. It returns exactly one line: `APPROVE` or an issues list. The orchestrator fixes and re-dispatches until APPROVE.
2. **User gate.** Only after verifier approval does the orchestrator present the artifact list, wave summary (`archgen_tasks{action:'next'}`), and ownership map, and ask "Approve to start work?"

## Wave execution & ownership discipline

`archgen_tasks{action:'next'}` resolves the dependency frontier into topological waves. A cycle or an ownership clash comes back as the typed error codes `CYCLE` / `OWNERSHIP_CONFLICT` — the orchestrator fixes `tasks.yaml` before proceeding.

- **One worker per task.** Workers receive: task id + title, acceptance criteria verbatim, their `file_ownership` globs ("edit NOTHING outside these"), the code-standards reference, and the done/failed status command. Workers never talk to each other; coordination happens only through `tasks.yaml` state.
- **Disjoint globs per wave.** Two same-wave tasks may not overlap on file ownership — enforced by the resolver and rejected by the verifier.
- **Dispatch tiers** (`references/orchestration.md`): Tier 1 uses native sub-agents where the harness is strong (Claude Code background agents with worktree isolation; Cursor background subagents; Antigravity `invoke_subagent`; Codex flattened plans; Gemini hub-and-spoke for read-only waves). Tier 2 is a universal bash fallback spawning parallel workers over headless CLIs (`claude -p`, `opencode run`, `codex exec`, `gemini`, `agy`), with git-worktree isolation when ownership borders are tight.
- **Failure policy:** worker failure marks the task `failed` — never auto-retried. Downstream tasks stay blocked via `blockedByFailure`. The user sees the failed id, log path, and a proposed fix task; fix tasks get fresh ids and inherit the failed task's ownership.

## Git as the VCS decision

archgen does not build its own history layer. Workers commit their own work; rollback is `git revert` of the task's commits in reverse dependency order (with status rewinds via `archgen_tasks{action:'set_status', force:true}`, gated on explicit user approval since it's destructive). Done tasks are never deleted from `tasks.yaml` — history lives in git.

## Dot-folder convention

Everything generated goes inside `.archgen/<project-slug>/` at the target repo root — architecture.yaml, Mermaid docs, ADRs in `decisions/`, plans, `tasks.yaml`, worker logs under `results/`. Nothing else is written outside it except source edits performed by approved-task workers. Generation is right-sized: SMALL scopes get tasks entries only; MEDIUM gets plan + tasks.yaml; LARGE/greenfield gets the full artifact set. Existing artifacts are never regenerated unless reality changed.

## Platform detection & web-search fallback

Step 0 asks the server: `archgen_setup { action: 'harness_info' }` detects the
harness from env/config markers in order (`.claude/`, `.cursor/`, `.windsurf/`,
`.opencode`, `.github/copilot-instructions.md`, `~/.codex`, `.gemini/`, `.kiro/`,
`.trae/`) and returns its capability row — skill install paths, MCP config file +
top-level key + entry shape, the MCP CLI, restart semantics, and the sub-agent
dispatch mechanism. The canonical data is
`packages/mcp/assets/platform-capabilities.json`; `references/platforms.md` keeps
the narrative and the detection order. If no platform matches, the orchestrator
uses its web-search tool to find official docs for skill/MCP config locations,
proposes findings, and proceeds only after user approval.

## MCP and skill-fetch subsystems

Two support modes round out the loop:

- **INSTALL-MCP.** When a needed MCP server (e.g. context7) isn't configured, the
  orchestrator reads the platform's config quirks from
  `archgen_setup { action: 'harness_info' }` (VS Code uses `servers`; OpenCode
  uses `mcp` with array commands; Antigravity requires `serverUrl`), prefers the
  platform CLI (`claude/codex/gemini/copilot mcp add …`), otherwise drafts the
  exact config diff and shows it. Configs are written only after approval, then
  verified post-reload.
- **FETCH-SKILL.** The registry, the matching, the install and the
  follow-instruction all live in the `archgen_skills` tool
  (`packages/mcp/assets/skill-registry.json`). A task whose title, summary or
  file ownership matches a capability domain (frontend/UI → ui-skills) is matched
  by WHOLE-WORD patterns; a `required` hit is installed before dispatch — exactly
  ONE skill, never a bundle, via
  `npx -y skills add <repo> --skill <slug> --agent <agent> --yes`. The skill lands
  at `<project>/.agents/skills/<slug>/SKILL.md`, and the worker is pointed at
  that file. Missing capabilities trigger a web search for a reputable skill
  repo, proposed to the user and added to the registry on approval.

## The judgment / output split

The skill holds the **judgment** — policy, rules, when-to-use, authoring craft.
The MCP server holds the **deterministic output** — artifact sets, skeletons,
dispatch briefs, assembled worker prompts, harness capability tables.

The five orchestrator-facing protocol documents moved INTO the MCP package
(`packages/mcp/assets/references/`) and are served section-by-section by
`archgen_refs`. They live there so they are always the same version as the
tools they describe, and so they are not copied into every project that runs
`archgen-skill init`. One exception stays in the skill as a plain file:
`code-standards.md`, because WORKER sub-agents read it with their native file
tools and may have no MCP server at all.

The references point at the tools; they never restate a tool's output. A drift
test (`packages/mcp/test/core/reference-drift.test.mjs`) pins the two together,
so a number that appears in both can never disagree.

## The capability contract

The skill calls the server's tools — that is a dependency, and an undeclared
dependency is a latent outage. So it is declared:

```yaml
# skill/SKILL.md frontmatter
metadata:
  requires:
    archgen_mcp: ">=0.0.6"
```

`archgen_setup{action:'doctor'}` reports a mismatch, `bootstrap` warns before
wiring, and a CI gate (`internal/tools/check-capability-contract.mjs`) refuses
to ship a skill whose declared minimum exceeds the server's version.

| Tool output | Replaces hand-assembly in |
|---|---|
| `archgen_plan { action: 'scaffold' }` | the depth ladder's artifact set + skeletons |
| `archgen_plan { action: 'brief' }` | the verifier / review / survey / investigate briefs |
| `archgen_tasks { action: 'contract' }` | the worker prompt contract (8 rules) |
| `archgen_setup { action: 'harness_info' }` | the harness capability tables |

## Provenance & migration

Every artifact archgen writes carries machine-readable provenance, and every mutation is backup-first:

- **Skill trees** carry a `.archgen-version` stamp (`MAJOR.MINOR.PATCH\n`) at their root — rewritten by the CLI on init/install/update; `doctor` and the VS Code extension read it to flag outdated copies (absent = "unknown (legacy)", never an error).
- **Managed blocks** in AGENTS.md/CLAUDE.md open with a `<!-- archgen:block vX.Y.Z -->` line; init/doctor normalize legacy unversioned blocks to the current format in place.
- **Generated artifacts** under `.archgen/<slug>/` open with `# schema_version:` / generator / generated-at comments. `archgen-skill migrate --check` lists artifacts missing stamps; `--apply` adds them, backing up each original into `.archgen/.backup/<ts>/migrate/`.
- **`archgen-skill restore`** lists snapshots from the project vault (`.archgen/.backup/`) and per-harness global vaults (`<skills-dir>/.archgen-backups/`); restoring a snapshot first moves the current state of every affected path into a fresh safety snapshot.
- **Backup-first policy**: divergent stores, divergent global `--copy` destinations and about-to-be-restored paths are always moved aside before replacement — archgen never destroys state it did not just back up.
