# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest (see [CHANGELOG.md](CHANGELOG.md)) | ✅ |
| anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately via either channel:

1. **GitHub private vulnerability reporting** (preferred):
   [github.com/akashmaurya99/archgen/security/advisories/new](https://github.com/akashmaurya99/archgen/security/advisories/new)
2. **Email**: `akashmauryalb@gmail.com`

Include as much as you can: affected component (skill / MCP server / CLI),
version, reproduction steps, and impact. You should receive an
acknowledgement within 48 hours and a remediation plan within 7 days.

## Scope notes

archgen drives coding agents that modify your repository by design.

Reports are most relevant for:

- **the MCP server** (`archgen-mcp`) — its tool surface, its path containment,
  its approval gates, and the harness-config writes it performs;
- **the installer** (`npx archgen-skill init/install`) — what it writes, where,
  and what it refuses to write through a symlink;
- **the skill** — the guidance it injects into an agent's context;
- **supply-chain concerns** in either published npm package (`archgen-mcp`,
  `archgen-skill`) — the MCP server ships with a committed lockfile and is
  audited in CI.
