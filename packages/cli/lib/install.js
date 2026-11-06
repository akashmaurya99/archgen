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
import { bootstrapServers } from './bootstrap.js';

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
 * @param {{copy?: boolean, home?: string, packageRoot?: string, codegraph?: boolean, mcp?: boolean, log?: (s: string) => void, env?: NodeJS.ProcessEnv}} opts
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
  // Server bootstrap — GLOBAL wiring only (project-local configs belong to
  // `init`). Wires the archgen MCP server and CodeGraph into every DETECTED
  // global harness. Non-fatal: an offline machine still gets the skill
  // installed.
  if (opts.codegraph !== false || opts.mcp !== false) {
    const r = bootstrapServers({
      projectDir: process.cwd(),
      location: 'global',
      log: opts.log ?? console.log,
      env: opts.env,
      noCodegraph: opts.codegraph === false,
      noMcp: opts.mcp === false,
    });
    if (!r.ok) {
      rows.push(['WARN', '-', 'server bootstrap incomplete' + (r.detail ? ` (${r.detail})` : '') + ' — run: npx archgen-mcp bootstrap --location global --yes']);
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

/**
 * The exact destinations a global install may create.
 *
 * A manifest entry is acted on ONLY when it names one of them. A plain
 * suffix test (`endsWith('skills/archgen')`) would let any path with that
 * ending be removed — including paths outside the known harness dirs.
 */
function allowedGlobalDestinations(home) {
  const set = new Set(globalTargets(home).map((d) => resolve(join(d, 'archgen'))));
  set.add(resolve(join(process.cwd(), '.github', 'skills', 'archgen')));
  return set;
}

/**
 * Move an edited copy-mode install into the global backup vault before it is
 * removed: the uninstall must never be the last place those edits exist.
 * An install that still matches the packaged skill needs no backup.
 */
function backupEditedCopy(dest, packageRoot, backups) {
  let identical = false;
  try {
    identical = hashDir(dest) === hashDir(resolveSkillSource(packageRoot));
  } catch {
    identical = false; // unverifiable -> preserve it
  }
  if (identical) return;
  const tdir = dirname(dest);
  const loc = moveToBackupInto(tdir, 'archgen', GLOBAL_BACKUP_REL, nextBackupTs(tdir));
  backups.push(join(tdir, ...loc.split('/')));
}

/**
 * Remove the globally-installed copies recorded in the manifest.
 *
 * Only entries that name a known harness destination are removed. An entry
 * that cannot be verified is SKIPPED and KEPT in the manifest — the manifest
 * is only removed when nothing was left behind.
 *
 * @param {string} home home directory holding the manifest
 * @param {{packageRoot?: string}} opts
 */
export function uninstallGlobal(home = homedir(), opts = {}) {
  const manifest = join(home, MANIFEST_NAME);
  if (!existsSync(manifest)) return { removed: 0, failed: 0, noop: true };
  const packageRoot = opts.packageRoot ?? PACKAGE_ROOT;
  const allowed = allowedGlobalDestinations(home);
  let removed = 0, failed = 0;
  const kept = [];
  const backups = [];
  for (const line of readFileSync(manifest, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [kind, p] = line.split('\t');
    if (!p || !allowed.has(resolve(p))) { failed++; kept.push(line); continue; } // safety guard
    try {
      if (kind === 'copy') backupEditedCopy(p, packageRoot, backups);
      rmSync(p, { force: true, recursive: true }); removed++;
    } catch { failed++; kept.push(line); }
  }
  if (kept.length === 0) {
    try { rmSync(manifest, { force: true }); } catch { failed++; }
  } else {
    // The skipped entries stay recorded: the manifest is the only thing that
    // knows they were never removed.
    try { writeFileSync(manifest, kept.join('\n') + '\n'); } catch { failed++; }
  }
  return { removed, failed, noop: false, backups };
}
