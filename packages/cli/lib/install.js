// install.js — global harness-dir installer (cross-platform port of install.sh).
// Installs the archgen skill into every EXISTING harness skills dir; manifest
// records entries so --uninstall removes exactly what we put there.

import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSkillSource } from './init.js';
import { assertNotSymlink, assertWithinRoot, cliVersion, hashDir, moveToBackupInto, pruneDevOnly, refuseSymlinkMessage } from './store.js';
import { writeStamp } from './version-stamp.js';
import { loadConfig } from './config.js';

// Module-anchored default: works from the npm package (cli/lib -> cli/vendor)
// AND from a monorepo checkout (packages/cli/lib -> ../../skill) without depending on cwd.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MANIFEST_NAME = loadConfig().files.globalManifest;

// Global backup vault: global installs live OUTSIDE any project, so there is
// no project root to host `.archgen/.backup/`. Convention chosen instead: each
// harness skills dir keeps its own sibling vault at
//   <skills-dir>/.archgen-backups/<ISO-timestamp>/archgen/
// — a dot-prefixed sibling (never scanned as a skill by harnesses), colocated
// with what it protects, and discovered by lib/restore.js alongside the
// project vault.
export const GLOBAL_BACKUP_REL = '.archgen-backups';

export function globalTargets(home = homedir()) {
  return [
    join(home, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
    join(home, '.config', 'opencode', 'skills'),
    join(home, '.cursor', 'skills'),
  ];
}

function record(manifest, kind, path) {
  assertNotSymlink(manifest);
  const line = `${kind}\t${path}`;
  let dup = false;
  if (existsSync(manifest)) {
    for (const l of readFileSync(manifest, 'utf8').split('\n')) if (l === line) { dup = true; break; }
  }
  if (!dup) writeFileSync(manifest, (existsSync(manifest) ? readFileSync(manifest, 'utf8').replace(/\n*$/, '\n') : '') + line + '\n');
}

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

/** Collision-free timestamp for `<tdir>/.archgen-backups/<ts>/` (ms clock can tick twice). */
function nextBackupTs(tdir) {
  for (;;) {
    const ts = new Date().toISOString().replace(/:/g, '-');
    if (!existsSync(join(tdir, GLOBAL_BACKUP_REL, ts))) return ts;
  }
}

/**
 * @param {{copy?: boolean, home?: string, packageRoot?: string}} opts
 * @returns {{rows: Array<[string, string, string]>, failures: number, manifest: string,
 *            backups: string[]}} rows are [STATUS, MODE, PATH]; `backups` lists
 *            absolute vault locations written by this run.
 */
export function installGlobal(opts = {}) {
  const home = opts.home ?? homedir();
  if (!home) throw new Error('$HOME is not set; cannot resolve target directories.');
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  const source = resolve(resolveSkillSource(packageRoot));
  const version = cliVersion(packageRoot);
  const manifest = join(home, MANIFEST_NAME);
  const rows = [];
  const backups = [];
  let failures = 0;

  const targets = [
    ...globalTargets(home).map((d) => [d, home]),
    [join(process.cwd(), '.github', 'skills'), process.cwd()],
  ];
  for (const [tdir, base] of targets) {
    const dest = join(tdir, 'archgen');
    if (!existsSync(tdir)) { rows.push(['SKIP', '-', tdir + ' (does not exist)']); continue; }
    try {
      // Realpath-escape guard: a symlinked harness dir (e.g. ~/.claude -> /etc)
      // must not redirect the install outside the base it belongs to.
      assertWithinRoot(base, tdir);
      mkdirSync(tdir, { recursive: true }); // no-op when present
      if (opts.copy) {
        // Safety invariant: fingerprint dest BEFORE mutating; identical
        // (stamp-ignoring) skips like link mode, divergent moves into the
        // vault first — nothing is rmSync'd without a prior backup of it.
        const prev = lstatSafe(dest);
        if (prev && prev.isSymbolicLink()) {
          // A symlink at dest is only ours when it points at this source (a
          // previous link-mode install). Any other link is foreign: replacing
          // it would let a planted symlink steer the copy, so refuse.
          let linkTarget = null;
          try { linkTarget = resolve(dirname(dest), readlinkSync(dest)); } catch { /* unreadable */ }
          if (linkTarget !== source) throw new Error(refuseSymlinkMessage(dest));
        }
        let identical = false;
        if (prev && prev.isDirectory() && !prev.isSymbolicLink()) {
          try { identical = hashDir(dest) === hashDir(source); } catch { identical = false; }
        }
        if (identical) {
          stampNote(rows, dest, () => writeStamp(dest, version));
          record(manifest, 'copy', dest);
          rows.push(['SAME', 'copy', dest]);
        } else {
          if (prev) {
            const loc = moveToBackupInto(tdir, 'archgen', GLOBAL_BACKUP_REL, nextBackupTs(tdir));
            const abs = join(tdir, ...loc.split('/'));
            backups.push(abs);
            rows.push(['BACKED-UP', '-', abs]);
          }
          rmSync(dest, { force: true, recursive: true }); // no-op after a move; guards exotic-FS fallbacks
          assertNotSymlink(dest); // TOCTOU re-check: nothing may have re-linked dest between backup and copy
          cpSync(source, dest, { recursive: true });
          pruneDevOnly(dest); // dev-only artifacts (scripts/test) never reach global --copy trees
          stampNote(rows, dest, () => writeStamp(dest, version));
          record(manifest, 'copy', dest);
          rows.push(['OK', 'copy', dest]);
        }
      } else {
        let status = 'OK';
        const prev = lstatSafe(dest);
        if (prev && prev.isSymbolicLink()) {
          if (existsSync(dest)) {
            // A live link resolving anywhere but our source belongs to the
            // user: leave it untouched and OUT of the uninstall manifest, or
            // `uninstall` would later delete their link. (install.sh replaces
            // foreign links via ln -sfn — that destructive semantic is
            // deliberately NOT copied here.)
            const linkTarget = resolve(dirname(dest), readlinkSync(dest));
            if (linkTarget !== source) {
              rows.push(['KEPT', '-', dest + ' (foreign symlink, not recorded)']);
              continue;
            }
            status = 'SAME';
          } else {
            // Dangling (npx cache eviction): recreate against the current
            // source instead of leaving users broken while reporting SAME.
            unlinkSync(dest); // removes the link itself, never any target
            symlinkSync(source, dest, 'dir');
            status = 'REPAIRED';
          }
        } else if (!prev) {
          symlinkSync(source, dest, 'dir');
        } else {
          // Real directory/file at dest is NEVER clobbered: symlinkSync fails
          // with EEXIST and surfaces as FAILED below (historical behavior).
          symlinkSync(source, dest, 'dir');
        }
        // The link itself holds no bytes: the stamp must live INSIDE the real
        // directory the link resolves to (the shared copy) so a read of
        // <link>/.archgen-version sees it — true for symlinks and Windows
        // junctions alike.
        stampNote(rows, dest, () => writeStamp(source, version));
        record(manifest, 'link', dest);
        rows.push([status, 'link', dest]);
      }
    } catch (e) {
      failures++;
      rows.push(['FAILED', '-', dest + ' (' + e.message + ')']);
    }
  }
  return { rows, failures, manifest, backups };
}

/** Install succeeded even when the stamp could not be written (e.g. read-only vendor); surface it without failing. */
function stampNote(rows, dest, write) {
  try {
    write();
  } catch (e) {
    rows.push(['WARN', '-', dest + ' (installed; version stamp not written: ' + e.message + ')']);
  }
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
