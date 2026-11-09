# MCP installation and capability skills

## archgen's own MCP server — already handled

`npx archgen-skill init` (or `install`) wires `archgen-mcp` and CodeGraph into every detected harness. Never configure them manually. Missing `archgen_*` tools → run it at the repo root and ask the user to reload (`§platforms/mcp-configuration`).

The install writes the skill store, harness bridge, and `AGENTS.md` into the repository—**committed to git**, one team copy, never gitignored (`§artifact-templates/artifact-tracking`).

The procedures below govern **external** MCP servers and capability skills.

## INSTALL-MCP procedure (approval-gated)

1. **Identify platform:** `archgen_setup{action:'harness_info'}` (or `§platforms/mcp-configuration`) for config path, top-level key (`mcpServers` / `servers` / `mcp` / `context_servers`), and URL field (`url` / `serverUrl` / `httpUrl`).
2. **Discover:** web-search current official install docs for the server and harness. Never guess commands or schemas.
3. **Declare scope:** **GLOBAL** (recommended for cross-project tools like CodeGraph) or **HARNESS-SPECIFIC**.
4. **Prefer native CLI:** Claude Code `claude mcp add --scope project --transport http <name> <url>`; Codex `codex mcp add <name> --url <url>`; Gemini CLI `gemini mcp add -s project -t http <name> <url>`.
5. **Approval gate:** when editing config directly, show the exact diff (matching `packages/mcp/assets/mcp-template.json`) and **WAIT FOR EXPLICIT USER APPROVAL**.
6. **Apply & verify:** write, apply restart/reload semantics, verify tool visibility.

## FETCH-SKILL procedure

Capability loading is **MANDATORY** whenever planned work matches a registry domain—especially `ui-skills` with `policy: "required"` for UI, frontend, design, animation, component, or landing-page tasks.

0. **Two execution points:** pre-planning scan (during GENERATE / BROWNFIELD / UPDATE) and pre-dispatch verification.
1. **MATCH:** `archgen_skills{action:'match', title, summary, fileOwnership}`. Case-insensitive whole-word (`\b`): `"ui"` matches `"redesign the ui"`, never `"build"`. Any `policy: "required"` hit makes steps 2–5 mandatory.
2. **RESOLVE:** `archgen_skills` checks project, harness, and global directories (`<project>/.agents/skills/<slug>/SKILL.md`, `~/.agents/skills/<slug>/`) and reports installation status and path.
3. **INSTALL (if missing):**
   ```
   archgen_skills { action: 'install', skillId, harness, approve: true }
   ```
   Installs the ONE matched skill non-interactively via `npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json` and verifies the resulting path. Never install a whole family.
4. **INTEGRATE:** `archgen_tasks{action:'contract', tasksYaml, taskId}` extracts every matched skill's normative rules (`MUST` / `SHOULD` / `NEVER`), file path, and section index into the worker prompt. To inspect manually: `archgen_skills{action:'load', skillId}` (rules + index, never the whole file), `{action:'digest', skillId}` (index), or `{action:'load', skillId, section}` (one section).
5. **AUDIT:** every worker report includes one line: `Skill compliance: followed <slug> (<path/to/SKILL.md>)` or `Skill compliance: NOT followed — <reason>`.
6. **MISSING CAPABILITY:** for an obvious domain absent from the registry, web-search reputable skill repos, propose the candidate, and add it only after explicit user approval.

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

- `domain`: label injected into the worker contract.
- `matches[]`: whole-word tokens matched against task `title`, `summary`, and `file_ownership`.
- `policy`: `"required"` (pre-planning + pre-dispatch) or `"on-demand"`.
- **Granular install:** one skill (`--skill <slug>`) per domain, never a family.
