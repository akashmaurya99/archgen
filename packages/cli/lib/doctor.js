// doctor.js — `archgen doctor [dir] [--check]` health-check + safe auto-repair.
//
// Verifies a project install: canonical store integrity, version stamp,
// claude link resolution, managed blocks (exactly once each), and manifest
// entry resolution. Safe issues are repaired in place unless --check is given
// (report-only). Advisory FAIL rows (broken states only a human can fix) are
// reported and counted in the summary but do NOT fail the run: the process
// exits non-zero only when a repair operation itself throws.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { globalTargets } from './install.js';
import {
  END,
  FEATURES_END,
  FEATURES_START,
  START,
  detectBlockVersion,
  renderBlock,
  upsertFeaturesRegistry,
  upsertManagedFile,
} from './block.js';
import { resolveSkillSource } from './init.js';
import { CLAUDE_LINK_REL, MANIFEST_REL, STORE_REL, VERSION_FILE, cliVersion, hashDir, loadManifest, saveManifest } from './store.js';
import { compareSemver, parseSemver } from './version.js';
import { readStamp, writeStamp } from './version-stamp.js';

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
 * @param {{check?: boolean, home?: string}} opts check=true → report-only, no
 *   mutations; home overrides the homedir scanned for global installs (tests)
 * @returns {{root: string, checks: {status: 'OK'|'FIXED'|'WOULD-FIX'|'WARN'|'FAIL', msg: string}[],
 *            tally: Record<string, number>, failures: number}} `failures` counts
 *   repair operations that THEMSELVES threw — advisory FAIL rows are reported
 *   but never fail the run.
 */
