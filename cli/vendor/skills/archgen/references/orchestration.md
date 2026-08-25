# Orchestration playbook — survey, verify, dispatch

Sub-agent briefs and the wave-execution mechanics. The orchestrator (SKILL.md)
calls into these sections; workers never read this file.

## §survey — brownfield codebase analysis brief

Dispatch 1–2 sub-agents with this prompt shape:

```
TASK: Survey this repository to prepare a feature plan for: <feature request>
DELIVERABLE: write .archgen/<slug>/codebase-map.md containing EXACTLY these
sections:
  ## Structure      — top-2-levels folder tree w/ one-line purpose each
  ## Modules        — table: module | responsibility | key entry points
  ## Conventions    — naming, error-handling, test layout actually observed
  ## Affected       — files/modules the feature will touch, with evidence paths
SCOPE: read-only. Use codegraph MCP tools when available
(codegraph_explore / codegraph_files); otherwise Glob+Grep systematically.
VERIFY: every claim cites a real path; no guessed APIs.
```

Accept the map only if every section is present and non-empty.

## §verifier — plan review brief

Dispatch AFTER artifacts exist and validate.mjs passes. The verifier:

1. Runs `node <skill>/scripts/verify-plan.mjs .archgen/<slug>/tasks.yaml --plan .archgen/<slug>/plans`
   — deterministic floor: cycles, dangling refs, same-wave ownership overlap,
   missing acceptance criteria, plan↔task coverage.
2. Reads plans + tasks.yaml and judges what scripts cannot:
   - Are wave boundaries sensible (no artificial serialization)?
   - Do acceptance criteria objectively verify (command or observable)?
   - Edge cases covered per SKILL.md right-sizing class?
   - Code-standards compliance plausible for the planned structure?
3. Returns EXACTLY one line verdict: `APPROVE` or `ISSUES:` + numbered list.

Orchestrator fixes issues (edits artifacts) and re-dispatches. Loop until
APPROVE — never present to the user before verifier approval.

## §dispatch — wave execution

### Tier 1: native sub-agents (preferred where strong)

- Claude Code: background Agent tool per task; add worktree isolation for
  tasks whose ownership might brush shared files.
- Cursor: background subagents; request isolation when >2 parallel workers.
- Antigravity: invoke_subagent async.
- Codex: spawn_agent works but children can't nest — flatten the plan instead.
- Gemini CLI: parallel @agents are hub-and-spoke only AND have no isolation →
  use them ONLY for read-only/research waves unless wrapping in worktrees.

### Tier 2: bash fallback workers (universal floor)

```bash
#!/usr/bin/env bash
set -uo pipefail
SLUG="<slug>"; ROOT="$(pwd)"; SKILL="<abs-path-to-skills/archgen>"
run_task() { # $1=id  $2=prompt-file
  local id="$1" pf="$2" log=".archgen/$SLUG/results/$id.log"
  mkdir -p "$(dirname "$log")"
  local body; body="$(cat "$pf")

You own exactly the file_ownership globs listed for this task in tasks.yaml. Follow archgen code-standards. On success run: node \"$SKILL/scripts/set-status.mjs\" .archgen/$SLUG/tasks.yaml \"$id\" done ; on failure set-status failed."
  case "$ARCHGEN_HARNESS" in
    claude)    claude -p "$body" --output-format json --permission-mode acceptEdits > "$log" 2>&1 ;;
    opencode)  opencode run "$body" --auto --format json > "$log" 2>&1 ;;
    codex)     codex exec --sandbox workspace-write --json -o "$log.final" "$body" > "$log" 2>&1 ;;
    gemini)    gemini --output-format json "$body" > "$log" 2>&1 ;;
    agy)       agy -p --output-format json --print-timeout 15m "$body" > "$log" 2>&1 ;;
    *) echo "unknown harness: $ARCHGEN_HARNESS" >&2; return 9 ;;
  esac

You own exactly: $(node "$SKILL/scripts/impact.mjs" .archgen/$SLUG/tasks.yaml "$id" >/dev/null 2>&1 && echo 'see tasks.yaml file_ownership'). Follow archgen code-standards. On success run: node "$SKILL/scripts/set-status.mjs" .archgen/$SLUG/tasks.yaml "$id" done ; on failure set-status failed." \
}
# Wave N: launch all frontier tasks in parallel…
for t in $(node "$SKILL/scripts/next-tasks.mjs" .archgen/$SLUG/tasks.yaml \
           | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).waves[0].map(t=>t.id).join(" ")))'); do
  run_task "$t" ".archgen/$SLUG/results/$t.prompt" & pids="$pids $!"
done
fail=0; for p in $pids; do wait "$p" || fail=1; done
exit $fail   # orchestrator inspects statuses before next wave
```

Isolation upgrade for Tier 2 when ownership borders are tight:

```bash
git worktree add ".worktrees/$id" -b "task-$id"
# run worker with cwd=.worktrees/$id, then merge task-$id on success
```

### Worker prompt contract (both tiers)

Every worker receives: task id+title, its acceptance criteria verbatim, its
file_ownership globs ("edit NOTHING outside these"), the code-standards
reference, and the done/failed status-update command. Workers do NOT talk to
each other; coordination happens only through tasks.yaml state.

## Failure policy

- Worker exit ≠ 0 OR status=failed → leave it failed. NEVER auto-retry.
- Downstream tasks stay blocked by the resolver (blockedByFailure).
- Report to user: failed id, log path, proposed fix-task description.
  [wait for user] A fix task gets fresh id, depends_on=[], ownership of the
  failed task's globs.
