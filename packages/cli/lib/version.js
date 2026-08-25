// version.js — semver compare + npm registry lookup (zero deps).
import { spawnSync } from 'node:child_process';

export function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

export function fetchLatestVersion(pkg) {
  const r = spawnSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim().split(/\r?\n/).pop() || null;
}
