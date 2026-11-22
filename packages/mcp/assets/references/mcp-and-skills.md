# MCP installation and capability skills

## archgen's own MCP server — already handled

`npx archgen-skill init` (or `install`) wires `archgen-mcp` and, unless opted out, CodeGraph into detected harnesses. Never configure them manually. Missing `archgen_*` tools → run it at the repo root and ask the user to reload (`§platforms/mcp-configuration`).

The install writes the skill store, harness bridge, and `AGENTS.md`; those team integration files are committed. Install manifests, wiring records, indexes, and backups stay local (`§artifact-templates/artifact-tracking`).

The procedures below govern **external** MCP servers and capability skills.

## INSTALL-MCP procedure (approval-gated)

1. **Identify platform:** `archgen_platform` (or `§platforms/mcp-configuration`) for the config path, the top-level key, the URL field and the restart semantics. The key vocabulary lives in `§platforms/mcp-configuration` — one list, not two.
2. **Discover:** web-search current official install docs for the server and harness. Never guess commands or schemas.
3. **Declare scope:** **GLOBAL** (recommended for cross-project tools like CodeGraph) or **PROJECT** (the current repository's harness config).
4. **Prefer native CLI:** Claude Code `claude mcp add --scope project --transport http <name> <url>`; Codex `codex mcp add <name> --url <url>`; Gemini CLI `gemini mcp add -s project -t http <name> <url>`.
5. **Approval gate:** when editing config directly, show the exact diff (derived from the canonical harness registry) and **WAIT FOR EXPLICIT USER APPROVAL**.
6. **Apply & verify:** never hand-edit a harness config — apply the change with the sanctioned command (`archgen-skill mcp add --project <dir> --location project --yes` for ArchGen's own server, the platform's own `mcp add` for an external one). It prints the PLAN first and writes only with `--yes`; then apply the restart/reload semantics and verify tool visibility.

## FETCH-SKILL procedure

Capability loading is **MANDATORY** whenever planned work matches a registry domain — especially the `ui-skills` family with `policy: "required"` (UI, frontend, design, animation, component, accessibility, motion work).

0. **Two execution points:** pre-planning scan (during GENERATE / BROWNFIELD / UPDATE) and pre-dispatch verification.
1. **MATCH:** `archgen_skills{action:'match', title, summary, fileOwnership}`. Case-insensitive whole-word over all three inputs — including the file ownership, so a path cannot smuggle in a token by containing the letters of one. `"ui"` matches `"redesign the ui"`, never `"build"`. The registry's `matches[]` tokens are the vocabulary — read them from `archgen_skills{action:'list'}`, never from memory. Any `policy: "required"` hit makes installation and integration mandatory.
2. **RESOLVE:** `archgen_skills` searches the project chain (every harness skill directory) and the user-global roots, and reports the installation status and the exact path it found or looked for.
3. **MISSING CAPABILITY:** for an obvious domain absent from the registry, web-search reputable skill repos, propose the candidate, and add it only after explicit user approval.

## INSTALL-SKILL procedure (approval-gated)

1. **INSTALL (if missing):**
   ```
   archgen_setup { action: 'install_skill', skillId, harness, approve: true }
   ```
   Full-profile admin only, after explicit user approval. Installs ONE matched skill via `npx -y skills add <repo> --skill <slug> --agent <agent> --yes --json` and verifies the resulting path. Never install a family; an unknown harness is rejected. The boolean confirms approval, it does not replace it. This installer requires the Node version in `installer.nodeEngine`; use the project's normal package manager or a newer Node runtime when the host is older.
2. **INTEGRATE:** `archgen_tasks{action:'contract', tasksYaml, taskId}` extracts every matched skill's normative rules (`MUST` / `SHOULD` / `NEVER`), file path, and section index into the worker prompt. To inspect manually: `archgen_skills{action:'load', skillId}` (rules + index, never the whole file), `{action:'digest', skillId}` (index), or `{action:'load', skillId, section}` (one section).
3. **AUDIT:** every worker report includes ONE line PER REQUIRED SKILL: `Skill compliance: followed <slug> (<path/to/SKILL.md>)` or `Skill compliance: NOT followed — <reason>`.

## The registry

Managed by `archgen_skills` at `packages/mcp/assets/skill-registry.json` (never edit directly). **The registry is data, and the tool owns it** — `archgen_skills{action:'list'}` returns every entry, so read it there rather than from a copy. A copy here is a second source that can disagree with the one the tool matches against.

Each entry carries:

- `id` / `slug` — the identity and the directory the skill lands in.
- `domain` — the label injected into the worker contract.
- `matches[]` — whole-word tokens matched against task `title`, `summary`, and `file_ownership`.
- `policy` — `"required"` (pre-planning + pre-dispatch) or `"on-demand"`.
- **Granular install:** one skill (`--skill <slug>`) per domain, never a family.
