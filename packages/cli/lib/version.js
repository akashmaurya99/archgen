// version.js — semver compare + npm registry lookup (zero deps).
import { spawnSync } from 'node:child_process';
import { npmInvocation } from './spawn-npm.js';

export function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/**
 * Compare two semver strings.
 *
 * @returns {number|null} -1 / 0 / 1, or null when either side is not a
 *   semver. An unparseable version is NOT "equal" to anything: reporting 0
 *   would make a registry tag like "beta" read as "already up to date" and
 *   silently skip the caller's refusal path.
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

export function fetchLatestVersion(pkg) {
  // Registry-verified constant in every caller; refuse anything else outright.
  if (!/^[a-z0-9@][a-z0-9._/-]*$/i.test(String(pkg ?? ''))) return null;
  try {
    const inv = npmInvocation(['view', String(pkg), 'version']);
    const r = spawnSync(inv.command, inv.args, { encoding: 'utf8', timeout: 15000, shell: inv.shell });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim().split(/\r?\n/).pop() || null;
  } catch {
    return null;
  }
}
