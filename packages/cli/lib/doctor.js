// doctor.js — `archgen doctor [dir] [--check]` health-check + safe auto-repair.
//
// Verifies a project install: canonical store integrity, version stamp,
// claude link resolution, managed blocks (exactly once each), and manifest
// entry resolution. Safe issues are repaired in place unless --check is given
// (report-only). A FAIL row is a broken state a human must fix: it is
// reported AND it fails the run (the process exits non-zero whenever any
// FAIL row was produced).

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
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
import { CLAUDE_LINK_REL, DEV_ONLY_RELPATHS, MANIFEST_REL, STORE_REL, VERSION_FILE, assertNotSymlink, assertWithinRoot, cliVersion, findObsolete, hashDir, loadManifest, pruneDevOnly, pruneObsolete, saveManifest } from './store.js';
import { compareSemver, parseSemver } from './version.js';
import { readStamp, writeStamp } from './version-stamp.js';
import { mcpDoctor } from './mcp-server.js';

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
 *   the FAIL rows — a broken state a human must fix always fails the run.
 */
export function doctorProject(projectDir, packageRoot, opts = {}) {
  const root = resolve(projectDir);
  const checkOnly = opts.check === true;
  const homeDir = opts.home ?? homedir();
  const version = cliVersion(packageRoot);
  const checks = [];
  let failures = 0;
  // A FAIL row is a broken state a human must fix, so it MUST fail the run:
  // the counter below is what the CLI turns into a non-zero exit code.
  const add = (status, msg) => {
    checks.push({ status, msg });
    if (status === 'FAIL') failures++;
  };
  // Run one repair step; a throw becomes a FAIL row instead of aborting the
  // whole doctor pass.
  const attempt = (fn, okStatus, okMsg, failLabel) => {
    try {
      fn();
      add(okStatus, okMsg);
    } catch (e) {
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
    // MIGRATION: the skill no longer ships code. An install carried over from
    // the pre-MCP layout still has a scripts/ tree — dead weight that would
    // otherwise read as "diverges from packaged skill (customized?)".
    // Pruned BEFORE the divergence check so an upgrade is not misreported.
    const packaged = (() => {
      try { return resolveSkillSource(packageRoot); } catch { return null; }
    })();
    if (packaged) {
      // --check reports WITHOUT mutating; repair mode prunes.
      const obsolete = findObsolete(storeAbs, packaged);
      if (obsolete.length > 0) {
        if (checkOnly) {
          for (const rel of obsolete) {
            add('WOULD-FIX', `store carried the obsolete ${rel}/ tree (pre-MCP layout) -> would prune`);
          }
        } else {
          // Pruning DELETES inside the store: refuse when the store (or one of
          // its parents) is a symlink — the prune would otherwise reach
          // outside the project through the link.
          try {
            assertNotSymlink(storeAbs);
            assertWithinRoot(root, storeAbs);
            pruneObsolete(storeAbs, packaged);
            for (const rel of obsolete) {
              add('FIXED', `store carried the obsolete ${rel}/ tree (pre-MCP layout) -> pruned`);
            }
          } catch (e) {
            add('FAIL', `cannot prune the obsolete store tree: ${e.message} - fix manually`);
          }
        }
      }
    }
    const missingCore = ['references'].filter((d) => !existsSync(join(storeAbs, d)));
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

  // 1b. Prune dev-only artifacts (scripts/test) that older installers shipped
  //     into the store. They are repo-only CI tooling and never belong in an
  //     installed tree; removing them here cleans existing stores without a
  //     full backup+re-copy. hashDir ignores the same subtrees, so this prune
  //     neither masks real customization nor reads as divergence.
  if (existsSync(storeAbs)) {
    const devOnlyPresent = DEV_ONLY_RELPATHS.filter((rel) => existsSync(join(storeAbs, ...rel.split('/'))));
    if (devOnlyPresent.length > 0) {
      if (checkOnly) {
        add('WOULD-FIX', `store carries dev-only ${devOnlyPresent.join(', ')} -> pruned`);
      } else {
        // Same rule as the obsolete prune: never delete through a symlink.
        attempt(() => {
          assertNotSymlink(storeAbs);
          assertWithinRoot(root, storeAbs);
          pruneDevOnly(storeAbs);
        }, 'FIXED',
          `dev-only ${devOnlyPresent.join(', ')} pruned from store`, 'cannot prune dev-only artifacts');
      }
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
  //
  // The doctor REPAIRS an install — it does not create one. In a project
  // with no store it used to create the claude link, AGENTS.md and
  // CLAUDE.md anyway, so a project that had never been installed ended up
  // advertising an install that does not exist (and then reported FAIL for
  // the missing store).
  const installed = existsSync(storeAbs);
  if (!installed) {
    add('WARN', 'this project has no archgen install - run `archgen init` (nothing was created)');
  }
  const repairLink = () => {
    if (checkOnly) {
      add('WOULD-FIX', 'claude link missing/dangling -> ../../.agents/skills/archgen');
      return;
    }
    try {
      // Escape check FIRST, exactly as init does: a symlinked .claude/
      // .claude/skills parent must not redirect the recreated link outside
      // the project root.
      assertWithinRoot(root, dirname(claudeAbs));
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
  } else if (installed) {
    repairLink();
  }

  // 4. AGENTS.md — managed block exactly once, features registry inside.
  //
  // A file that EXISTS is always inspected (a dangling symlink must be
  // reported, not silently skipped). A file that is MISSING is only created
  // in an installed project: the doctor repairs an install, it does not
  // create one.
  const mayCreate = installed;
  // A symlinked managed file is REFUSED, never written through — and the
  // refusal is REPORTED whether or not the project has an install. A
  // dangling symlink does not "exist" (existsSync follows it), so the
  // symlink is detected with lstat.
  const agentsLink = lstatSafe(agentsAbs);
  if (agentsLink && agentsLink.isSymbolicLink()) {
    try {
      assertNotSymlink(agentsAbs);
    } catch (e) {
      add('FAIL', e.message);
    }
  }
  if (!existsSync(agentsAbs)) {
    if (!mayCreate) {
      add('WARN', 'AGENTS.md missing - not created (this project has no archgen install)');
    } else if (checkOnly) add('WOULD-FIX', 'AGENTS.md missing -> created with managed block');
    else {
      // Through the guarded upsert (not raw writeFileSync): existsSync follows
      // symlinks, so a dangling symlink would otherwise be written through.
      attempt(() => upsertManagedFile(agentsAbs, renderBlock(STORE_REL).split('\n')), 'FIXED',
        'AGENTS.md created with managed block', 'cannot create AGENTS.md managed block');
    }
  } else {
    // An unreadable managed file is a FAIL row, not a reason to abort the
    // whole doctor pass.
    try {
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
    } catch (e) {
      add('FAIL', 'cannot read AGENTS.md: ' + e.message + ' - fix manually');
    }
  }

  // 5. CLAUDE.md — @AGENTS.md bridge present exactly once.
  const claudeLink = lstatSafe(claudeMdAbs);
  if (claudeLink && claudeLink.isSymbolicLink()) {
    try {
      assertNotSymlink(claudeMdAbs);
    } catch (e) {
      add('FAIL', e.message);
    }
  }
  if (!existsSync(claudeMdAbs)) {
    if (!mayCreate) {
      add('WARN', 'CLAUDE.md missing - not created (this project has no archgen install)');
    } else if (checkOnly) add('WOULD-FIX', 'CLAUDE.md missing -> created with @AGENTS.md bridge');
    else {
      attempt(() => upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]), 'FIXED',
        'CLAUDE.md created with @AGENTS.md bridge', 'cannot create CLAUDE.md bridge');
    }
  } else {
    // An unreadable managed file is a FAIL row, not a reason to abort the
    // whole doctor pass.
    let raw = null;
    try {
      raw = readFileSync(claudeMdAbs, 'utf8');
    } catch (e) {
      add('FAIL', 'cannot read CLAUDE.md: ' + e.message + ' - fix manually');
    }
    if (raw !== null) {
      const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const imports = body.split(/\r?\n/).some((l) => l.trim() === '@AGENTS.md');
      const starts = countOccurrences(raw, START);
      const ends = countOccurrences(raw, END);
      if (starts > 1 || ends > 1) add('FAIL', 'CLAUDE.md has multiple archgen blocks - fix manually');
      else if (starts !== ends) add('FAIL', 'CLAUDE.md has broken archgen markers - fix manually');
      else if (starts === 1) {
        // The managed block is ours: keep its provenance stamp current, the
        // same way the AGENTS.md block is kept current.
        const det = detectBlockVersion(raw);
        const parsed = det.version ? parseSemver(det.version) : null;
        const stale = !det.present || !parsed || compareSemver(det.version, version) < 0;
        if (stale) {
          const from = det.version ? 'v' + det.version : 'unversioned';
          if (checkOnly) {
            add('WOULD-FIX', `WOULD-UPGRADE: CLAUDE.md block ${from} -> v${version}`);
          } else {
            attempt(() => upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]), 'FIXED',
              `UPGRADED: CLAUDE.md block ${from} -> v${version}`, 'cannot upgrade CLAUDE.md block');
          }
        } else {
          add('OK', 'CLAUDE.md bridges to AGENTS.md');
        }
      } else if (imports) add('OK', 'CLAUDE.md bridges to AGENTS.md');
      else if (checkOnly) add('WOULD-FIX', 'CLAUDE.md missing @AGENTS.md bridge -> written');
      else {
        attempt(() => upsertManagedFile(claudeMdAbs, [START, '@AGENTS.md', END]), 'FIXED',
          'CLAUDE.md @AGENTS.md bridge written', 'cannot write CLAUDE.md bridge');
      }
    }
  }

  for (const [status, msg] of deferredStoreFindings) add(status, msg);

  // 6. Manifest entries resolve.
  const manifest = loadManifest(root);
  if (!manifest) {
    if (existsSync(storeAbs)) add('WARN', `no install manifest at ${MANIFEST_REL} (re-run init to regenerate)`);
    else add('OK', 'no manifest (nothing installed)');
  } else if (!Array.isArray(manifest.entries)) {
    // A manifest without an entries array is malformed: report it instead of
    // crashing the whole doctor pass on it.
    add('FAIL', `manifest ${MANIFEST_REL} has no entries array - fix manually`);
  } else {
    // An entry only "resolves" when its path stays inside the project root:
    // a manifest path like `../../etc/passwd` must never count as resolved.
    const entryAbs = (rel) => {
      if (typeof rel !== 'string' || rel === '') return null;
      const abs = resolve(root, ...rel.split('/'));
      if (abs !== root && !abs.startsWith(root + sep)) return null;
      return abs;
    };
    const resolves = (e) => {
      const abs = entryAbs(e && e.path);
      return abs !== null && existsSync(abs);
    };
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
  //    <skillRoot>/.archgen-version (the MCP server reads it to report the
  //    installed skill's version). Report-only: doctor repairs the project
  //    stamp in section 2, never global installs.
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

  // 8. MCP server wiring — the archgen MCP server is what actually gives the
  //    agent its tools. A skill with no MCP entry is a skill the agent cannot
  //    use, so this is a first-class check, not a footnote.
  //
  // READ-ONLY and NEVER FATAL: doctor must work on a machine with no npm, no
  // network, and no MCP server installed. The MCP server is asked for its own
  // report; if it cannot run, that is a WARN with the remediation command.
  const mcp = mcpDoctor({ projectRoot: root, env: { ...process.env, HOME: homeDir } });
  if (!mcp.report) {
    add('WARN', `archgen MCP server not reachable${mcp.detail ? ` — ${mcp.detail}` : ''} — install with: npx archgen-mcp bootstrap --project . --yes`);
  } else {
    const rep = mcp.report;
    add(
      rep.skill ? 'OK' : 'WARN',
      rep.skill
        ? `archgen MCP server v${rep.server} ready (skill ${rep.skill.version ?? 'unknown'})`
        : 'archgen MCP server ready, but no skill was found',
    );
    const wired = (rep.mcpTargets ?? []).filter((t) => t.exists).length;
    if (wired === 0) {
      add('WARN', 'archgen MCP is not wired into any harness config — run: npx archgen-mcp bootstrap --project . --yes');
    } else {
      add('OK', `archgen MCP wiring present in ${wired} harness config(s)`);
    }
    if (rep.codegraph) add('OK', `codegraph ${rep.codegraph.version}`);
    else add('WARN', 'codegraph not installed — run: npx archgen-mcp bootstrap --project . --yes');
  }

  const tally = { OK: 0, FIXED: 0, 'WOULD-FIX': 0, WARN: 0, FAIL: 0 };
  for (const c of checks) tally[c.status]++;
  return { root, checks, tally, failures };
}
