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
//   never deleted: parent pruning stops before touching those levels;
// - assertNotSymlink()/assertWithinRoot() lstat BEFORE every write: a
//   symlinked target (supply-chain attack: a malicious clone shipping
//   .agents/skills/archgen or AGENTS.md as a link to an unrelated directory)
//   is refused instead of written through.

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';

export const STORE_REL = '.agents/skills/archgen';
export const CLAUDE_LINK_REL = '.claude/skills/archgen';

// Filenames routed through the canonical config (STORE_REL/CLAUDE_LINK_REL
// stay literal: they are path semantics, not config).
const CONFIG_FILES = loadConfig().files;
export const MANIFEST_REL = '.archgen/' + CONFIG_FILES.projectManifest;
export const BACKUP_ROOT_REL = '.archgen/' + CONFIG_FILES.backupDir;
export const VERSION_FILE = CONFIG_FILES.stamp;

/**
 * Name of the sidecar that records WHICH paths a backup snapshot holds.
 *
 * A snapshot's directory layout alone does not say what was backed up: the
 * tree `<ts>/.agents/skills/archgen` and the tree `<ts>/archgen` are the same
 * shape at different depths, and restoring the snapshot's top-level directory
 * would replace a whole `.agents/` tree — every sibling skill with it. The
 * record names the exact paths, so a restore puts back exactly those and
 * leaves siblings alone.
 */
export const BACKUP_PATHS_FILE = '.archgen-backup-paths.json';

const GUARDED_RELPATHS = new Set(['.claude', '.agents', '.claude/skills', '.agents/skills']);

/**
 * Dev-only skill subtrees that must NEVER be distributed to end users. The
 * repo's own node:test suite (scripts/test) is repo-only CI tooling: nothing
 * imports it at runtime and it references repo-only fixtures
 * (fixtures/yaml-corpus), so it cannot run in an installed project — shipping
 * it into installed stores or the npm payload is dead weight. It is excluded
 * consistently from the vendor mirror, every installed-store copy, and BOTH
 * sides of hashDir comparisons (so its presence/absence never reads as drift).
 * scripts/lib is deliberately NOT here — it is a runtime dependency of the
 * skill scripts (imported by next-tasks/plan-graph/set-status/doc-index/etc).
 */
export const DEV_ONLY_RELPATHS = ['scripts/test'];

/**
 * Subtrees that the CURRENT packaged skill no longer ships.
 *
 * The skill used to ship a `scripts/` tree (11 scripts + a lib/ folder). It
 * does any more — every capability moved into the archgen MCP server. An
 * existing install still carries that tree, and it is dead weight: nothing
 * reads it, and it makes the store hash as DIVERGED from the packaged skill.
 *
 * Pruning it is a MIGRATION, not a repair: the tree is ours (it shipped in a
 * previous version), so removing it is safe. It is never removed from a store
 * whose packaged skill still ships the same path — the check is always
 * "packaged skill has no such directory".
 */
export const OBSOLETE_RELPATHS = ['scripts'];

/**
 * The subtrees the packaged skill no longer ships that are still present in
 * an installed tree (report-only — nothing is touched).
 *
 * @param {string} absRoot the installed skill tree
 * @param {string} packagedRoot the packaged (vendor) skill tree
 * @returns {string[]} the relpaths that are obsolete
 */
export function findObsolete(absRoot, packagedRoot) {
  const found = [];
  for (const rel of OBSOLETE_RELPATHS) {
    if (existsSync(join(packagedRoot, ...rel.split('/')))) continue; // still shipped — not obsolete
    if (!existsSync(join(absRoot, ...rel.split('/')))) continue;
    found.push(rel);
  }
  return found;
}

/**
 * Remove the subtrees the packaged skill no longer ships.
 *
 * @param {string} absRoot the installed skill tree
 * @param {string} packagedRoot the packaged (vendor) skill tree
 * @returns {string[]} the relpaths actually removed
 */
export function pruneObsolete(absRoot, packagedRoot) {
  const removed = [];
  for (const rel of findObsolete(absRoot, packagedRoot)) {
    rmSync(join(absRoot, ...rel.split('/')), { recursive: true, force: true });
    removed.push(rel);
  }
  return removed;
}

/** True when relpath `r` is (or lives inside) a dev-only excluded subtree. */
function isDevOnlyRelPath(r) {
  for (const prefix of DEV_ONLY_RELPATHS) {
    if (r === prefix || r.startsWith(prefix + '/')) return true;
  }
  return false;
}

