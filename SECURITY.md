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

## The privilege boundary

The server publishes a **profile**:

- `lean` (the default) publishes the data-plane tools only. The admin tools —
  `archgen_setup` and `archgen_codegraph` — install software and write harness
  configuration, and they are **not** in `tools/list`, so a model cannot call
  them at all.
- `full` publishes them too. Use it for a trusted automation run, not for a
  model reading an untrusted repository.

A profile decides what the MODEL sees, never what the system can do: the CLI
(`archgen-skill mcp add|remove|list`, `archgen-skill codegraph
ensure|wire|status`) reaches the same handlers. Every write command prints
its PLAN without `--yes` and writes only with it.

The CLI also pins its own server: the `npx` fallback asks for the CLI's own
version, and an `archgen-mcp` on `PATH` that is OLDER than the CLI is
skipped — a stale global install would otherwise answer with an old tool
surface. `archgen-skill doctor` reports the skew and names the fix.

## Third-party packages

CodeGraph is a separate MCP server that ArchGen wires, never re-implements.
`packages/mcp/assets/codegraph-policy.json` owns the facts that matter for a
review:

- the **first-time install** fetches the newest published release — the
  official install path — and it happens ONCE. An installed CodeGraph is never
  upgraded or rewritten: it may be pinned, it may be a bundle install, and it
  is the user's to manage (`codegraph upgrade` is theirs to run);
- the MCP entry's `npx` fallback is **pinned** to an exact version, so a
  machine with no binary still resolves a reviewed version — an unpinned
  `npx -y pkg` executes whatever `latest` becomes;
- the entry carries `CODEGRAPH_MCP_TOOLS` (the tool surface the agent may
  call) and `CODEGRAPH_TELEMETRY=0` (per process — the machine-wide setting is
  left exactly as the user configured it).

Override with `ARCHGEN_CODEGRAPH_INSTALL`, `ARCHGEN_CODEGRAPH_VERSION` (the
pinned fallback version, or `latest` to unpin), `ARCHGEN_CODEGRAPH_TOOLS` and
`ARCHGEN_CODEGRAPH_TELEMETRY`.

One caveat worth knowing when you review an agent's CodeGraph use: the
CodeGraph MCP server accepts an absolute `projectPath` and resolves it to the
nearest `.codegraph/` index, so an agent CAN query a different project on the
same machine. ArchGen's guidance restricts it to the project in hand.
