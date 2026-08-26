// restore.js — recovery tooling for archgen backups.
//
// Backups live in two vaults:
//   project: <projectRoot>/.archgen/.backup/<ts>/<relpath…>   (written by init)
//   global:  <skills-dir>/.archgen-backups/<ts>/archgen        (written by install --copy)
//
// restoreBackups() discovers both, lists snapshots deterministically, and
// restores a chosen snapshot by copying each entry back to its original path.
// Safety invariant: the CURRENT state of every about-to-be-overwritten path is
// moved into a fresh safety snapshot FIRST — a restore never destroys anything
// without a prior backup of it. Restores themselves land atomically
// (temp-sibling dir, then rename).

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { BACKUP_ROOT_REL, moveToBackupInto } from './store.js';
import { GLOBAL_BACKUP_REL, globalTargets } from './install.js';

function toPosix(p) {
  return p.split('\\').join('/');
}

function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

function summarize(dir) {
  let files = 0;
  let dirs = 0;
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { dirs++; walk(join(d, e.name)); } else { files++; }
    }
  })(dir);
  const topLevel = readdirSync(dir).sort(byName);
  return { files, dirs, topLevel };
}

function snapshotsUnder(origin, base, vaultAbs) {
  if (!existsSync(vaultAbs)) return [];
  return readdirSync(vaultAbs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort(byName)
    .reverse()
    .map((ts) => {
      const snapshotDir = join(vaultAbs, ts);
      let summary = null;
      try { summary = summarize(snapshotDir); } catch { summary = { files: 0, dirs: 0, topLevel: [] }; }
      return { id: ts, ts, origin, base, snapshotDir, summary };
    });
}

/**
 * Discover backup snapshots in both vaults.
 * @param {{projectRoot?: string|null, home?: string, includeGlobal?: boolean}} opts
 * @returns {Array<{id: string, ts: string, origin: 'project'|'global', base: string,
 *            snapshotDir: string, summary: {files: number, dirs: number, topLevel: string[]}}>}
 *   Sorted newest-first, project before global (deterministic order).
 */
export function discoverSnapshots(opts = {}) {
  const home = opts.home ?? homedir();
  const out = [];
  if (opts.projectRoot) {
    out.push(...snapshotsUnder('project', resolve(opts.projectRoot), join(resolve(opts.projectRoot), ...BACKUP_ROOT_REL.split('/'))));
  }
  if (opts.includeGlobal !== false) {
    for (const tdir of globalTargets(home)) {
      out.push(...snapshotsUnder('global', tdir, join(tdir, GLOBAL_BACKUP_REL)));
    }
  }
  return out.sort((a, b) => (a.ts === b.ts ? byName(a.origin + a.base, b.origin + b.base) : a.ts < b.ts ? 1 : -1));
}

/**
 * List backups under a project root and the global harness dirs.
 * @param {string} projectRoot project root to scan (may be '' when unused)
 * @param {{home?: string, includeGlobal?: boolean}} options
 */
export function listBackups(projectRoot, options = {}) {
  return discoverSnapshots({ projectRoot: projectRoot || null, home: options.home, includeGlobal: options.includeGlobal });
}

function uniqueSafetyTs(base, backupRootRel) {
  for (;;) {
    const ts = new Date().toISOString().replace(/:/g, '-');
    if (!existsSync(join(base, ...backupRootRel.split('/'), ts))) return ts;
  }
}

/** Atomic copy-back: temp sibling dir, then rename into place. */
function layDown(srcAbs, destAbs) {
  mkdirSync(dirname(destAbs), { recursive: true });
  const tmp = join(dirname(destAbs), '.archgen-restore-' + randomBytes(6).toString('hex'));
  cpSync(srcAbs, tmp, { recursive: true });
  renameSync(tmp, destAbs);
}

/**
 * Restore backups discovered across the project and global vaults.
 *
 * @param {string} projectRoot project root to scan (used for listing; may be ''
 *   when only global snapshots are wanted)
 * @param {{list?: boolean, snapshot?: string, target?: string, home?: string,
 *   includeGlobal?: boolean}} options
 *   - `list` (default true): dry-run discovery, returns `snapshots`.
 *   - `snapshot`: timestamp id to restore (takes precedence over `list`).
 *     Ambiguous ids (same ts in several vaults) must be narrowed via
 *     `includeGlobal:false` or an exact single match.
 *   - `target`: restore INTO this directory instead of the recorded origin
 *     (entries keep their layout relative to it).
 * @returns {{action: 'list'|'restored', snapshots?: Array<object>,
 *            restored?: Array<{from: string, to: string}>,
 *            safetyBackups?: Array<{rel: string, abs: string}>, warnings: string[]}}
 */
export function restoreBackups(projectRoot, options = {}) {
  const warnings = [];
  const all = discoverSnapshots({
    projectRoot,
    home: options.home,
    includeGlobal: options.includeGlobal !== false,
  });

  if (!options.snapshot) {
    return { action: 'list', snapshots: all, warnings };
  }

  const matches = all.filter((s) => s.ts === options.snapshot || s.id === options.snapshot);
  if (matches.length === 0) {
    throw new Error(`no backup snapshot '${options.snapshot}' found (run with list mode to see available ids)`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous snapshot '${options.snapshot}' exists in ${matches.length} vaults; narrow the scope`);
  }
  const snap = matches[0];

  const destBase = options.target ? resolve(options.target) : snap.base;
  const entries = readdirSync(snap.snapshotDir, { withFileTypes: true })
    .map((e) => e.name)
    .sort(byName)
    .map((name) => ({ name, srcAbs: join(snap.snapshotDir, name), destAbs: join(destBase, name) }));

  // Pass 1 — safety: move EVERY existing destination aside before laying down
  // anything, so a mid-restore failure still leaves current state fully backed up.
  const safetyBackups = [];
  const safetyRootRel = snap.origin === 'global' ? GLOBAL_BACKUP_REL : BACKUP_ROOT_REL;
  const safetyBase = snap.origin === 'global' ? snap.base : destBase;
  const safetyTs = uniqueSafetyTs(safetyBase, safetyRootRel);
  for (const en of entries) {
    if (!lstatSafe(en.destAbs)) continue;
    const rel = snap.origin === 'global' ? en.name : toPosix(relative(destBase, en.destAbs));
    const loc = moveToBackupInto(safetyBase, rel, safetyRootRel, safetyTs);
    const abs = join(safetyBase, ...loc.split('/'));
    safetyBackups.push({ rel: loc, abs });
  }

  // Pass 2 — copy back atomically.
  const restored = [];
  for (const en of entries) {
    try {
      layDown(en.srcAbs, en.destAbs);
      restored.push({ from: en.srcAbs, to: en.destAbs });
    } catch (e) {
      warnings.push(`could not restore ${en.name}: ${e.message}`);
    }
  }

  return { action: 'restored', snapshot: snap, restored, safetyBackups, warnings };
}

function parseFlags(argv) {
  const opts = { list: true, snapshot: null, project: null, global: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--snapshot') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { error: '--snapshot requires a timestamp argument' };
      opts.snapshot = v;
    } else if (a === '--project') {
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : process.cwd();
      opts.project = v;
    } else if (a === '--global') opts.global = true;
    else if (a === '--yes') opts.yes = true; // accepted for CLI ergonomics; restore is interactive-free
    else return { error: `unknown flag: ${a}` };
  }
  return opts;
}

/**
 * CLI entry point (`archgen-skill restore …`). Interactive-free and
 * deterministic; never prompts. Exit codes: 0 success/listing, 1 on errors.
 * @param {string[]} argv flags after the command name
 * @returns {Promise<number>} exit code
 */
export async function restoreMain(argv) {
  const parsed = parseFlags(argv);
  if (parsed.error) {
    console.error('archgen restore: ' + parsed.error);
    return 1;
  }
  const { list, snapshot, project, global: wantGlobal, yes } = parsed;
  void yes;

  const scope = {
    projectRoot: wantGlobal ? null : (project ?? process.cwd()),
    includeGlobal: !project || wantGlobal,
  };

  try {
    if (!snapshot) {
      const snapshots = listBackups(scope.projectRoot ?? '', { includeGlobal: scope.includeGlobal });
      console.log(`archgen restore — ${snapshots.length} backup snapshot(s) found`);
      for (const s of snapshots) {
        const names = s.summary.topLevel.length ? s.summary.topLevel.join(', ') : '(empty)';
        console.log(`  ${s.ts}  [${s.origin}]  ${s.base}  (${s.summary.files} file(s), ${s.summary.dirs} dir(s): ${names})`);
      }
      console.log('Dry-run listing only. Pass --snapshot <ts> to restore.');
      return 0;
    }

    const r = restoreBackups(scope.projectRoot ?? '', { snapshot, includeGlobal: scope.includeGlobal });
    console.log(`archgen restore — restoring ${snapshot} [${r.snapshot.origin}]`);
    for (const sb of r.safetyBackups) console.log(`  ~ safety backup of current state: ${sb.abs}`);
    for (const en of r.restored) console.log(`  + restored ${en.to}`);
    for (const w of r.warnings) console.error('  ! ' + w);
    console.log(`Done: ${r.restored.length} path(s) restored, ${r.safetyBackups.length} safety backup(s).`);
    return r.warnings.length > 0 ? 1 : 0;
  } catch (e) {
    console.error('archgen restore: ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
}