/** Canonical refusal message for every symlink-write guard (CLI + install.sh). */
export function refuseSymlinkMessage(absPath) {
  return 'Refusing to write through symlink at ' + absPath + ' — use --copy or remove symlink';
}

/**
 * Supply-chain guard: lstat (never stat — the LINK itself, not its target) a
 * path before writing it. Absent paths pass (safe to create); a symlink at
 * the target throws so no write can ever be redirected through the link.
 */
export function assertNotSymlink(absPath) {
  let st = null;
  try { st = lstatSync(absPath); } catch { return; }
  if (st.isSymbolicLink()) throw new Error(refuseSymlinkMessage(absPath));
}

/**
 * Resolve `p` to the real location of its nearest existing ancestor, keeping
 * the not-yet-existing tail as lexical segments.
 *
 * `realpathSync` cannot answer for a path that does not exist yet, but the
 * guard must still work before anything is created (init's very first run) —
 * so the tail is appended to the resolved ancestor instead of being dropped.
 *
 * @param {string} p absolute path
 * @returns {string|null} resolved path, or null when nothing could be resolved
 */
function realpathWithTail(p) {
  const tail = [];
  let probe = resolve(p);
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length ? join(real, ...tail) : real;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return null;
      const parent = dirname(probe);
      if (parent === probe) return null;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Realpath-escape guard: refuse when the real location of `absPath` lands
 * outside `rootAbs`. Catches `.agents -> /elsewhere` style redirects that a
 * final-component lstat cannot see.
 *
 * TWO COMPARISONS, AND THE PATH IS ALLOWED IF EITHER SAYS IT IS INSIDE.
 *
 *   1. LEXICAL — the caller's spelling against the root's spelling.
 *   2. REAL — where the path actually LANDS against where the root actually
 *      IS. This is the one that catches a symlinked PARENT.
 *
 * They can disagree, and they DO whenever the root and the path are spelled
 * differently — the NORMAL case on macOS (`/tmp`, `/var`) and for any
 * symlinked project: `process.cwd()` is the REAL path while the caller
 * passes the LOGICAL one.
 *
 * The old guard compared the LEXICAL path against the REAL root and refused
 * on that mismatch, so a perfectly valid path inside the project was
 * reported as an escape — and the two names the SAME place. The real
 * comparison is the one that can actually answer the question, and it must
 * be allowed to.
 *
 * The guard does NOT fail open: when the real comparison cannot be made the
 * lexical one stands alone, and a path outside the root by every measure we
 * could make is always refused.
 *
 * @param {string} rootAbs project/base root
 * @param {string} absPath path that must stay inside the root
 */
export function assertWithinRoot(rootAbs, absPath) {
  const rootLex = resolve(rootAbs);
  const pathLex = resolve(absPath);

  const rootReal = realpathWithTail(rootLex);
  const pathReal = realpathWithTail(pathLex);

  const lexicalInside = pathLex === rootLex || pathLex.startsWith(rootLex + sep);
  const realInside =
    rootReal && pathReal ? pathReal === rootReal || pathReal.startsWith(rootReal + sep) : null;

  if (realInside === true || (realInside === null && lexicalInside)) return;

  // Outside by every measure we could make. The refusal WORDING is unchanged
  // from the guard this replaces — it is the CLI's established contract, and
  // a test pins it. Only the COMPARISON changed.
  throw new Error(refuseSymlinkMessage(absPath));
}

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
 * DEV_ONLY_RELPATHS (scripts/test) are ALSO always ignored on both sides: they
 * are pruned from every distributed copy, so a source tree that still carries
 * them (the dev-checkout skill/ fallback) must hash equal to an installed store
 * that does not — while a real edit anywhere else must still read as divergence.
 * @param {string} dir absolute directory to hash
 * @param {{ignore?: string[]}} opts EXTRA relpaths to skip
 */
export function hashDir(dir, opts = {}) {
  const ignore = new Set([VERSION_FILE, ...(opts.ignore ?? [])]);
  const hash = createHash('sha256');
  // A directory contributes its marker ONLY when its subtree contributes
  // something. Without this, a directory holding nothing but excluded
  // dev-only content hashed a 'd <rel>' marker on one side and nothing on the
  // other — the two trees then read as divergent even though they are
  // identical once the exclusions are applied.
  //
  // File contents are hashed as BYTES, never as strings: a lossy string
  // round-trip would change the digest for any non-UTF-8 file.
  const walk = (abs, rel) => {
    const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
    const chunks = [];
    for (const ent of entries) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ignore.has(r) || isDevOnlyRelPath(r)) continue;
      const p = join(abs, ent.name);
      if (ent.isSymbolicLink()) {
        chunks.push(Buffer.from('l ' + r + ' -> ' + readlinkSync(p) + '\n'));
      } else if (ent.isDirectory()) {
        const sub = walk(p, r);
        if (sub.length > 0) {
          chunks.push(Buffer.from('d ' + r + '\n'));
          chunks.push(...sub);
        }
      } else {
        chunks.push(Buffer.from('f ' + r + '\0'));
        chunks.push(readFileSync(p));
        chunks.push(Buffer.from('\n'));
      }
    }
    return chunks;
  };
  for (const chunk of walk(dir, '')) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Remove every dev-only subtree (DEV_ONLY_RELPATHS) from an absolute skill-tree
 * root; idempotent no-op when a subtree is absent. Called after EVERY copy of
 * the skill into a distributed location (installed store, global --copy tree,
 * vendor mirror) so dev-only artifacts never reach end users regardless of which
 * source resolveSkillSource picked — vendor is already pruned by sync-vendor,
 * but the dev-checkout skill/ fallback is not, and this normalizes both.
 */
