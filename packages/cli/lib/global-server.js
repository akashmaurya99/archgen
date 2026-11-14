// global-server.js — ONE archgen MCP server for every harness, kept current.
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
// THE UPGRADE.
//
// The CLI and the server are released TOGETHER, so the CLI knows exactly
// which server version it was tested against. An installed server that is
// OLDER is refreshed to that version; one that is NEWER (a dev build, or a
// version published after this CLI) is left alone — downgrading it would
// break a working setup.
//
// The install is BEST EFFORT. A machine without a writable npm prefix, an
// offline machine, or a user who does not want a global package must still
// get a working skill install: the npx fallback covers all of them, and the
// OLD server keeps working until it is replaced.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { npmInvocation, whichOnPath, globalInstallEnv } from './spawn-npm.js';
import { compareSemver } from './version.js';

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
 * The version of an INSTALLED server, read from its own package.
 *
 * The binary is a symlink into the global package's bin directory, so the
 * package root is one level above the script's directory.
 *
 * @param {string} bin the resolved executable
 * @returns {string|null} the version, or null when it cannot be read
 */
export function installedServerVersion(bin) {
  try {
    const real = realpathSync(bin);
    const pkg = JSON.parse(readFileSync(join(dirname(real), '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Make sure `archgen-mcp` is installed globally, at the right version.
 *
 * @param {{env?: Record<string, string|undefined>, version?: string}} opts
 * @returns {{installed: boolean, bin: string|null, upgraded: boolean,
 *   note: string, detail?: string}}
 */
export function ensureGlobalServer(opts = {}) {
  const { env = process.env, version = 'latest' } = opts;

  const onPath = whichOnPath(MCP_PACKAGE, env);
  if (onPath) {
    const installed = installedServerVersion(onPath);
    if (installed === version) {
      return {
        installed: true,
        bin: onPath,
        upgraded: false,
        note: `already installed at ${onPath} (v${installed})`,
      };
    }
    if (installed && version !== 'latest' && compareSemver(installed, version) > 0) {
      // A newer server is already there — a dev build, or a release published
      // after this CLI. Downgrading it would break a working setup.
      return {
        installed: true,
        bin: onPath,
        upgraded: false,
        note: `installed v${installed} is newer than this CLI's v${version} — left as it is`,
      };
    }
    const refreshed = installGlobal(version, env);
    if (refreshed.installed) {
      return {
        installed: true,
        bin: refreshed.bin,
        upgraded: true,
        note: `upgraded the archgen MCP server to v${version} at ${refreshed.bin}`,
      };
    }
    // The upgrade failed — the OLD server still works, so keep it and say so.
    return {
      installed: true,
      bin: onPath,
      upgraded: false,
      note: `could not upgrade the archgen MCP server to v${version} — the installed v${installed} stays`,
      detail: refreshed.detail,
    };
  }

  const fresh = installGlobal(version, env);
  return {
    installed: fresh.installed,
    bin: fresh.bin,
    upgraded: false,
    note: fresh.installed
      ? `installed the archgen MCP server globally at ${fresh.bin}`
      : `could not install the archgen MCP server globally — the npx fallback will be used`,
    detail: fresh.detail,
  };
}

/** `npm install -g archgen-mcp@<version>`. */
function installGlobal(version, env) {
  const spec = version === 'latest' ? MCP_PACKAGE : `${MCP_PACKAGE}@${version}`;
  // The GLOBAL prefix, not the one npm inherited from the script that
  // launched us: under `npm --prefix …` or `npx`, npm_config_prefix points
  // at a local tree, and a global install would land THERE — invisible to
  // every later run.
  const installEnv = globalInstallEnv(env);
  const inv = npmInvocation(['install', '-g', spec], installEnv);
  const r = spawnSync(inv.command, inv.args, {
    encoding: 'utf8',
    timeout: 300000,
    env: installEnv,
    shell: inv.shell,
  });
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || '').trim().split('\n').pop();
    return { installed: false, bin: null, detail: detail || `npm exited ${r.status}` };
  }
  // npm succeeded — but the install only COUNTS if the binary is now
  // findable. A prefix that is not on PATH, or a package that shipped no
  // bin, would otherwise be reported as a success.
  const bin = whichOnPath(MCP_PACKAGE, env);
  return bin
    ? { installed: true, bin, detail: undefined }
    : { installed: false, bin: null, detail: 'npm reported success but the binary is not on PATH' };
}
