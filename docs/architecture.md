# Architecture

How archgen works internally. This document describes the system as implemented in [`skill/SKILL.md`](../skill/SKILL.md) and its references — nothing here is aspirational.

## Dual-mode operation

archgen runs in two shapes:

1. **CLI / headless skill.** The canonical form: the agent skill (`skill/`) is loaded by any harness that can read files and run shell commands. Deterministic logic lives in `skill/scripts/*.mjs` (zero npm dependencies, Node >= 18); the orchestrator LLM branches on their JSON output.
2. **Extension-as-window.** `packages/extension/` is a VS Code extension that opens `.archgen/` artifacts as live views — task DAG, code dependency graph, rendered docs, build button. It is strictly read-only over your repository: it never edits files itself.

Both consume the same artifacts and the same task-file schema (`schemas/tasks.schema.json`); a shared YAML corpus (`fixtures/yaml-corpus/`) keeps the skill's parser and the extension's TS port from diverging.

## The two-gate flow

No task executes until two gates pass, in order — never skipped, even for SMALL scopes:

1. **Verifier gate.** A verifier sub-agent runs `scripts/verify-plan.mjs` (deterministic floor: cycles, dangling refs, same-wave ownership overlap, missing acceptance criteria, plan↔task coverage), then judges what scripts cannot: wave-boundary sanity, objectively verifiable acceptance criteria, edge-case coverage, code-standards plausibility. It returns exactly one line: `APPROVE` or an issues list. The orchestrator fixes and re-dispatches until APPROVE.
2. **User gate.** Only after verifier approval does the orchestrator present the artifact list, wave summary (`next-tasks.mjs`), and ownership map, and ask "Approve to start work?"

## Wave execution & ownership discipline

`scripts/next-tasks.mjs` resolves the dependency frontier into topological waves. Exit codes 2/3 signal a cycle or an ownership clash — the orchestrator fixes `tasks.yaml` before proceeding.

- **One worker per task.** Workers receive: task id + title, acceptance criteria verbatim, their `file_ownership` globs ("edit NOTHING outside these"), the code-standards reference, and the done/failed status command. Workers never talk to each other; coordination happens only through `tasks.yaml` state.
- **Disjoint globs per wave.** Two same-wave tasks may not overlap on file ownership — enforced by the resolver and rejected by the verifier.
- **Dispatch tiers** (`references/orchestration.md`): Tier 1 uses native sub-agents where the harness is strong (Claude Code background agents with worktree isolation; Cursor background subagents; Antigravity `invoke_subagent`; Codex flattened plans; Gemini hub-and-spoke for read-only waves). Tier 2 is a universal bash fallback spawning parallel workers over headless CLIs (`claude -p`, `opencode run`, `codex exec`, `gemini`, `agy`), with git-worktree isolation when ownership borders are tight.
- **Failure policy:** worker failure marks the task `failed` — never auto-retried. Downstream tasks stay blocked via `blockedByFailure`. The user sees the failed id, log path, and a proposed fix task; fix tasks get fresh ids and inherit the failed task's ownership.

## Git as the VCS decision

archgen does not build its own history layer. Workers commit their own work; rollback is `git revert` of the task's commits in reverse dependency order (with status rewinds via `set-status --force`, gated on explicit user approval since it's destructive). Done tasks are never deleted from `tasks.yaml` — history lives in git.

## Dot-folder convention

Everything generated goes inside `.archgen/<project-slug>/` at the target repo root — architecture.yaml, Mermaid docs, ADRs in `decisions/`, plans, `tasks.yaml`, worker logs under `results/`. Nothing else is written outside it except source edits performed by approved-task workers. Generation is right-sized: SMALL scopes get tasks entries only; MEDIUM gets plan + tasks.yaml; LARGE/greenfield gets the full artifact set. Existing artifacts are never regenerated unless reality changed.

## Platform detection & web-search fallback

Step 0 probes env/config markers in order (`.claude/`, `.cursor/`, `.windsurf/`, `.opencode`, `.github/copilot-instructions.md`, `~/.codex`, `.gemini/`, `.kiro/`, `.trae/`). First match wins and selects the row of `references/platforms.md`: skill install paths, MCP config shape, sub-agent mechanism, headless CLI. If no platform matches, the orchestrator uses its web-search tool to find official docs for skill/MCP config locations, proposes findings, and proceeds only after user approval.

## MCP and skill-fetch subsystems

Two support modes round out the loop:

- **INSTALL-MCP.** When a needed MCP server (e.g. codegraph, context7) isn't configured, the orchestrator looks up the current platform's config quirks (VS Code uses `servers`; OpenCode uses `mcp` with array commands; Antigravity requires `serverUrl`), prefers the platform CLI (`claude/codex/gemini/copilot mcp add …`), otherwise drafts the exact config diff and shows it. Configs are written only after approval, then verified post-reload.
- **FETCH-SKILL.** When a task domain matches an entry in `assets/skill-registry.json` (e.g. frontend/UI → ui-skills), the orchestrator installs the referenced skill into the current platform's skill dir (usually `npx skills add <repo>`), confirms, then follows the fetched skill for that domain. Missing capabilities trigger a web search for a reputable skill repo, proposed to the user and added to the registry on approval.
