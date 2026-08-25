// install.js — global harness-dir installer (cross-platform port of install.sh).
// Installs the archgen skill into every EXISTING harness skills dir; manifest
// records entries so --uninstall removes exactly what we put there.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillSource } from './init.js';

// Module-anchored default: works from the npm package (cli/lib -> cli/vendor)
// AND from a monorepo checkout (packages/cli/lib -> ../../skill) without depending on cwd.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MANIFEST_NAME = '.archgen-install-manifest.list';

function globalTargets(home = homedir()) {
  return [
    join(home, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.cursor', 'skills'),
  ];
}

function record(manifest, kind, path) {
  const line = `${kind}\t${path}`;
  let dup = false;
  if (existsSync(manifest)) {
    for (const l of readFileSync(manifest, 'utf8').split('\n')) if (l === line) { dup = true; break; }
  }
  if (!dup) writeFileSync(manifest, (existsSync(manifest) ? readFileSync(manifest, 'utf8').replace(/\n*$/, '\n') : '') + line + '\n');
}

/**
 * @param {{copy?: boolean, home?: string}} opts
 */
export function installGlobal(opts = {}) {
  const home = opts.home ?? homedir();
  if (!home) throw new Error('$HOME is not set; cannot resolve target directories.');
  const source = resolve(resolveSkillSource(opts.packageRoot ?? PACKAGE_ROOT));
  const manifest = join(home, MANIFEST_NAME);
  const rows = [];
  let failures = 0;

  const targets = [...globalTargets(home), join(process.cwd(), '.github', 'skills')];
  for (const tdir of targets) {
    const dest = join(tdir, 'archgen');
    if (!existsSync(tdir)) { rows.push(['SKIP', '-', tdir + ' (does not exist)']); continue; }
    try {
      mkdirSync(tdir, { recursive: true }); // no-op when present
      if (opts.copy) {
        rmSync(dest, { force: true, recursive: true });
        cpSync(source, dest, { recursive: true });
        record(manifest, 'copy', dest);
        rows.push(['OK', 'copy', dest]);
      } else {
        let same = false;
        try { same = lstatSync(dest).isSymbolicLink(); } catch { /* absent */ }
        if (!same) symlinkSync(source, dest, 'dir');
        record(manifest, 'link', dest);
        rows.push([same ? 'SAME' : 'OK', 'link', dest]);
      }
    } catch (e) {
      failures++;
      rows.push(['FAILED', '-', dest + ' (' + e.message + ')']);
    }
  }
  return { rows, failures, manifest };
}

export function uninstallGlobal(home = homedir()) {
  const manifest = join(home, MANIFEST_NAME);
  if (!existsSync(manifest)) return { removed: 0, failed: 0, noop: true };
  let removed = 0, failed = 0;
  for (const line of readFileSync(manifest, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [kind, p] = line.split('\t');
    if (!p || !p.endsWith(join('skills', 'archgen'))) { failed++; continue; } // safety guard
    try { rmSync(p, { force: true, recursive: true }); removed++; }
    catch { failed++; }
  }
  rmSync(manifest, { force: true });
  return { removed, failed, noop: false };
}