export function doctorProject(projectDir, packageRoot, opts = {}) {
  const root = resolve(projectDir);
  const checkOnly = opts.check === true;
  const homeDir = opts.home ?? homedir();
  const version = cliVersion(packageRoot);
  const checks = [];
  const add = (status, msg) => checks.push({ status, msg });
  let opFailures = 0;
  // Run one repair step; a throw becomes a FAIL row instead of aborting the
  // whole doctor pass (and is the only thing that flips the exit code).
  const attempt = (fn, okStatus, okMsg, failLabel) => {
    try {
      fn();
      add(okStatus, okMsg);
    } catch (e) {
      opFailures++;
      add('FAIL', `${failLabel}: ${e.message} - fix manually`);
    }
  };

  const storeAbs = join(root, relJoin(STORE_REL));
  const claudeAbs = join(root, relJoin(CLAUDE_LINK_REL));
  const agentsAbs = join(root, 'AGENTS.md');
  const claudeMdAbs = join(root, 'CLAUDE.md');

  // 1. Canonical store validity — SKILL.md alone is not enough: a store
  //    missing whole subtrees (scripts/, references/) green-lights installs
  //    whose entry points are gone. Divergence from the packaged skill is a
  //    WARN, not a failure: user customization is legitimate.
  const deferredStoreFindings = [];
  if (!existsSync(join(storeAbs, 'SKILL.md'))) {
    add('FAIL', 'store .agents/skills/archgen missing or incomplete - run `archgen init`');
  } else {
    const missingCore = ['scripts', 'references'].filter((d) => !existsSync(join(storeAbs, d)));
    if (missingCore.length > 0) {
      // Deferred so the managed-block FAIL rows below stay FIRST: existing
      // consumers read checks.find(FAIL) expecting the marker verdict.
      deferredStoreFindings.push(['FAIL', `store .agents/skills/archgen is missing core ${missingCore.map((d) => d + '/').join(', ')} - run \`archgen init\``]);
    } else {
      let diverged = false;
      try {
        diverged = hashDir(storeAbs) !== hashDir(resolveSkillSource(packageRoot));
      } catch { /* packaged skill unavailable — skip the divergence probe */ }
      if (diverged) add('WARN', 'store .agents/skills/archgen diverges from packaged skill (customized?)');
      else add('OK', 'store .agents/skills/archgen (SKILL.md present)');
    }
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
    attempt(() => writeStamp(storeAbs, version), 'FIXED',
      `version stamp updated ${stamp || 'missing'} -> ${version}`, 'cannot write version stamp');
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
    let raw = readFileSync(agentsAbs, 'utf8');
    const starts = countOccurrences(raw, START);
    const ends = countOccurrences(raw, END);
    if (starts === 0 && ends === 0) {
      if (checkOnly) add('WOULD-FIX', 'AGENTS.md has no archgen block -> added');
      else {
        attempt(() => upsertManagedFile(agentsAbs, renderBlock(STORE_REL).split('\n')), 'FIXED',
          'AGENTS.md managed block added', 'cannot add AGENTS.md managed block');
      }
    } else if (starts > 1 || ends > 1) {
      add('FAIL', `AGENTS.md has ${starts} start / ${ends} end markers - fix manually`);
    } else if (starts === 0 || ends === 0 || raw.indexOf(START) > raw.indexOf(END)) {
      // Orphan/inverted markers: repairing through upsertBlock would throw, so
      // classify as FAIL instead of attempting the write.
      add('FAIL', 'AGENTS.md has broken archgen markers - fix manually');
    } else {
      // Block-format currency: an unversioned or older-stamped managed block is
      // upgraded in place through the normal upsert path (everything outside the
      // markers survives byte-for-byte by design). Newer stamps are left alone.
      const det = detectBlockVersion(raw);
      const parsed = det.version ? parseSemver(det.version) : null;
      const stale = !det.present || !parsed || compareSemver(det.version, version) < 0;
      if (stale) {
        const from = det.version ? 'v' + det.version : 'unversioned';
        if (checkOnly) {
          add('WOULD-FIX', `WOULD-UPGRADE: AGENTS.md block ${from} -> v${version}`);
        } else {
          let upgraded = false;
          attempt(() => { upsertManagedFile(agentsAbs, renderBlock(STORE_REL).split('\n')); upgraded = true; },
            'FIXED', `UPGRADED: AGENTS.md block ${from} -> v${version}`, 'cannot upgrade AGENTS.md block');
          if (upgraded) raw = readFileSync(agentsAbs, 'utf8');
        }
      }
      const fsCount = countOccurrences(raw, FEATURES_START);
      const feCount = countOccurrences(raw, FEATURES_END);
      const fsIdx = raw.indexOf(FEATURES_START);
      const feIdx = raw.indexOf(FEATURES_END);
      if (fsCount === 1 && feCount === 1 && fsIdx < feIdx) {
        add('OK', 'AGENTS.md block + features registry present');
      } else if (fsCount === 1 && feCount === 1) {
        // Counts are right but ORDER is inverted (end before start): any
        // registry write would throw (upsertFeaturesRegistry requires
        // end > start), so flag the state instead of blessing it as OK.
        if (checkOnly) add('WOULD-FIX', 'AGENTS.md archgen:features markers are reversed -> swap them');
        else add('FAIL', 'AGENTS.md archgen:features markers are reversed - fix manually');
      } else if (fsCount === 0 && feCount === 0) {
        if (checkOnly) add('WOULD-FIX', 'AGENTS.md missing features registry -> inserted');
        else {
          attempt(() => upsertFeaturesRegistry(agentsAbs, []), 'FIXED',
            'AGENTS.md features registry inserted', 'cannot insert AGENTS.md features registry');
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
      attempt(() => upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]), 'FIXED',
        'CLAUDE.md created with @AGENTS.md bridge', 'cannot create CLAUDE.md bridge');
    }
  } else {
    const raw = readFileSync(claudeMdAbs, 'utf8');
    const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const imports = body.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md');
    const starts = countOccurrences(raw, START);
    const ends = countOccurrences(raw, END);
    if (imports && starts <= 1 && ends <= 1) add('OK', 'CLAUDE.md bridges to AGENTS.md');
    else if (starts > 1 || ends > 1) add('FAIL', 'CLAUDE.md has multiple archgen blocks - fix manually');
    else if (starts !== ends) add('FAIL', 'CLAUDE.md has broken archgen markers - fix manually');
    else if (checkOnly) add('WOULD-FIX', 'CLAUDE.md missing @AGENTS.md bridge -> written');
    else {
      attempt(() => upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]), 'FIXED',
        'CLAUDE.md @AGENTS.md bridge written', 'cannot write CLAUDE.md bridge');
    }
  }

  for (const [status, msg] of deferredStoreFindings) add(status, msg);

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

  // 7. Version-stamp inventory — every archgen skill tree visible from this
  //    project/machine, one line each, for tools that probe
  //    <skillRoot>/.archgen-version (the VS Code extension reads it to warn
  //    "skill outdated"). Report-only: doctor repairs the project stamp in
  //    section 2, never global installs.
  const seen = new Set();
  const installs = [];
  const noteInstall = (p) => {
    // Dedupe by realpath (two harness dirs may link one tree) but DISPLAY the
    // discovered path — that is the path tools probe <skillRoot>/.archgen-version through.
    let real;
    try { real = realpathSync(p); } catch { return; } // vanished mid-scan
    if (!seen.has(real)) { seen.add(real); installs.push(p); }
  };
  if (existsSync(storeAbs)) noteInstall(storeAbs);
  for (const t of globalTargets(homeDir)) {
    const p = join(t, 'archgen');
    if (existsSync(p)) noteInstall(p);
  }
  const ghSkills = join(root, '.github', 'skills', 'archgen');
  if (existsSync(ghSkills)) noteInstall(ghSkills);
  for (const p of installs) {
    const v = readStamp(p);
    const slot = v ?? (existsSync(join(p, VERSION_FILE)) ? 'unknown (pre-0.1 stamp)' : 'missing');
    add(v ? 'OK' : 'WARN', `skill ${p}: ${slot}`);
  }

  const tally = { OK: 0, FIXED: 0, 'WOULD-FIX': 0, WARN: 0, FAIL: 0 };
  for (const c of checks) tally[c.status]++;
  return { root, checks, tally, failures: opFailures };
}
