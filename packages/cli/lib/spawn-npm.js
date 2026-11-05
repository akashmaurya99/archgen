// spawn-npm.js — run npm on every platform without a shell.
// An unshelled spawnSync("npm", …) fails with EINVAL on Windows since the
// CVE-2024-27980 hardening, so npm's JS entry point is invoked with the
// current node binary instead.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** npm-cli.js path: `npm_execpath` first, then node-relative layouts. */
export function npmCliPath() {
  const fromEnv = process.env.npm_execpath;
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
export function npmInvocation(npmArgs) {
  const cli = npmCliPath();
  if (cli) return { command: process.execPath, args: [cli, ...npmArgs], shell: false };
  const isWin = process.platform === 'win32';
  return { command: isWin ? 'npm.cmd' : 'npm', args: npmArgs, shell: isWin };
}

/** Cross-platform `which` (PATHEXT on Windows). */
export function whichOnPath(bin) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
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
