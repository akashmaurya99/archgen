// global-server.js — ONE archgen MCP server for every harness.
//
// WHY A GLOBAL INSTALL.
//
// The harness configs name the server's executable by ABSOLUTE PATH, so the
// path has to keep working. The npx fallback points into npm's npx CACHE
// (~/.npm/_npx/<hash>/…), which `npm cache clean --force` removes — and the
// harness then fails to start a server that was wired minutes earlier.
//
// A global install (`npm install -g archgen-mcp`) puts the binary in the
// npm prefix's bin directory: one copy, shared by every harness, at a path
// that does not move when the registry publishes a new version.
//
// The install is BEST EFFORT. A machine without a writable npm prefix, an
// offline machine, or a user who does not want a global package must still
// get a working skill install — the npx fallback covers all of them.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { npmInvocation, whichOnPath } from './spawn-npm.js';

export const MCP_PACKAGE = 'archgen-mcp';

/**
 * The version of the server this CLI ships with.
 *
 * The CLI and the server are released together, so the installer can ask for
 * exactly the version it was tested against instead of "whatever is latest".
 *
 * @param {string} packageRoot the CLI's own package root
 * @returns {string}
 */
export function serverVersion(packageRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'latest';
  } catch {
    return 'latest';
  }
}

/**
 * Make sure `archgen-mcp` is installed globally.
 *
 * @param {{env?: Record<string, string|undefined>, version?: string}} opts
 * @returns {{installed: boolean, bin: string|null, note: string}}
 */
export function ensureGlobalServer(opts = {}) {
  const { env = process.env, version = 'latest' } = opts;

  const onPath = whichOnPath(MCP_PACKAGE, env);
  if (onPath) {
    return { installed: true, bin: onPath, note: `already installed at ${onPath}` };
  }

  const spec = version === 'latest' ? MCP_PACKAGE : `${MCP_PACKAGE}@${version}`;
  const inv = npmInvocation(['install', '-g', spec], env);
  const r = spawnSync(inv.command, inv.args, {
    encoding: 'utf8',
    timeout: 300000,
    env,
    shell: inv.shell,
  });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').pop();
    return {
      installed: false,
      bin: null,
      note: `global install failed${detail ? ` (${detail})` : ''} — falling back to npx`,
    };
  }
  const bin = whichOnPath(MCP_PACKAGE, env);
  return {
    installed: Boolean(bin),
    bin,
    note: bin ? `installed globally at ${bin}` : 'installed globally',
  };
}
