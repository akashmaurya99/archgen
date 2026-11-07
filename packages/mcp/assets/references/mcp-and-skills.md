# MCP installation and skill fetching

## archgen's own MCP server — already handled

The `archgen-mcp` server and CodeGraph are wired by the installer
(`npx archgen-skill init` / `install`), into every DETECTED harness, with the
correct per-platform file and key. You never configure them by hand.

If the `archgen_*` tools are missing from your tool list, run
`npx archgen-skill init` in the project root and ask the user to reload the
harness — that is the only setup step. The full per-platform shapes live in
§platforms/mcp-configuration and in the installer's registry; the
`archgen_setup` tool reports exactly what it would write (`action:'harnesses'`).

Everything below is for OTHER MCP servers (context7, …).

## INSTALL-MCP procedure (approval-gated)

1. **Identify** the platform (SKILL.md Step 0), load its row from
   §platforms/mcp-configuration: config file, top-level key, quirks.
2. **Discover** — when the correct installation method or config shape for
   the detected harness is not confidently known, web-search the CURRENT
   official installation docs/command FIRST. Never trust potentially-stale
   memorized commands or invented config shapes; uncertainty triggers search,
   not guessing.
3. **Scope** — choose and state the install scope explicitly:
   - **GLOBAL** — server types that are global entries (npx/npm-based MCP
     servers usable across harnesses). Recommended for universally-useful
     servers (codegraph is the canonical example) unless the user prefers
     project-local.
   - **HARNESS-SPECIFIC** — write into the detected platform's config only.
     Recommended when the server only matters to that platform.
   The user's approval covers the stated scope.
4. **Prefer the platform CLI** where the table lists one, passing the scope
   flag that matches the chosen scope:
   - `claude mcp add --scope project --transport http <name> <url>`
   - `codex mcp add <name> --url <url>` or `codex mcp add <n> -- cmd args`
   - `gemini mcp add -s project -t http <name> <url>`
5. No CLI available: draft the exact config diff against the platform's real
   shape (see `packages/mcp/assets/mcp-template.json` for annotated canonical
   forms) and SHOW
   it to the user. **USER APPROVAL GATE** — wait for an explicit yes before any
   write; approval is never inferred from earlier steps.
6. Apply, then apply the restart semantics from the platforms table.
7. Verify the tool is visible after reload; report failure modes honestly.

Never write MCP configs silently. Never invent config shapes — the four known
top-level keys are mcpServers / servers / mcp / context_servers; remote URL
fields vary (url vs serverUrl vs httpUrl) per the platforms table. Uncertainty
triggers web-search of current official docs, never invention.

## FETCH-SKILL procedure

Capability-skill loading is **REQUIRED, not opportunistic**. Whenever planned
work touches a registry `matches` domain, the matching skill MUST be loaded —
during planning (GENERATE / BROWNFIELD / UPDATE) AND re-verified during
execution (worker dispatch). UI/design/frontend/animation/component/
landing-page work REQUIRES the design skills (`ui-skills`, `policy:
"required"`) loaded first. Referenced from elsewhere as:
*see §mcp-and-skills/fetch-skill*.

0. **WHEN** — mandatory, twice per matched task:
   - **Pre-planning scan**: while planning, check every task's title, summary,
     and `file_ownership` against the registry BEFORE the plan is finalized;
     fetch any matched skill at that point.
   - **Pre-dispatch verification**: immediately before dispatching each worker,
     re-verify its match; if the skill is missing from the platform skill dir,
     install it before dispatch proceeds.
1. **MATCH** — call `archgen_skills { action: 'match', title, summary,
   fileOwnership }`. The tool holds the registry and applies **case-insensitive
   whole-WORD matching** (`\b` boundaries; a match requires the pattern to stand
   alone as a token or hyphen/underscore-delimited unit). Bare `"ui"` matches
   the task "redesign the ui" and "ui-skills audit", but does NOT match
   "guide", "build", "sequence", or "building" — the 2026-08 substring semantics
   mis-fired on every task and made the required gate meaningless. One
   `required` hit = this procedure is mandatory for that task.
2. **RESOLVE** — the tool reports, for every match, whether the skill is
   already installed and at which path. It owns the per-platform resolution
   (§platforms/harness-capabilities is the human-readable mirror);
   never duplicate that logic here.
