// mcp-server-manager.mjs — install and wire the `archgen-mcp` server itself.
//
// This is the piece that makes "install the skill, get the MCP" true. When
// the skill is installed into a harness, this module puts an `archgen` entry
// into that harness's own MCP config — using the exact per-platform file,
// top-level key and entry shape from assets/harness-mcp.json.
//
// The binary is resolved in a fixed order so the MCP starts instantly:
//   1. $ARCHGEN_MCP_BIN            — explicit override
//   2. <project>/node_modules/.bin/archgen-mcp
//   3. `archgen-mcp` on PATH       — a global npm install
//   4. `npx -y archgen-mcp`        — network fallback (npx caches it)
//
// The resolved ABSOLUTE path is what lands in the config, so the MCP does not
// pay an npx round-trip on every launch.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { wireServer, recordWiring, removeWiring } from './harness-wiring.mjs';
import { which } from './codegraph-manager.mjs';

export const MCP_PACKAGE = 'archgen-mcp';

/**
 * Locate the archgen-mcp binary.
 * @param {{projectRoot: string, home?: string, env?: Record<string, string|undefined>}} opts
 * @returns {{bin: string|null, source: 'override'|'local'|'path'|'npx', command: string, args: string[]}}
 */
export function resolveMcpBinary(opts) {
  const { projectRoot, home = homedir(), env = process.env } = opts;

  const override = env.ARCHGEN_MCP_BIN;
  if (override && existsSync(override)) {
    return { bin: override, source: 'override', command: override, args: [] };
  }

  const local = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'archgen-mcp.cmd' : 'archgen-mcp');
  if (existsSync(local)) {
    return { bin: local, source: 'local', command: local, args: [] };
  }

  const onPath = which('archgen-mcp', env);
  if (onPath) {
    return { bin: onPath, source: 'path', command: onPath, args: [] };
  }

  return { bin: null, source: 'npx', command: 'npx', args: ['-y', MCP_PACKAGE] };
}


/**
 * Wire the archgen MCP into the detected harnesses.
 *
 * @param {{
 *   projectRoot: string,
 *   registry: any,
 *   home?: string,
 *   location?: 'project'|'global'|'both',
 *   approved?: boolean,
 *   dryRun?: boolean,
 *   env?: Record<string, string|undefined>,
 *   binPath?: string|null,
 * }} opts
 * @returns {{detected: string[], wired: Array<Record<string, unknown>>, planned: boolean, binary: {bin: string|null, source: string}}}
 */
export function wireArchgenMcp(opts) {
  const {
    projectRoot,
    registry,
    home = homedir(),
    location = 'both',
    approved = false,
    dryRun = false,
    env = process.env,
  } = opts;

  const resolved = opts.binPath !== undefined ? { bin: opts.binPath, source: 'override' } : resolveMcpBinary({ projectRoot, home, env });

  const entries = registry.archgenEntries;
  const npxEntries = registry.archgenNpxEntries ?? registry.archgenEntries;

  const result = wireServer({
    serverId: 'archgen',
    registry,
    entries,
    npxEntries,
    projectRoot,
    home,
    location,
    approved,
    dryRun,
    binPath: resolved.bin,
    fallbackCommand: 'npx',
  });

  // The npx fallback is baked into the registry's archgenNpxEntries block, so
  // buildEntry already produces the right command + args for it.

  const written = result.wired.filter((w) => w.status === 'written');
  if (written.length) {
    recordWiring(
      projectRoot,
      'archgen',
      written.map((w) => ({ harness: w.harness, location: w.location ?? 'project', path: w.path, key: w.key })),
    );
  }

  return { ...result, binary: { bin: resolved.bin, source: resolved.source } };
}

/**
 * Remove the archgen MCP entries this server wrote.
 * @param {string} projectRoot
 * @param {string} [home]
 */
export function uninstallArchgenMcp(projectRoot, home = homedir(), location = 'both') {
  return removeWiring(projectRoot, 'archgen', home, location);
}

/**
 * Report whether the archgen MCP is wired into each detected harness.
 * @param {{projectRoot: string, registry: any, home?: string}} opts
 */
export function archgenMcpStatus(opts) {
  const { projectRoot, registry, home = homedir() } = opts;
  const resolved = resolveMcpBinary({ projectRoot, home });
  const rows = [];
  for (const [id, h] of Object.entries(registry.harnesses ?? {})) {
    const atHome = (h.detectHome ?? []).some((m) => existsSync(join(home, m)));
    const atProject = (h.detectProject ?? []).some((m) => existsSync(join(projectRoot, m)));
    if (!atHome && !atProject) continue;
    for (const [loc, cfg] of Object.entries(h.configs ?? {})) {
      if (loc === 'global' && !atHome) continue;
      if (loc === 'project' && !atProject) continue;
      const abs = cfg.path.startsWith('~') ? join(home, cfg.path.slice(2)) : join(projectRoot, cfg.path);
      rows.push({ harness: id, location: loc, path: abs, key: cfg.key ?? `mcp_servers.archgen`, exists: existsSync(abs) });
    }
  }
  return { binary: resolved, targets: rows };
}

