// doctor.js — `archgen doctor [dir] [--check]` health-check + safe auto-repair.
//
// Verifies a project install: canonical store integrity, version stamp,
// claude link resolution, managed blocks (exactly once each), and manifest
// entry resolution. Safe issues are repaired in place unless --check is given
// (report-only). Exit non-zero only for unrepairable failures.

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  END,
  FEATURES_END,
  FEATURES_START,
  START,
  renderBlock,
  upsertFeaturesRegistry,
  upsertManagedFile,
} from './block.js';
import { CLAUDE_LINK_REL, MANIFEST_REL, STORE_REL, VERSION_FILE, cliVersion, loadManifest, saveManifest } from './store.js';

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

function countOccurrences(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

function relJoin(rel) {
  return join(...rel.split('/'));
}

/**
 * @param {string} projectDir project root to inspect
 * @param {string} packageRoot dir containing this CLI package
 * @param {{check?: boolean}} opts check=true → report-only, no mutations
 * @returns {{root: string, checks: {status: 'OK'|'FIXED'|'WOULD-FIX'|'WARN'|'FAIL', msg: string}[],
 *            tally: Record<string, number>, failures: number}}
 */
export function doctorProject(projectDir, packageRoot, opts = {}) {
  const root = resolve(projectDir);
  const checkOnly = opts.check === true;
  const version = cliVersion(packageRoot);
  const checks = [];
  const add = (status, msg) => checks.push({ status, msg });

  const storeAbs = join(root, relJoin(STORE_REL));
  const claudeAbs = join(root, relJoin(CLAUDE_LINK_REL));
  const agentsAbs = join(root, 'AGENTS.md');
  const claudeMdAbs = join(root, 'CLAUDE.md');

  // 1. Canonical store validity.
  if (existsSync(join(storeAbs, 'SKILL.md'))) {
    add('OK', 'store .agents/skills/archgen (SKILL.md present)');
  } else {
    add('FAIL', 'store .agents/skills/archgen missing or incomplete - run `archgen init`');
  }

  // 2. Version stamp currency.
  const stampAbs = join(storeAbs, VERSION_FILE);
  let stamp = null;
  try { stamp = readFileSync(stampAbs, 'utf8').trim(); } catch { /* absent */ }
  if (!existsSync(storeAbs)) {
    // already reported above; skip stamp handling without touching anything
  } else if (stamp === version) {
    add('OK', `version stamp ${version} (current)`);
  } else if (checkOnly) {
    add('WOULD-FIX', `version stamp ${stamp || 'missing'} is stale -> ${version}`);
  } else {
    mkdirSync(dirname(stampAbs), { recursive: true });
    writeFileSync(stampAbs, version + '\n');
    add('FIXED', `version stamp updated ${stamp || 'missing'} -> ${version}`);
  }

  // 3. Claude link resolution.
  const repairLink = () => {
    if (checkOnly) {
      add('WOULD-FIX', 'claude link missing/dangling -> ../../.agents/skills/archgen');
      return;
    }
    try {
      try { unlinkSync(claudeAbs); } catch { /* absent */ }
      mkdirSync(dirname(claudeAbs), { recursive: true });
      symlinkSync('../../.agents/skills/archgen', claudeAbs);
      add('FIXED', 'claude link recreated -> ../../.agents/skills/archgen');
    } catch (e) {
      add('FAIL', 'cannot recreate claude link: ' + e.message);
    }
  };
  const st = lstatSafe(claudeAbs);
  if (st && st.isSymbolicLink()) {
    const target = resolve(dirname(claudeAbs), readlinkSync(claudeAbs));
    if (target === storeAbs && existsSync(claudeAbs)) add('OK', 'claude link resolves to the canonical store');
    else if (existsSync(claudeAbs)) add('WARN', 'claude link is foreign (points elsewhere) - left untouched');
    else repairLink();
  } else if (st && st.isDirectory()) {
    add('WARN', '.claude/skills/archgen is a real directory (not managed) - inspect manually');
  } else if (st) {
    add('WARN', '.claude/skills/archgen is a regular file - left untouched');
  } else {
    repairLink();
  }

  // 4. AGENTS.md — managed block exactly once, features registry inside.
  if (!existsSync(agentsAbs)) {
    if (checkOnly) add('WOULD-FIX', 'AGENTS.md missing -> created with managed block');
    else {
      writeFileSync(agentsAbs, renderBlock(STORE_REL) + '\n');
      add('FIXED', 'AGENTS.md created with managed block');
    }
  } else {
    const raw = readFileSync(agentsAbs, 'utf8');
    const starts = countOccurrences(raw, START);
    const ends = countOccurrences(raw, END);
    if (starts === 0) {
      if (checkOnly) add('WOULD-FIX', 'AGENTS.md has no archgen block -> added');
      else {
        upsertManagedFile(agentsAbs, renderBlock(STORE_REL).split('\n'));
        add('FIXED', 'AGENTS.md managed block added');
      }
    } else if (starts > 1 || ends > 1) {
      add('FAIL', `AGENTS.md has ${starts} start / ${ends} end markers - fix manually`);
    } else if (ends === 0 || raw.indexOf(START) > raw.indexOf(END)) {
      add('FAIL', 'AGENTS.md has broken archgen markers - fix manually');
    } else {
      const fsCount = countOccurrences(raw, FEATURES_START);
      const feCount = countOccurrences(raw, FEATURES_END);
      if (fsCount === 1 && feCount === 1) add('OK', 'AGENTS.md block + features registry present');
      else if (fsCount === 0 && feCount === 0) {
        if (checkOnly) add('WOULD-FIX', 'AGENTS.md missing features registry -> inserted');
        else {
          upsertFeaturesRegistry(agentsAbs, []);
          add('FIXED', 'AGENTS.md features registry inserted');
        }
      } else {
        add('FAIL', 'AGENTS.md has broken archgen:features markers - fix manually');
      }
    }
  }

  // 5. CLAUDE.md — @AGENTS.md bridge present exactly once.
  if (!existsSync(claudeMdAbs)) {
    if (checkOnly) add('WOULD-FIX', 'CLAUDE.md missing -> created with @AGENTS.md bridge');
    else {
      upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]);
      add('FIXED', 'CLAUDE.md created with @AGENTS.md bridge');
    }
  } else {
    const raw = readFileSync(claudeMdAbs, 'utf8');
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const imports = body.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md');
    const starts = countOccurrences(raw, START);
    const ends = countOccurrences(raw, END);
    if (imports && starts <= 1 && ends <= 1) add('OK', 'CLAUDE.md bridges to AGENTS.md');
    else if (starts > 1 || ends > 1) add('FAIL', 'CLAUDE.md has multiple archgen blocks - fix manually');
    else if (checkOnly) add('WOULD-FIX', 'CLAUDE.md missing @AGENTS.md bridge -> written');
    else {
      upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]);
      add('FIXED', 'CLAUDE.md @AGENTS.md bridge written');
    }
  }

  // 6. Manifest entries resolve.
  const manifest = loadManifest(root);
  if (!manifest) {
    if (existsSync(storeAbs)) add('WARN', `no install manifest at ${MANIFEST_REL} (re-run init to regenerate)`);
    else add('OK', 'no manifest (nothing installed)');
  } else {
    const resolves = (e) => e && typeof e.path === 'string' && existsSync(join(root, ...e.path.split('/')));
    const stale = manifest.entries.filter((e) => !resolves(e));
    if (stale.length === 0) {
      add('OK', `manifest: all ${manifest.entries.length} entr${manifest.entries.length === 1 ? 'y' : 'ies'} resolve`);
    } else if (checkOnly) {
      add('WOULD-FIX', `manifest: ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} -> pruned`);
    } else {
      saveManifest(root, { ...manifest, entries: manifest.entries.filter(resolves) });
      add('FIXED', `manifest: pruned ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'}`);
    }
  }

  const tally = { OK: 0, FIXED: 0, 'WOULD-FIX': 0, WARN: 0, FAIL: 0 };
  for (const c of checks) tally[c.status]++;
  return { root, checks, tally, failures: tally.FAIL };
}