3. **INSTALL once if absent** — cached check first: if the skill is already
   present, skip the reinstall and go to step 4. Otherwise call
   `archgen_skills { action: 'install', skillId, harness, approve: true }`.
   The tool drives the `skills` CLI (`npx -y skills add <repo> --skill <slug>
   --agent <agent> --yes --json`) — **one skill, never a bundle**, and
   non-interactively (the CLI PROMPTS without `--yes`/`--agent`, so an
   automated install would hang). Then VERIFY: the tool re-checks the
   filesystem and reports the path. Fetch happens ONCE per project; later runs
   are cache hits.

   The tool searches the SAME roots the archgen skill itself is resolved from
   — the project chain upward, across every harness directory, then the
   user-global roots. A skill installed one level up, or under a
   harness-specific directory, is found. (It used to look at exactly one
   path, so a skill that had just been installed could be reported as "not
   installed".)
4. **INTEGRATE** — the rules go INTO the worker prompt, not beside it.

   `archgen_tasks { action: 'contract', tasksYaml, taskId }` does this for
   you: it matches the task, resolves the installed path, extracts the
   skill's **normative rules** (the MUST / SHOULD / NEVER lines) and writes
   them into the contract, together with the file path and the skill's
   section index. EVERY matched required skill is included — not just the
   first.

   **Why the rules travel with the contract:** a pointer to a file is a file
   the worker may never open. The worker is focused on the acceptance
   criteria, and nothing forces it to open the skill — which is exactly how a
   design skill gets installed and then never applied. The rules are the
   operative content; the path stays as provenance for deeper reading; the
   section index is the lens for pulling more when the worker decides it
   needs it.

   To see what a skill would contribute before dispatching, call
   `archgen_skills { action: 'load', skillId }` — it returns the same rules
   and the section index — or `archgen_skills { action: 'digest', skillId }`
   for the section index alone, or `{ action: 'load', skillId, section }` for
   exactly one section.
5. **AUDIT** — workers MUST state in their completion report whether they
   followed the injected skill, one auditable line, e.g.:
   `Skill compliance: followed baseline-ui (/path/to/SKILL.md)` or
   `Skill compliance: NOT followed —` followed by the reason. The contract
   carries the concrete skill name and path, so the line never carries a
   placeholder.
6. **MISSING CAPABILITY** — unmatched-but-obvious domain (user says "make it
   pretty" with no registry entry): web-search reputable skill repos, propose
   to user, on approval append an entry to the registry (PR or local edit).
   Never add registry entries without explicit user approval.
## The registry

The registry lives with the MCP server — `packages/mcp/assets/skill-registry.json`
— and is read by the `archgen_skills` tool. The agent never edits it and never
reads it directly; the tool is the only interface.

Canonical entry keys, in order:

```json
{
  "id": "ui-motion",
  "slug": "fixing-motion-performance",
  "domain": "Motion",
  "family": "ui-skills",
  "repo": "ibelick/ui-skills",
  "purpose": "Motion and animation performance — jank-free transitions.",
  "matches": ["animation", "motion", "transition"],
  "policy": "required"
}
```

- `domain`: the label the worker contract uses ("Motion work: follow …"). It
  is what replaces the old `<Domain>` placeholder, which shipped literally in
  every worker prompt.
- `matches[]`: case-insensitive WHOLE-WORD patterns tested against task titles,
  summaries and file_ownership during the FETCH-SKILL domain scan (step 1).
  Never raw substrings — see step 1 for why.
- `policy` (`required` | `on-demand`) — how mandatory loading is:
  - `"required"`: loading is MANDATORY whenever work touches any of the
    entry's `matches` domains — pre-planning fetch plus pre-dispatch
    verification (FETCH-SKILL steps 0–5 all apply).
  - `"on-demand"`: fetched only when a task explicitly names the capability.

**Install model.** The `skills` CLI (npm package `skills`, from
vercel-labs/skills) installs ONE named skill:

```
npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json
```

`--yes` and `--agent` are MANDATORY for an automated install: without them the
CLI is interactive and will hang. It lands the skill at
`<project>/.agents/skills/<slug>/SKILL.md` (global: `~/.agents/skills/<slug>/`)
— every harness reads `.agents/skills/`, so that one path is what a worker
should be pointed at.

**No clustering.** A task that mentions "animation" gets the motion skill — not
the whole UI family. The registry maps a capability DOMAIN to ONE precise skill,
and the tool installs exactly that.
