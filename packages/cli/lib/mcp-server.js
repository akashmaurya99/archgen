// mcp-server.js — locate and drive the `archgen-mcp` server from the CLI.
//
// WHY THE CLI DELEGATES: archgen's deterministic capability now lives in ONE
// place — the MCP server. The CLI used to shell out to the skill's
// scripts/codegraph.mjs; it now shells out to `archgen-mcp bootstrap`, which
// runs the same code the agent's tools run. There is no second implementation
// of harness wiring, CodeGraph bootstrap, or doctor logic.
//
// NEVER FATAL: no npm, no network, a read-only config, or a missing MCP
// server must still leave a working skill install. Failures are REPORTED,
// never thrown — the same posture bootstrapCodegraph has always had.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const MCP_PACKAGE = 'archgen-mcp';

/**
 * Locate the archgen-mcp binary.
 *
 * Resolution order (first hit wins):
 *   1. $ARCHGEN_MCP_BIN            — explicit override
 *   2. <project>/node_modules/.bin/archgen-mcp
 *   3. `archgen-mcp` on PATH       — a global npm install
 *   4. `npx -y archgen-mcp`        — network fallback (npx caches it)
 *
 * @param {{projectRoot?: string, home?: string, env?: Record<string, string|undefined>}} opts
 * @returns {{bin: string|null, source: 'override'|'local'|'path'|'npx', command: string, args: string[]}}
 */
export function resolveMcpBinary(opts = {}) {
  const { projectRoot = process.cwd(), home = homedir(), env = process.env } = opts;

  const override = env.ARCHGEN_MCP_BIN;
  if (override && existsSync(override)) {
    return { bin: override, source: 'override', command: override, args: [] };
  }

  const local = join(
    resolve(projectRoot),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'archgen-mcp.cmd' : 'archgen-mcp',
  );
  if (existsSync(local)) return { bin: local, source: 'local', command: local, args: [] };

  const onPath = whichOnPath('archgen-mcp', env);
  if (onPath) return { bin: onPath, source: 'path', command: onPath, args: [] };

  return { bin: null, source: 'npx', command: 'npx', args: ['-y', MCP_PACKAGE] };
}

/**
 * Locate an executable on PATH (cross-platform, no shell).
 * @param {string} bin
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
export function whichOnPath(bin, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      try {
        if (existsSync(p) && !p.endsWith('/')) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * Run one `archgen-mcp` subcommand and return its JSON output.
 *
 * @param {string[]} args the subcommand + flags
 * @param {{projectRoot?: string, timeout?: number, env?: Record<string, string|undefined>}} opts
 * @returns {{ok: boolean, code: number|null, data: any, stdout: string, stderr: string, detail?: string}}
 */
export function runMcp(args, opts = {}) {
  const { projectRoot = process.cwd(), timeout = 600000, env = process.env } = opts;
  const resolved = resolveMcpBinary({ projectRoot, env });

  let r;
  try {
    r = spawnSync(resolved.command, [...resolved.args, ...args], {
      encoding: 'utf8',
      timeout,
      env,
      cwd: projectRoot,
      shell: false,
      // On Windows the npx shim is a .cmd file, which needs a shell.
      ...(process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command) ? { shell: true } : {}),
    });
  } catch (e) {
    return { ok: false, code: null, data: null, stdout: '', stderr: '', detail: String(e?.message ?? e) };
  }
  if (r.error) {
    return { ok: false, code: null, data: null, stdout: '', stderr: '', detail: String(r.error.message ?? r.error) };
  }
  const stdout = r.stdout ?? '';
  let data = null;
  try {
    data = JSON.parse(stdout);
  } catch {
    /* not JSON — the caller renders the raw output */
  }
  return {
    ok: r.status === 0,
    code: r.status ?? null,
    data,
    stdout,
    stderr: r.stderr ?? '',
  };
}

/**
 * Wire the archgen MCP server into the detected harnesses and ensure CodeGraph.
 *
 * @param {{projectRoot: string, location?: 'project'|'global'|'both', approved?: boolean, env?: Record<string, string|undefined>}} opts
 * @returns {{ok: boolean, skipped?: string, detail?: string, report?: any}}
 */
export function bootstrapMcp(opts) {
  const { projectRoot, location = 'both', approved = true, env = process.env } = opts;
  const args = ['bootstrap', '--project', projectRoot, '--location', location, '--json'];
  if (approved) args.push('--yes');

  const r = runMcp(args, { projectRoot, env });
  if (r.detail) {
    return { ok: false, detail: `cannot run ${MCP_PACKAGE}: ${r.detail}` };
  }
  if (r.data === null) {
    const firstLine = (r.stderr || r.stdout || '').trim().split('\n')[0];
    return { ok: false, detail: firstLine || `${MCP_PACKAGE} bootstrap produced no output` };
  }
  return { ok: r.ok, report: r.data, detail: r.ok ? undefined : r.stderr.trim().split('\n')[0] };
}

/**
 * Health-check the archgen MCP install.
 * @param {{projectRoot: string, env?: Record<string, string|undefined>}} opts
 */
export function mcpDoctor(opts) {
  const { projectRoot, env = process.env } = opts;
  const r = runMcp(['doctor', '--project', projectRoot, '--json'], { projectRoot, env, timeout: 60000 });
  return { ok: r.ok, report: r.data, detail: r.detail ?? (r.data ? undefined : r.stderr.trim().split('\n')[0]) };
}

/**
 * Remove the archgen MCP entries.
 * @param {{projectRoot: string, env?: Record<string, string|undefined>}} opts
 */
export function uninstallMcp(opts) {
  const { projectRoot, env = process.env } = opts;
  const r = runMcp(['uninstall-mcp', '--project', projectRoot, '--yes', '--json'], { projectRoot, env, timeout: 60000 });
  return { ok: r.ok, report: r.data, detail: r.detail };
}
