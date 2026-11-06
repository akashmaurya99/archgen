---
name: Bug report
about: Report a problem with archgen
labels: bug
---

## Description

<!-- What is broken? One or two sentences. -->

## Repro steps

1.
2.
3.

## Expected

<!-- What should have happened? -->

## Actual

<!-- What actually happened? Include relevant output/logs. -->

## Harness & platform

- Harness (Claude Code / OpenCode / Cursor / Codex / Gemini CLI / Antigravity / VS Code extension):
- Component (MCP server `archgen-mcp` / skill / CLI / extension):
- archgen version (or commit):
- archgen-mcp version (`archgen-mcp --version`):
- OS:
- Node version:

> If the MCP server misbehaves, `archgen_setup { action: 'doctor' }` prints the
> capability contract, the skill install, the MCP wiring and CodeGraph state —
> paste it here.
