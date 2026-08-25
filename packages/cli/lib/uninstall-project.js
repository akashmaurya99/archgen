// uninstall-project.js — `archgen uninstall --project [dir]` removal with rails.
//
// Removes exactly what archgen owns in a project: the claude symlink, the
// managed blocks, the canonical store (ONLY when unmodified vs the vendor
// skill — a customized store is kept with a warning), and the install
// manifest. `.archgen/<slug>` feature folders and `.archgen/.backup/` are
// always preserved. Parents are pruned only when left completely empty, and
// never past the guarded .claude/.agents levels.

import { existsSync, lstatSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stripManagedFile } from './block.js';
import {
  CLAUDE_LINK_REL,
  MANIFEST_REL,
  STORE_REL,
  VERSION_FILE,
  hashDir,
  pruneEmptyParents,
  rmIfExists,
} from './store.js';
import { resolveSkillSource } from './init.js';

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

function relJoin(rel) {
  return join(...rel.split('/'));
}

/**
 * @param {string} projectDir project root to clean
 * @param {string} packageRoot dir containing this CLI package (vendor source)
 * @returns {{root: string, linkRemoved: boolean, strippedBlocks: string[],
 *            storeRemoved: boolean, storeKept: boolean, manifestRemoved: boolean, warnings: string[]}}
 */
export function uninstallProject(projectDir, packageRoot) {
  const root = resolve(projectDir);
  const warnings = [];
  const strippedBlocks = [];

  const storeAbs = join(root, relJoin(STORE_REL));
  const claudeAbs = join(root, relJoin(CLAUDE_LINK_REL));

  // 1. Claude adapter — remove only our own symlink (dangling included).
  let linkRemoved = false;
  const lst = lstatSafe(claudeAbs);
  if (lst && lst.isSymbolicLink()) {
    const target = resolve(dirname(claudeAbs), readlinkSync(claudeAbs));
    if (target === storeAbs || !existsSync(claudeAbs)) {
      unlinkSync(claudeAbs); // removes the link itself, never its target
      linkRemoved = true;
    } else {
      warnings.push('foreign symlink at .claude/skills/archgen - left untouched');
    }
  } else if (lst && lst.isDirectory()) {
    warnings.push('.claude/skills/archgen is a real directory - left untouched (remove manually if unwanted)');
  }

  // 2. Managed blocks — strip markers, keep all user content.
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    if (stripManagedFile(join(root, name)).hadBlock) strippedBlocks.push(name);
  }

  // 3. Canonical store — remove ONLY if unmodified vs vendor.
  //    The version stamp is our metadata, so it is ignored when comparing.
  let storeRemoved = false;
  let storeKept = false;
  if (lstatSafe(storeAbs)) {
    const st = lstatSafe(storeAbs);
    const mine = st.isDirectory() && !st.isSymbolicLink()
      ? hashDir(storeAbs, { ignore: [VERSION_FILE] })
      : null;
    let vendor = null;
    try { vendor = hashDir(resolveSkillSource(packageRoot)); } catch { vendor = null; }
    if (vendor !== null && mine === vendor) {
      rmSync(storeAbs, { recursive: true, force: true });
      storeRemoved = true;
    } else {
      storeKept = true;
      warnings.push('canonical store kept at .agents/skills/archgen: modified vs vendor (or unverifiable) - review manually');
    }
  }

  // 4. Manifest file — then prune .archgen only if nothing else remains
  //    (feature folders / backups keep it alive).
  const manifestRemoved = rmIfExists(join(root, relJoin(MANIFEST_REL)));
  if (manifestRemoved) pruneEmptyParents(root, dirname(MANIFEST_REL));

  return { root, linkRemoved, strippedBlocks, storeRemoved, storeKept, manifestRemoved, warnings };
}
