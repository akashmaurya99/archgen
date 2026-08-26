// init.js — single-store project installer + AGENTS.md/CLAUDE.md context files.
//
// `archgen init` makes a repository SELF-CONTAINED with ONE real copy of the
// skill: the canonical store at .agents/skills/archgen (committed to git,
// team-shared). .claude/skills/archgen becomes a RELATIVE symlink to the
// store — skipped gracefully where symlinks are unavailable, never a second
// copy. AGENTS.md carries a managed pointer block with an embedded features
// registry; CLAUDE.md carries a one-line `@AGENTS.md` bridge. Every created
// artifact is recorded in .archgen/.install-manifest.json.
//
// Verified-surgical safety semantics:
// - existing paths are fingerprinted (stable-order sha256 over relpaths +
//   contents) BEFORE any mutation;
// - an identical store is refreshed in place; a divergent one is moved to
//   .archgen/.backup/<timestamp>/ FIRST, then reinstalled fresh;
// - a real-directory claude copy identical to the vendor skill is migrated
//   to a symlink; a customized one is left untouched with a warning;
// - installs are atomic: built in a temp sibling dir, then renamed.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { importsAgents, renderBlock, START, END, upsertManagedFile } from './block.js';
import { CLAUDE_LINK_REL, STORE_REL, VERSION_FILE, appendEntry, cliVersion, hashDir, moveToBackup } from './store.js';
import { writeStamp } from './version-stamp.js';

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'];

/** Resolve the bundled skill directory (works from npm package and repo checkout). */
export function resolveSkillSource(packageRoot) {
  const candidates = [
    join(packageRoot, 'vendor', 'skills', 'archgen'),
    join(packageRoot, '..', '..', 'skill'), // dev: running from packages/cli inside the monorepo
  ];
  for (const c of candidates) if (existsSync(join(c, 'SKILL.md'))) return c;
  throw new Error('bundled archgen skill not found (expected vendor/skills/archgen)');
}

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

function relJoin(rel) {
  return join(...rel.split('/'));
}

/**
 * Create the claude adapter: `<project>/.claude/skills/archgen` as a RELATIVE
 * symlink into the canonical store. Never copies. Migration/keep semantics:
 * - ours already -> 'existing'
 * - real dir identical to vendor -> replaced with symlink ('migrated')
 * - real dir modified / foreign live symlink / stray file -> hands off + warn
 * - dangling symlink -> recreated
 * - symlink creation fails (privileges/FS) -> skipped + warning
 */
function installClaudeAdapter(root, source, warnings) {
  const claudeAbs = join(root, relJoin(CLAUDE_LINK_REL));
  const storeAbs = join(root, relJoin(STORE_REL));
  const st = lstatSafe(claudeAbs);
  let migrating = false;

  if (st && st.isSymbolicLink()) {
    const resolvedTarget = resolve(dirname(claudeAbs), readlinkSync(claudeAbs));
    if (resolvedTarget === storeAbs && existsSync(claudeAbs)) return 'existing';
    if (existsSync(claudeAbs)) {
      warnings.push('.claude/skills/archgen is a foreign symlink - left untouched');
      return 'kept-divergent';
    }
    unlinkSync(claudeAbs); // dangling: recreate ours below
  } else if (st && st.isDirectory()) {
    if (hashDir(claudeAbs) === hashDir(source)) {
      rmSync(claudeAbs, { recursive: true }); // legacy dual copy -> migrate
      migrating = true;
    } else {
      warnings.push('user-customized claude copy kept at .claude/skills/archgen (not managed)');
      return 'kept-divergent';
    }
  } else if (st) {
    warnings.push('.claude/skills/archgen exists and is not a directory - left untouched');
    return 'kept-divergent';
  }

  try {
    mkdirSync(dirname(claudeAbs), { recursive: true });
    symlinkSync('../../.agents/skills/archgen', claudeAbs);
    appendEntry(root, 'link', CLAUDE_LINK_REL);
    return migrating ? 'migrated' : 'created';
  } catch (e) {
    warnings.push('claude adapter skipped: symlink unavailable (' + e.message + ')');
    return 'skipped';
  }
}

/**
 * Initialize a project: install the single canonical skill store, wire the
 * claude adapter, and write context pointers.
 * @param {string} projectDir target repo root
 * @param {string} packageRoot dir containing this CLI package
 * @param {{force?: boolean}} opts --force proceeds automatically; divergent
 *   copies are always auto-backed-up (never refused, never destroyed)
 * @returns {{storePath: string, claudeLink: 'created'|'existing'|'migrated'|'skipped'|'kept-divergent',
 *            backups: string[], contextFiles: string[], createdContextFiles: string[], warnings: string[]}}
 */
export function initProject(projectDir, packageRoot, opts = {}) {
  // --force is accepted for explicitness: this installer never refuses and
  // never destroys data — divergent copies are backed up automatically, so
  // both plain and --force runs take the same safe path.
  const force = opts.force === true;
  void force;

  const root = resolve(projectDir);
  const source = resolveSkillSource(packageRoot);
  const version = cliVersion(packageRoot);
  const warnings = [];
  const backups = [];

  const storeAbs = join(root, relJoin(STORE_REL));

  // 1. Canonical store — fingerprint before mutating (ownership check).
  const prev = lstatSafe(storeAbs);
  if (prev) {
    const identical = prev.isDirectory() && !prev.isSymbolicLink()
      && hashDir(storeAbs, { ignore: [VERSION_FILE] }) === hashDir(source);
    if (!identical) backups.push(moveToBackup(root, STORE_REL));
  }

  // Atomic install: build in a temp sibling dir, then rename into place.
  const skillsParent = dirname(storeAbs);
  mkdirSync(skillsParent, { recursive: true });
  const tmp = join(skillsParent, '.archgen-tmp-' + randomBytes(6).toString('hex'));
  cpSync(source, tmp, { recursive: true });
  writeStamp(tmp, version);
  rmSync(storeAbs, { recursive: true, force: true });
  renameSync(tmp, storeAbs);
  appendEntry(root, 'dir', STORE_REL);

  // 2. Claude adapter — relative symlink, never a second copy.
  const claudeLink = installClaudeAdapter(root, source, warnings);

  // 3. Context files — managed blocks, user content preserved.
  const contextFiles = [];
  const createdContextFiles = [];
  for (const name of CONTEXT_FILES) {
    const abs = join(root, name);
    if (name === 'CLAUDE.md' && importsAgents(abs)) {
      warnings.push('CLAUDE.md already imports @AGENTS.md - skipped (already-imports)');
      continue;
    }
    const existed = upsertManagedFile(
      abs,
      name === 'AGENTS.md' ? renderBlock(STORE_REL).split('\n') : [START, '@AGENTS.md', END],
    );
    contextFiles.push(name);
    if (!existed) createdContextFiles.push(name);
    appendEntry(root, 'block', name);
  }

  return { storePath: storeAbs, claudeLink, backups, contextFiles, createdContextFiles, warnings };
}
