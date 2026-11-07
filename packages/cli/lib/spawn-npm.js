// spawn-npm.js — run npm on every platform without a shell.
// An unshelled spawnSync("npm", …) fails with EINVAL on Windows since the
// CVE-2024-27980 hardening, so npm's JS entry point is invoked with the
// current node binary instead.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** npm-cli.js path: `npm_execpath` first, then node-relative layouts. */
export function npmCliPath(env = process.env) {
  const fromEnv = env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js') && existsSync(fromEnv)) {
    return fromEnv;
  }
  const dir = dirname(process.execPath);
  const candidates =
    process.platform === 'win32'
      ? [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] // Windows: node.exe sits beside node_modules/
      : [join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]; // POSIX: bin/../lib/...
  for (const c of candidates) if (existsSync(c)) return c;
  // Homebrew cellar layout: /opt/homebrew/{bin,lib}/...
  if (process.platform !== 'win32') {
    const brew = join(dir, '..', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(brew)) return brew;
  }
  return null;
}

/**
 * Spawn npm with { command, args, shell }. Args MUST be registry-verified
 * constants (the shell fallback on Windows interpolates them).
 */
export function npmInvocation(npmArgs, env = process.env) {
  const cli = npmCliPath(env);
  if (cli) return { command: process.execPath, args: [cli, ...npmArgs], shell: false };
  const isWin = process.platform === 'win32';
  return { command: isWin ? 'npm.cmd' : 'npm', args: npmArgs, shell: isWin };
}

/**
 * Cross-platform `which` (PATHEXT on Windows).
 *
 * The env is a PARAMETER, not an assumption: a caller may be searching a
 * modified PATH (a test, a sandboxed HOME), and reading process.env behind
 * its back would answer a different question than the one asked.
 *
 * @param {string} bin
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function whichOnPath(bin, env = process.env) {
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  const dirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      try {
        if (existsSync(p)) return p;
      } catch { /* next */ }
    }
  }
  return null;
}

/**
 * The global npm prefix — where `npm install -g` puts its binaries.
 * @returns {string|null} null when npm cannot be queried
 */
export function npmGlobalPrefix(env = process.env) {
  try {
    const inv = npmInvocation(['prefix', '-g'], env);
    const r = spawnSync(inv.command, inv.args, {
      encoding: 'utf8',
      timeout: 15000,
      shell: inv.shell,
      env,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim().split(/\r?\n/).pop() || null;
  } catch {
    return null;
  }
}

/**
 * The path of a globally-installed npm binary.
 *
 * A PATH search returns the FIRST match, which is often an OLD global
 * install shadowing the one npm just wrote — so the global prefix (the
 * directory npm actually installs into) is consulted first.
 *
 * @param {string} name binary name, e.g. 'archgen-skill'
 * @returns {string|null}
 */
export function globalBinPath(name, env = process.env, platform = process.platform) {
  const prefix = npmGlobalPrefix(env);
  if (!prefix) return null;
  const candidates = platform === 'win32'
    ? [join(prefix, name + '.cmd'), join(prefix, name)]
    : [join(prefix, 'bin', name)];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch { /* next */ }
  }
  return null;
}
