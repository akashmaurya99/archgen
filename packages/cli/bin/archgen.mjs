#!/usr/bin/env node
// archgen — npm CLI for the archgen skill.
//
//   npx archgen-skill init [dir]      ONE canonical skill store + claude symlink
//                               adapter + AGENTS.md / CLAUDE.md context pointers
//   npx archgen-skill doctor [dir]    Verify/repair a project install (--check = report only)
//   npx archgen-skill install         Install skill into global harness dirs
//                               (Claude Code, OpenCode, Cursor, agentskills)
//   npx archgen-skill uninstall       Remove globally-installed copies (manifest-based)
//     --project [dir]           Remove archgen from a specific project instead
//   npx archgen-skill restore          List/restore archgen backups (project + global vaults)
//   npx archgen-skill migrate [dir]    Evolve generated-artifact formats (--check default)
//
// Zero dependencies. Cross-platform (Windows included — no bash required).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal, uninstallGlobal } from '../lib/install.js';
import { initProject } from '../lib/init.js';
import { doctorProject } from '../lib/doctor.js';
import { uninstallProject } from '../lib/uninstall-project.js';
import { restoreMain } from '../lib/restore.js';
import { migrateMain } from '../lib/migrate.js';
import { compareSemver, fetchLatestVersion } from '../lib/version.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function cliVersion() {
  return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
}

function runInitAndDoctor(dir) {
  const r = initProject(dir, PACKAGE_ROOT);
  console.log('  = store refreshed at ' + r.storePath);
  doctorProject(dir, PACKAGE_ROOT, {});
}

const HELP = `archgen — architecture generation & autonomous task execution for coding agents

Usage:
  npx archgen-skill init [dir]        Prepare a project: create the canonical skill
                                store at .agents/skills/archgen, symlink
                                .claude/skills/archgen -> ../../.agents/skills/archgen,
                                and generate AGENTS.md / CLAUDE.md pointer blocks.
    [--force]                     proceed automatically; divergent copies are
                                  backed up to .archgen/.backup/ (never destroyed)
  npx archgen-skill doctor [dir]      Health-check a project install: store integrity,
                                version stamp, claude link, managed blocks,
                                manifest. Repairs safe issues in place.
    [--check]                     report only - change nothing
  npx archgen-skill install           Install into global harness skill dirs
    [--copy]                      real copies instead of symlinks
    [--uninstall]                 remove manifest-recorded entries
  npx archgen-skill uninstall         Remove globally-installed copies (manifest-based)
    --project [dir]               remove archgen from a project: claude link,
                                  managed blocks, canonical store (kept when
                                  customized) and manifest; .archgen feature
                                  folders and backups are preserved
  npx archgen-skill restore           List backup snapshots across the project and
                                  global vaults; nothing is restored by default
    [--snapshot <ts>]             restore that snapshot (current state is backed
                                  up first); --project <dir> / --global scope it
  npx archgen-skill migrate [dir]     Evolve generated-artifact formats in place;
                                  --check (default) lists pending migrations
    [--apply]                     apply them (every touched file is backed up)
    [--migration <id>]            target a single migration
  npx archgen-skill update [dir]      Check npm for a newer archgen-skill, upgrade
                                  the global install when outdated, then
                                  re-init this project + doctor against the
                                  new version. No-op when already latest.
  npx archgen-skill --version         Print the running CLI version
  npx archgen-skill --help            This help

Docs: https://github.com/akashmaurya99/archgen`;

const [, , cmd, ...rest] = process.argv;

function flag(name) {
  const i = rest.indexOf(name);
  if (i === -1) return false;
  rest.splice(i, 1);
  return true;
}

function positionalDir() {
  return rest[0] ? resolve(rest[0]) : process.cwd();
}