export function pruneDevOnly(absRoot) {
  for (const rel of DEV_ONLY_RELPATHS) {
    rmSync(join(absRoot, ...rel.split('/')), { recursive: true, force: true });
  }
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
  // Guard BEFORE creating the parent: a symlinked `.archgen` would otherwise
  // redirect the whole manifest write outside the project.
  assertNotSymlink(p);
  assertWithinRoot(root, p);
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
 * Read the path record of a backup snapshot.
 * @param {string} snapshotDir absolute path of the snapshot directory
 * @returns {string[]|null} the recorded relative paths, or null when the
 *   snapshot carries no record (written by an older CLI)
 */
export function readBackupPaths(snapshotDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(snapshotDir, BACKUP_PATHS_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || !Array.isArray(raw.paths)) return null;
  return raw.paths.filter((p) => typeof p === 'string' && p !== '');
}

/** Add `relPaths` to a snapshot's path record (creating it when absent). */
function recordBackupPaths(snapshotDir, relPaths) {
  const existing = readBackupPaths(snapshotDir) ?? [];
  const merged = [...existing];
  for (const p of relPaths) if (!merged.includes(p)) merged.push(p);
  writeFileSync(
    join(snapshotDir, BACKUP_PATHS_FILE),
    JSON.stringify({ version: 1, paths: merged }, null, 2) + '\n',
  );
}

/**
 * Move an existing path into `<root>/<backupRootRel>/<ts>/<relPath>`, preserving
 * the relative layout so backups restore unambiguously. Generalized core shared
 * by the project vault (.archgen/.backup) and the global vault
 * (<skills-dir>/.archgen-backups); `ts` can be injected so one operation lands
 * every entry under a single timestamp.
 *
 * The exact relative path is RECORDED in the snapshot: a restore must put back
 * that path, not the snapshot's top-level directory (which can hold sibling
 * skills the snapshot never covered).
 *
 * @returns {string} backup location relative to `root`
 */
export function moveToBackupInto(root, relPath, backupRootRel, ts = new Date().toISOString().replace(/:/g, '-')) {
  const destRel = backupRootRel + '/' + ts + '/' + relPath;
  const destAbs = join(root, ...destRel.split('/'));
  mkdirSync(dirname(destAbs), { recursive: true });
  const srcAbs = join(root, ...relPath.split('/'));
  try {
    renameSync(srcAbs, destAbs);
  } catch (err) {
    // Fallback copy+remove must NEVER run on a symlinked source: cpSync would
    // read through the link and rmSync would remove it — rethrow instead so
    // the caller refuses the replace rather than touching the link's target.
    let st = null;
    try { st = lstatSync(srcAbs); } catch { /* vanished mid-move */ }
    if (st && st.isSymbolicLink()) throw err;
    cpSync(srcAbs, destAbs, { recursive: true });
    rmSync(srcAbs, { recursive: true, force: true });
  }
  recordBackupPaths(join(root, ...backupRootRel.split('/'), ts), [relPath]);
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
