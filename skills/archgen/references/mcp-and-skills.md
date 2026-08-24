# MCP installation and skill fetching

## INSTALL-MCP procedure (approval-gated)

1. **Identify** the platform (SKILL.md Step 0), load its row from
   references/platforms.md section MCP: config file, top-level key, quirks.
2. **Prefer the platform CLI** where the table lists one. It handles scope and
   file selection correctly:
   - `claude mcp add --scope project --transport http <name> <url>`
   - `codex mcp add <name> --url <url>` or `codex mcp add <n> -- cmd args`
   - `gemini mcp add -s project -t http <name> <url>`
3. No CLI available: draft the exact config diff against the platform's real
   shape (see assets/mcp-template.json for annotated canonical forms) and SHOW
   it to the user. Wait for explicit approval.
4. Apply, then apply the restart semantics from the platforms table.
5. Verify the tool is visible after reload; report failure modes honestly.

Never write MCP configs silently. Never invent config shapes — the four known
top-level keys are mcpServers / servers / mcp / context_servers; remote URL
fields vary (url vs serverUrl vs httpUrl) per the platforms table.

## FETCH-SKILL procedure

1. Read assets/skill-registry.json. Match the current task domain against
   entry `matches` patterns (e.g. frontend/UI work matches ui-skills).
2. Install into the CURRENT platform's skill dir (platforms.md paths):
   - Generic: `npx skills add <owner>/<repo>` (writes correct path for 75+
     harnesses; `-g` for global).
   - Entry-specific command when present (e.g. `npx ui-skills get baseline-ui`).
3. Confirm files landed where expected; then FOLLOW the fetched skill's own
   instructions for the task domain.
4. Missing capability: web-search reputable skill repos, propose to user,
   on approval append an entry to the registry (PR or local edit).

## Registry entry shape

```json
{
  "name": "short-name",
  "purpose": "when to reach for it",
  "repo": "owner/repo",
  "install": "npx skills add owner/repo",
  "matches": ["frontend", "ui", "design"]
}
```
