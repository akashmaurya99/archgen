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
4. **INTEGRATE** — inject the follow-instruction into (a) the planning context
   so tasks reference the skill's standards, and (b) EVERY affected worker
   prompt, using this sentence template:

   > `<Domain> work: follow <skill-dir>/SKILL.md (installed via FETCH-SKILL) — apply its standards to every relevant decision.`

   Concrete design instantiation for ui-skills:

   > `Design work: follow <skill-dir>/SKILL.md (installed via FETCH-SKILL) — apply its component/motion/baseline standards to every visual decision.`

5. **AUDIT** — workers MUST state in their completion report whether they
   followed the injected skill, one auditable line, e.g.:
   `Skill compliance: followed ui-skills (<skill-dir>/SKILL.md)` or
   `Skill compliance: NOT followed — <reason>`.
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
  "family": "ui-skills",
  "repo": "ibelick/ui-skills",
  "purpose": "Motion and animation performance — jank-free transitions.",
  "matches": ["animation", "motion", "transition"],
  "policy": "required"
}
```

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