try {
  switch (cmd) {
    case 'init': {
      flag('--force');
      const r = initProject(positionalDir(), PACKAGE_ROOT);
      console.log('archgen: project ready (single-store layout)');
      console.log('  + store ' + r.storePath);
      if (r.claudeLink === 'created') console.log('  + link  .claude/skills/archgen -> ../../.agents/skills/archgen');
      else if (r.claudeLink === 'existing') console.log('  = link  .claude/skills/archgen (already points at the store)');
      else if (r.claudeLink === 'migrated') console.log('  ~ link  .claude/skills/archgen migrated from copy to symlink');
      else if (r.claudeLink === 'kept-divergent') console.log('  ! kept  .claude/skills/archgen (divergent - left untouched)');
      else console.log('  ! skip  .claude/skills/archgen (symlink unavailable)');
      for (const b of r.backups) console.log('  ~ backup ' + b + ' (previous store moved aside)');
      for (const f of r.contextFiles) {
        console.log(`  ${r.createdContextFiles.includes(f) ? 'created' : 'updated'} ${f} (archgen pointer block)`);
      }
      for (const w of r.warnings) console.log('  note: ' + w);
      console.log('\nNext: open this project in your agent and say "generate architecture" or "add feature X".');
      break;
    }
    case 'doctor': {
      const check = flag('--check');
      const r = doctorProject(positionalDir(), PACKAGE_ROOT, { check });
      console.log('archgen doctor — ' + r.root + (check ? '  (check mode: no changes made)' : ''));
      for (const c of r.checks) console.log(`  [${c.status.toLowerCase().padEnd(9)}] ${c.msg}`);
      const t = r.tally;
      console.log(`Summary: ${t.OK} ok, ${t.FIXED} fixed, ${t['WOULD-FIX']} would-fix, ${t.WARN} warning(s), ${t.FAIL} failure(s)`);
      if (r.failures > 0) process.exitCode = 1;
      break;
    }
    case 'install': {
      const copy = flag('--copy');
      if (flag('--uninstall')) { uninstall(); break; }
      const r = installGlobal({ copy });
      console.log('archgen: global harness install (mode: ' + (copy ? 'copy' : 'symlink') + ')');
      for (const [status, mode, path] of r.rows) console.log(`  ${status.padEnd(7)} ${mode.padEnd(5)} ${path}`);
      console.log('\nPer-project setup (recommended): npx archgen-skill init');
      if (r.failures > 0) { console.error(`${r.failures} target(s) failed`); process.exitCode = 1; }
      break;
    }
    case 'uninstall': {
      if (flag('--project')) {
        const r = uninstallProject(positionalDir(), PACKAGE_ROOT);
        console.log('archgen: project uninstall — ' + r.root);
        if (r.linkRemoved) console.log('  - .claude/skills/archgen (link)');
        if (r.strippedBlocks.length) console.log('  - managed blocks stripped from ' + r.strippedBlocks.join(', '));
        if (r.storeRemoved) console.log('  - .agents/skills/archgen (unmodified store)');
        if (r.storeKept) console.log('  = .agents/skills/archgen KEPT (customized)');
        if (r.manifestRemoved) console.log('  - .archgen/.install-manifest.json');
        for (const w of r.warnings) console.log('  note: ' + w);
        console.log('  .archgen feature folders and backups are preserved.');
      } else {
        uninstall();
      }
      break;
    }
    case 'restore': {
      // restoreMain parses its own flags and returns its own exit code.
      process.exitCode = await restoreMain(rest);
      break;
    }
    case 'migrate': {
      // migrateMain parses its own args and returns its own exit code
      // (0 ok, 1 apply failure, 2 usage error).
      process.exitCode = await migrateMain(rest);
      break;
    }
    case 'update': {
      const dir = positionalDir();
      const current = cliVersion();
      console.log('archgen update — running v' + current + ', checking npm registry…');
      const latest = fetchLatestVersion('archgen-skill');
      if (!latest) {
        console.log('  ! could not reach the npm registry (offline?). Nothing changed.');
        break;
      }
      const cmp = compareSemver(latest, current);
      if (cmp === 0) {
        console.log('  = already on the latest published version (' + latest + ').');
        console.log('  Refreshing this project against it anyway…');
        runInitAndDoctor(dir);
        break;
      }
      if (cmp < 0) {
        console.log('  ↑ running v' + current + ' is newer than npm (' + latest + ') — not published yet.');
        console.log('  Refreshing this project against the running version…');
        runInitAndDoctor(dir);
        break;
      }
      console.log('  ↑ newer version available: ' + latest);
      console.log('  upgrading global install: npm install -g archgen-skill@' + latest);
      const up = spawnSync('npm', ['install', '-g', 'archgen-skill@' + latest], { stdio: 'inherit' });
      if (up.status !== 0) {
        console.error('  ! global upgrade failed — run it manually, then re-run: archgen-skill update');
        process.exitCode = 1;
        break;
      }
      // The running process is the OLD code; re-exec the freshly installed binary.
      const bin = spawnSync('command', ['-v', 'archgen-skill'], { encoding: 'utf8', shell: true });
      const freshBin = (bin.stdout || '').trim();
      if (!freshBin) {
        console.log('\nUpgraded to v' + latest + '. Now finish per project with:\n  npx archgen-skill@latest init');
        break;
      }
      console.log('\nre-running init + doctor with the new binary (' + latest + ')…');
      const upInit = spawnSync(freshBin, ['init', dir], { stdio: 'inherit' });
      if (upInit.status !== 0) {
        // An aborted init (e.g. symlink refusal) must surface as a failure —
        // running doctor over a half-finished install would mask it.
        console.error('  ! init failed during update - doctor skipped (see message above)');
        process.exitCode = upInit.status ?? 1;
        break;
      }
      spawnSync(freshBin, ['doctor', dir], { stdio: 'inherit' });
      break;
    }
    case '--version': case '-v': {
      console.log(cliVersion());
      break;
    }
    case '--help': case '-h': case undefined: {
      console.log(HELP);
      if (cmd === undefined) process.exitCode = 1;
      break;
    }
    default:
      console.error('unknown command: ' + cmd + '\n\n' + HELP);
      process.exitCode = 1;
  }
} catch (e) {
  console.error('archgen: ' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}

function uninstall() {
  const r = uninstallGlobal();
  if (r.noop) { console.log('archgen: nothing to uninstall (no manifest found).'); return; }
  console.log(`archgen: removed ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}` + (r.failed ? `, ${r.failed} FAILED` : ''));
  if (r.failed > 0) process.exitCode = 1;
}
