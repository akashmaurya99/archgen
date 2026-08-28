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

Include as much as you can: affected component (skill / CLI / extension),
version, reproduction steps, and impact. You should receive an
acknowledgement within 48 hours and a remediation plan within 7 days.

## Scope notes

archgen's skill executes coding agents that modify your repository by design;
the VS Code extension is strictly read-only (it never writes to your
workspace and opens codegraph indexes read-only). Reports are most relevant
for: installer behavior (`npx archgen-skill init/install`), the skill's
script surface, extension parsing of `.archgen/` artifacts, and supply-chain
concerns in either published package.
