# MCP installation and capability skills

## archgen's own MCP server — already handled

`npx archgen-skill init` (or `install`) wires `archgen-mcp` and CodeGraph into every detected harness. Never configure them manually. Missing `archgen_*` tools → run it at the repo root and ask the user to reload (`§platforms/mcp-configuration`).

The install writes the skill store, harness bridge, and `AGENTS.md` into the repository—**committed to git**, one team copy, never gitignored (`§artifact-templates/artifact-tracking`).

The procedures below govern **external** MCP servers and capability skills.

## INSTALL-MCP procedure (approval-gated)

1. **Identify platform:** `archgen_setup{action:'harness_info'}` (or `§platforms/mcp-configuration`) for the config path, the top-level key, the URL field and the restart semantics. The key vocabulary lives in `§platforms/mcp-configuration` — one list, not two.
2. **Discover:** web-search current official install docs for the server and harness. Never guess commands or schemas.
3. **Declare scope:** **GLOBAL** (recommended for cross-project tools like CodeGraph) or **HARNESS-SPECIFIC**.
4. **Prefer native CLI:** Claude Code `claude mcp add --scope project --transport http <name> <url>`; Codex `codex mcp add <name> --url <url>`; Gemini CLI `gemini mcp add -s project -t http <name> <url>`.
5. **Approval gate:** when editing config directly, show the exact diff (matching `packages/mcp/assets/mcp-template.json`) and **WAIT FOR EXPLICIT USER APPROVAL**.
6. **Apply & verify:** write, apply restart/reload semantics, verify tool visibility.

## FETCH-SKILL procedure

Capability loading is **MANDATORY** whenever planned work matches a registry domain — especially the `ui-skills` family with `policy: "required"` (UI, frontend, design, animation, component, accessibility, motion work).

0. **Two execution points:** pre-planning scan (during GENERATE / BROWNFIELD / UPDATE) and pre-dispatch verification.
1. **MATCH:** `archgen_skills{action:'match', title, summary, fileOwnership}`. Case-insensitive whole-word over all three inputs — including the file ownership, so a path cannot smuggle in a token by containing the letters of one. `"ui"` matches `"redesign the ui"`, never `"build"`. The registry's `matches[]` tokens are the vocabulary — read them from `archgen_skills{action:'list'}`, never from memory. Any `policy: "required"` hit makes steps 2–5 mandatory.
2. **RESOLVE:** `archgen_skills` searches the project chain (every harness skill directory) and the user-global roots, and reports the installation status and the exact path it found or looked for.
3. **INSTALL (if missing):**
   ```
   archgen_skills { action: 'install', skillId, harness, approve: true }
   ```
   Installs the ONE matched skill non-interactively via `npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json` and verifies the resulting path. Never install a whole family. An unknown `harness` is rejected — it never falls back silently.
4. **INTEGRATE:** `archgen_tasks{action:'contract', tasksYaml, taskId}` extracts every matched skill's normative rules (`MUST` / `SHOULD` / `NEVER`), file path, and section index into the worker prompt. To inspect manually: `archgen_skills{action:'load', skillId}` (rules + index, never the whole file), `{action:'digest', skillId}` (index), or `{action:'load', skillId, section}` (one section).
5. **AUDIT:** every worker report includes one line: `Skill compliance: followed <slug> (<path/to/SKILL.md>)` or `Skill compliance: NOT followed — <reason>`.
6. **MISSING CAPABILITY:** for an obvious domain absent from the registry, web-search reputable skill repos, propose the candidate, and add it only after explicit user approval.

## The registry

Managed by `archgen_skills` at `packages/mcp/assets/skill-registry.json` (never edit directly). **The registry is data, and the tool owns it** — `archgen_skills{action:'list'}` returns every entry, so read it there rather than from a copy. A copy here is a second source that can disagree with the one the tool matches against.

Each entry carries:

- `id` / `slug` — the identity and the directory the skill lands in.
- `domain` — the label injected into the worker contract.
- `matches[]` — whole-word tokens matched against task `title`, `summary`, and `file_ownership`.
- `policy` — `"required"` (pre-planning + pre-dispatch) or `"on-demand"`.
- **Granular install:** one skill (`--skill <slug>`) per domain, never a family.
