# MCP installation and skill fetching

## INSTALL-MCP procedure (approval-gated)

1. **Identify** the platform (SKILL.md Step 0), load its row from
   references/platforms.md section MCP: config file, top-level key, quirks.
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
   shape (see assets/mcp-template.json for annotated canonical forms) and SHOW
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
*see references/mcp-and-skills.md § FETCH-SKILL procedure*.

0. **WHEN** — mandatory, twice per matched task:
   - **Pre-planning scan**: while planning, check every task's title, summary,
     and `file_ownership` against the registry BEFORE the plan is finalized;
     fetch any matched skill at that point.
   - **Pre-dispatch verification**: immediately before dispatching each worker,
     re-verify its match; if the skill is missing from the platform skill dir,
     install it before dispatch proceeds.
1. **MATCH** — read assets/skill-registry.json. Test every task's title,
   summary, and file_ownership globs against each entry's `matches` patterns
   using case-insensitive substring matching (e.g. a task titled "polish
   landing page hero" matches ui-skills via `"landing page"`). One hit = this
   procedure is mandatory for that task.
2. **RESOLVE** — determine the CURRENT platform's skill dir from
   references/platforms.md § Skill install paths. That table owns the paths;
   never duplicate them here.
3. **INSTALL once if absent** — cached check first: if the skill is already
   present in the resolved platform skill dir, skip reinstall and go to step 4.
   Otherwise run the entry's `install` command (generic fallback:
   `npx skills add <owner>/<repo>`; `-g` for global; entry-specific commands
   like `npx ui-skills get baseline-ui` when present). Then VERIFY presence:
   confirm the skill directory/SKILL.md landed where platforms.md says it
   should. Fetch happens ONCE per project; later runs are cache hits.
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

## Registry entry shape

Canonical keys, in order — there are no others. Notably there is NO
`npxCommand` field anywhere in the registry; the executable command lives in
`install` (with optional `direct_fetch`):

```json
{
  "name": "short-name",
  "purpose": "when to reach for it",
  "repo": "owner/repo",
  "install": "npx skills add owner/repo",
  "direct_fetch": "optional per-skill fetch command",
  "browse": "optional listing command",
  "mcp_endpoint": "optional MCP URL",
  "matches": ["frontend", "ui", "design"],
  "policy": "required"
}
```

- `matches[]`: case-insensitive substrings tested against task titles,
  summaries, and file_ownership during the FETCH-SKILL domain scan (step 1).
- `policy` (`required` | `on-demand`) — how mandatory loading is:
  - `"required"`: loading is MANDATORY whenever work touches any of the
    entry's `matches` domains — pre-planning fetch plus pre-dispatch
    verification (FETCH-SKILL steps 0–5 all apply). Currently only ui-skills
    carries this; design/UI/frontend work must not proceed without it.
  - `"on-demand"`: fetched only when a task explicitly names the installer or
    another registry entry lacks a usable command (e.g.
    vercel-skills-installer).
