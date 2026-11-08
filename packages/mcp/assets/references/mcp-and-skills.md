# MCP installation and skill fetching

## archgen's own MCP server — already handled

`npx archgen-skill init` (or `install`) automatically wires `archgen-mcp` and CodeGraph into every detected harness. Never configure them manually. If `archgen_*` tools are missing, run `npx archgen-skill init` at the repo root and ask the user to reload the harness (`§platforms/mcp-configuration`).

The install writes into the repository — the skill store, the harness bridge, `AGENTS.md`. Those files are **committed to git** (one copy, shared by the team), never gitignored (`§artifact-templates/artifact-tracking`).

The procedures below govern **external** MCP servers (e.g., `context7`) and capability skills.

## INSTALL-MCP procedure (approval-gated)

1. **Identify platform:** Call `archgen_setup{action:'harness_info'}` (or inspect `§platforms/mcp-configuration`) for the config path, top-level key (`mcpServers` / `servers` / `mcp` / `context_servers`), and URL field name (`url` / `serverUrl` / `httpUrl`).
2. **Discover:** Web-search current official installation docs for the target MCP server and harness. Never guess commands or config schemas.
3. **Declare scope:** State whether the install is **GLOBAL** (recommended for cross-project tools like CodeGraph) or **HARNESS-SPECIFIC** (project/platform-local).
4. **Prefer native CLI** (matching chosen scope):
   - Claude Code: `claude mcp add --scope project --transport http <name> <url>`
   - Codex: `codex mcp add <name> --url <url>` or `codex mcp add <n> -- <cmd> <args>`
   - Gemini CLI: `gemini mcp add -s project -t http <name> <url>`
5. **Approval gate:** If editing config files directly, show the exact config diff (matching `packages/mcp/assets/mcp-template.json` conventions) and **WAIT FOR EXPLICIT USER APPROVAL** before writing.
6. **Apply & verify:** Write config, apply platform restart/reload semantics, and verify tool visibility.

## FETCH-SKILL procedure

Capability-skill loading is **MANDATORY** whenever planned work matches a registry domain (especially `ui-skills` with `policy: "required"` for UI, frontend, design, animation, component, or landing-page tasks).

0. **Execution points (runs TWICE per matched task):**
   - **Pre-planning scan:** During GENERATE / BROWNFIELD / UPDATE, match every task before finalizing the plan.
   - **Pre-dispatch verification:** Immediately before dispatching a worker, verify required skills are installed.
1. **MATCH:** Call `archgen_skills{action:'match', title, summary, fileOwnership}`. Uses case-insensitive whole-word (`\b`) matching (e.g., `"ui"` matches `"redesign the ui"` or `"ui-skills"`, never `"build"` or `"guide"`). Any hit with `policy: "required"` makes steps 2–5 mandatory.
2. **RESOLVE:** `archgen_skills` checks all project, harness, and global skill directories (`<project>/.agents/skills/<slug>/SKILL.md` and `~/.agents/skills/<slug>/`) and reports installation status and path.
3. **INSTALL (if missing):** Skip if already installed (cache hit). Otherwise call:
   ```
   archgen_skills { action: 'install', skillId, harness, approve: true }
   ```
   This invokes `npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json` to install the single matched skill non-interactively (never a full repo bundle) and verifies the resulting file path.
4. **INTEGRATE (inline into worker contract):** Call `archgen_tasks{action:'contract', tasksYaml, taskId}`. It automatically extracts the normative rules (`MUST` / `SHOULD` / `NEVER`), file path, and section index from every matched required skill and embeds them directly into the worker prompt so workers cannot overlook them.
   - To inspect a skill manually, call `archgen_skills{action:'load', skillId}` (the normative rules + the section index — never the whole file), `{action:'digest', skillId}` (index only), or `{action:'load', skillId, section}` (single section).
5. **AUDIT:** Every worker completion report MUST include an explicit compliance line:
   - `Skill compliance: followed <skill-slug> (<path/to/SKILL.md>)`
   - `Skill compliance: NOT followed — <reason>`
6. **MISSING CAPABILITY:** If a task clearly requires an specialized domain absent from the registry, web-search reputable skill repositories, propose the candidate to the user, and add to the registry ONLY after explicit user approval.

## The registry

Managed by `archgen_skills` at `packages/mcp/assets/skill-registry.json` (never edit directly):

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

- `domain`: Human-readable label injected into the worker contract (`"Motion work: follow ..."`).
- `matches[]`: Case-insensitive whole-word tokens matched against task `title`, `summary`, and `file_ownership`.
- `policy`: `"required"` (mandatory pre-planning + pre-dispatch enforcement) or `"on-demand"` (loaded only when explicitly requested).
- **Granular install:** Each domain maps to and installs ONE specific skill (`--skill <slug>`), never an entire skill family.
