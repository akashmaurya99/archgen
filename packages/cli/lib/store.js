// store.js — shared primitives for the single-store project layout.
//
// Layout (all paths relative to the project root):
//   .agents/skills/archgen            canonical store (the ONLY real copy)
//   .agents/skills/archgen/.archgen-version  CLI version stamp (rewritten every init)
//   .claude/skills/archgen            RELATIVE symlink -> ../../.agents/skills/archgen
//   .archgen/.install-manifest.json   manifest of everything archgen created
//   .archgen/.backup/<timestamp>/     divergent copies moved aside before replace
//
// Safety rails:
// - hashDir() fingerprints a tree (stable-order walk of relpaths + contents,
//   sha256) so mutations only ever happen after verifying ownership/divergence;
// - GUARDED_RELPATHS (.claude, .agents, .claude/skills, .agents/skills) are
//   never deleted: parent pruning stops before touching those levels.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';

export const STORE_REL = '.agents/skills/archgen';
export const CLAUDE_LINK_REL = '.claude/skills/archgen';

// Filenames routed through the canonical config (STORE_REL/CLAUDE_LINK_REL
// stay literal: they are path semantics, not config).
const CONFIG_FILES = loadConfig().files;
export const MANIFEST_REL = '.archgen/' + CONFIG_FILES.projectManifest;
export const BACKUP_ROOT_REL = '.archgen/' + CONFIG_FILES.backupDir;
export const VERSION_FILE = CONFIG_FILES.stamp;

const GUARDED_RELPATHS = new Set(['.claude', '.agents', '.claude/skills', '.agents/skills']);

/** Version string of this CLI package (used for the in-store stamp). */
export function cliVersion(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}

function byName(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable-order directory fingerprint: sha256 over sorted relpaths plus file
 * contents (symlinks hashed via their targets). Deterministic across machines.
 * The version stamp is ALWAYS ignored on both sides of a comparison: it is
 * CLI metadata written at destination time (global symlink installs stamp the
 * shared real copy), never skill content, so it must not read as divergence.
 * @param {string} dir absolute directory to hash
 * @param {{ignore?: string[]}} opts EXTRA relpaths to skip
 */
export function hashDir(dir, opts = {}) {
  const ignore = new Set([VERSION_FILE, ...(opts.ignore ?? [])]);
  const hash = createHash('sha256');
  (function walk(abs, rel) {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ignore.has(r)) continue;
      const p = join(abs, ent.name);
      if (ent.isSymbolicLink()) hash.update('l ' + r + ' -> ' + readlinkSync(p) + '\n');
      else if (ent.isDirectory()) { hash.update('d ' + r + '\n'); walk(p, r); }
      else { hash.update('f ' + r + '\0'); hash.update(readFileSync(p)); hash.update('\n'); }
    }
  })(dir, '');
  return hash.digest('hex');
}

/** Load `.archgen/.install-manifest.json`; null when absent/corrupt. */
export function loadManifest(root) {
  const p = join(root, ...MANIFEST_REL.split('/'));
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

export function saveManifest(root, manifest) {
  const p = join(root, ...MANIFEST_REL.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
}

/** Record a created dir/link/block; dedupes on kind+path. */
export function appendEntry(root, kind, relPath) {
  const now = new Date().toISOString();
  const m = loadManifest(root) ?? { version: 1, createdAt: now, entries: [] };
  if (!Array.isArray(m.entries)) m.entries = [];
  if (m.entries.some((e) => e && e.kind === kind && e.path === relPath)) return;
  m.version = m.version ?? 1;
  m.createdAt = m.createdAt ?? now;
  m.entries.push({ kind, path: relPath, createdAt: now });
  saveManifest(root, m);
}

/**
 * Move an existing path into `<root>/<backupRootRel>/<ts>/<relPath>`, preserving
 * the relative layout so backups restore unambiguously. Generalized core shared
 * by the project vault (.archgen/.backup) and the global vault
 * (<skills-dir>/.archgen-backups); `ts` can be injected so one operation lands
 * every entry under a single timestamp.
 * @returns {string} backup location relative to `root`
 */
export function moveToBackupInto(root, relPath, backupRootRel, ts = new Date().toISOString().replace(/:/g, '-')) {
  const destRel = backupRootRel + '/' + ts + '/' + relPath;
  const destAbs = join(root, ...destRel.split('/'));
  mkdirSync(dirname(destAbs), { recursive: true });
  const srcAbs = join(root, ...relPath.split('/'));
  try {
    renameSync(srcAbs, destAbs);
  } catch {
    cpSync(srcAbs, destAbs, { recursive: true });
    rmSync(srcAbs, { recursive: true, force: true });
  }
  return destRel;
}

/** Project-root flavor: move `relPath` under `.archgen/.backup/<ts>/<relPath>`. */
export function moveToBackup(root, relPath) {
  return moveToBackupInto(root, relPath, BACKUP_ROOT_REL);
}

export function rmIfExists(absPath) {
  let st = null;
  try { st = lstatSync(absPath); } catch { /* absent */ }
  if (!st) return false;
  rmSync(absPath, { force: true, recursive: st.isDirectory() && !st.isSymbolicLink() });
  return true;
}

/**
 * Walk UPWARD from relPath removing directories only while they are left
 * completely empty by our removals. Stops at guarded levels and the root —
 * `.claude`, `.agents`, `.claude/skills`, `.agents/skills` are never deleted.
 */
export function pruneEmptyParents(root, relPath) {
  let cur = relPath;
  while (cur && cur !== '.') {
    if (GUARDED_RELPATHS.has(cur)) break;
    const abs = join(root, ...cur.split('/'));
    let empty = false;
    try { empty = readdirSync(abs).length === 0; } catch { break; }
    if (!empty) break;
    rmSync(abs, { recursive: true, force: true });
    const parent = dirname(cur);
    cur = parent === '.' ? '' : parent;
  }
}
