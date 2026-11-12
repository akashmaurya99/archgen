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
import { wireServer, recordWiring, removeWiring, configHasServer, detectHarnesses, configTargetFor } from './harness-wiring.mjs';
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
 * @param {'project'|'global'|'both'} [location]
 * @param {Record<string, string|undefined>} [env]
 */
export function uninstallArchgenMcp(projectRoot, home = homedir(), location = 'both', env = process.env) {
  return removeWiring(projectRoot, 'archgen', home, location, env);
}

/**
 * Report whether the archgen MCP is wired into each detected harness.
 *
 * Detection and path resolution go through the SAME functions the writer
 * uses. A second, hand-rolled copy of either is how a `COPILOT_HOME` or a
 * `~/`-relative config gets checked in the wrong place — and the check then
 * disagrees with the write that follows it.
 *
 * @param {{projectRoot: string, registry: any, home?: string, env?: Record<string, string|undefined>}} opts
 */
export function archgenMcpStatus(opts) {
  const { projectRoot, registry, home = homedir(), env = process.env } = opts;
  const resolved = resolveMcpBinary({ projectRoot, home, env });
  const rows = [];
  for (const d of detectHarnesses(registry, projectRoot, home, env)) {
    for (const [loc, cfg] of Object.entries(d.spec.configs ?? {})) {
      if (loc === 'global' && !d.atHome) continue;
      if (loc === 'project' && !d.atProject) continue;
      const abs = configTargetFor(cfg, { projectRoot, home, env }).path;
      rows.push({
        harness: d.id,
        location: loc,
        path: abs,
        key: cfg.key ?? `mcp_servers.archgen`,
        exists: existsSync(abs),
        // `wired` is the fact bootstrap needs: the file may exist for other
        // harnesses while the archgen entry is missing.
        wired: configHasServer(abs, cfg, 'archgen'),
      });
    }
  }
  return { binary: resolved, targets: rows };
}

