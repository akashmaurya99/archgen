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
import { npmInvocation, whichOnPath, globalBinPath } from '../lib/spawn-npm.js';
import { cliVersion } from '../lib/store.js';
import { spawnSync } from 'node:child_process';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runInitAndDoctor(dir) {
  const r = initProject(dir, PACKAGE_ROOT);
  console.log('  = store refreshed at ' + r.storePath);
  const d = doctorProject(dir, PACKAGE_ROOT, {});
  // A failed doctor must fail the update too: the project was NOT brought to
  // the new version.
  if (d.failures > 0) {
    console.error('  ! doctor reported ' + d.failures + ' failure(s)');
    process.exitCode = 1;
  }
}

const HELP = `archgen — architecture generation & autonomous task execution for coding agents

Usage:
  npx archgen-skill init [dir]        Prepare a project: create the canonical skill
                                store at .agents/skills/archgen, symlink
                                .claude/skills/archgen -> ../../.agents/skills/archgen,
                                and generate AGENTS.md / CLAUDE.md pointer blocks.
    [--project <dir>]              the project directory (same as the positional
                                   form; give it once, not both)
    [--force]                     proceed automatically; divergent copies are
                                  backed up to .archgen/.backup/ (never destroyed)
    [--no-codegraph]              skip the CodeGraph bootstrap
    [--no-mcp]                   skip wiring the archgen MCP server
    [--location-project]          wire the PROJECT-local harness configs too
                                   (by default only the global ones are wired,
                                   so a project carries no MCP configuration)
  npx archgen-skill doctor [dir]      Health-check a project install: store integrity,
                                version stamp, claude link, managed blocks,
                                manifest. Repairs safe issues in place.
    [--project <dir>]              the project directory (same as the positional form)
    [--check]                     report only - change nothing
  npx archgen-skill install           Install into global harness skill dirs
    [--copy]                      real copies instead of symlinks
    [--uninstall]                 remove manifest-recorded entries
    [--no-codegraph]              skip the CodeGraph bootstrap
    [--no-mcp]                   skip wiring the archgen MCP server
  npx archgen-skill uninstall [dir]     Remove archgen from a project (the same
                                 as the positional form); without a directory
                                 the globally-installed copies are removed
                                 (manifest-based)
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

/**
 * Consume an option that takes a value: `--name <value>` or `--name=<value>`.
 *
 * Returns null when the option is absent, '' when it is present with no
 * value ("use the default"), and the value otherwise.
 */
function takeValue(name) {
  const eq = rest.findIndex((a) => a.startsWith(name + '='));
  if (eq !== -1) {
    const v = rest[eq].slice(name.length + 1);
    rest.splice(eq, 1);
    return v;
  }
  const i = rest.indexOf(name);
  if (i === -1) return null;
  rest.splice(i, 1);
  const v = rest[i];
  if (v === undefined || v.startsWith('-')) return '';
  rest.splice(i, 1);
  return v;
}

/**
 * The project directory for a command.
 *
 * Accepts a POSITIONAL dir (`init myproj`) and `--project <dir>` alike. The
 * same flag name is used by `uninstall` and `restore`, and the MCP server's
 * own commands take `--project` too — so a user who typed one form must
 * never get a directory literally named "--project" created in their cwd.
 *
 * Extra positional arguments are REFUSED: silently ignoring the second one
 * would install into a directory the user did not name.
 */
function targetDir() {
  const explicit = takeValue('--project');
  const positionals = rest.filter((a) => !a.startsWith('-'));
  if (positionals.length > 1) {
    throw new Error(`unexpected argument: ${positionals[1]} — give the project directory once`);
  }
  const positional = positionals[0];
  const explicitDir = explicit === null ? null : (explicit === '' ? process.cwd() : resolve(explicit));
  if (explicitDir !== null && positional !== undefined && explicitDir !== resolve(positional)) {
    throw new Error('give the project directory once: either positionally or with --project');
  }
  return explicitDir ?? (positional !== undefined ? resolve(positional) : process.cwd());
}

/**
 * Refuse an option we do not understand.
 *
 * An unknown flag is a TYPO. It is never a directory name — creating a
 * directory called "--no-mcp" because the flag was misspelled is exactly the
 * kind of silent mess this check exists to prevent.
 */
function assertNoUnknownFlags() {
  const unknown = rest.find((a) => a.startsWith('-'));
  if (unknown) throw new Error(`unknown option: ${unknown}`);
}

try {
  switch (cmd) {
    case 'init': {
      flag('--force');
      const noCodegraph = flag('--no-codegraph');
      const noMcp = flag('--no-mcp');
      // The harness configs live in the user's home by default, so a project
      // carries no MCP configuration of its own. `--location project` opts
      // into wiring the project-local configs instead.
      const location = flag('--location-project') ? 'project' : 'global';
      const dir = targetDir();
      assertNoUnknownFlags();
      const r = initProject(dir, PACKAGE_ROOT, {
        codegraph: !noCodegraph,
        mcp: !noMcp,
        location,
      });
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
      const dir = targetDir();
      assertNoUnknownFlags();
      const r = doctorProject(dir, PACKAGE_ROOT, { check });
      console.log('archgen doctor — ' + r.root + (check ? '  (check mode: no changes made)' : ''));
      for (const c of r.checks) console.log(`  [${c.status.toLowerCase().padEnd(9)}] ${c.msg}`);
      const t = r.tally;
      console.log(`Summary: ${t.OK} ok, ${t.FIXED} fixed, ${t['WOULD-FIX']} would-fix, ${t.WARN} warning(s), ${t.FAIL} failure(s)`);
      if (r.failures > 0) process.exitCode = 1;
      break;
    }
    case 'install': {
      const copy = flag('--copy');
      const noCodegraph = flag('--no-codegraph');
      const noMcp = flag('--no-mcp');
      const uninstallMode = flag('--uninstall');
      assertNoUnknownFlags();
      const stray = rest.find((a) => !a.startsWith('-'));
      if (stray) throw new Error(`unexpected argument: ${stray} — install takes no directory`);
      if (uninstallMode) { uninstall(); break; }
      const r = installGlobal({ copy, codegraph: !noCodegraph, mcp: !noMcp });
      console.log('archgen: global harness install (mode: ' + (copy ? 'copy' : 'symlink') + ')');
      for (const [status, mode, path] of r.rows) console.log(`  ${status.padEnd(7)} ${mode.padEnd(5)} ${path}`);
      console.log('\nPer-project setup (recommended): npx archgen-skill init');
      if (r.failures > 0) { console.error(`${r.failures} target(s) failed`); process.exitCode = 1; }
      break;
    }
    case 'uninstall': {
      // `--project` may carry a directory (`uninstall --project myproj`) or
      // stand alone (`uninstall --project` → this directory). A POSITIONAL
      // directory (`uninstall myproj`) is a project uninstall as well: the
      // GLOBAL uninstall happens only when no project was named at all.
      const explicit = takeValue('--project');
      const positionals = rest.filter((a) => !a.startsWith('-'));
      assertNoUnknownFlags();
      if (positionals.length > 1) {
        throw new Error(`unexpected argument: ${positionals[1]} — give the project directory once`);
      }
      const positional = positionals[0];
      const projectTarget = explicit !== null
        ? (explicit === '' ? process.cwd() : resolve(explicit))
        : (positional !== undefined ? resolve(positional) : null);
      if (explicit !== null && positional !== undefined && projectTarget !== resolve(positional)) {
        throw new Error('give the project directory once: either positionally or with --project');
      }
      if (projectTarget !== null) {
        const r = uninstallProject(projectTarget, PACKAGE_ROOT);
        console.log('archgen: project uninstall — ' + r.root);
        if (r.linkRemoved) console.log('  - .claude/skills/archgen (link)');
        if (r.strippedBlocks.length) console.log('  - managed blocks stripped from ' + r.strippedBlocks.join(', '));
        if (r.storeRemoved) console.log('  - .agents/skills/archgen (unmodified store)');
        if (r.storeKept) console.log('  = .agents/skills/archgen KEPT (customized)');
        if (r.manifestRemoved) console.log('  - .archgen/.install-manifest.json');
        if (r.runtimeRemoved) console.log('  - .archgen/.runtime (legacy extension state)');
        for (const m of r.mcpRemoved ?? []) console.log(`  - ${m} (archgen MCP entry)`);
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
      const dir = targetDir();
      assertNoUnknownFlags();
      const current = cliVersion(PACKAGE_ROOT);
      console.log('archgen update — running v' + current + ', checking npm registry…');
      const latest = fetchLatestVersion('archgen-skill');
      if (!latest) {
        // The registry could not be reached: the update did NOT happen. It
        // exited 0 and said "Nothing changed", which reads like "you are on
        // the latest version" — the one answer an offline machine must not
        // give.
        console.error('  ! could not reach the npm registry (offline?) - the update did NOT run.');
        process.exitCode = 1;
        break;
      }
      const cmp = compareSemver(latest, current);
      if (cmp === null) {
        // The registry answered with something that is not a semver (e.g. a
        // "beta" dist-tag). It is NOT "already the latest version" — refuse
        // instead, and never interpolate it into a command line.
        console.error('  ! registry returned a non-semver version string; refusing: ' + JSON.stringify(latest));
        process.exitCode = 1;
        break;
      }
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
      if (!/^\d+\.\d+\.\d+[-+]?[0-9A-Za-z.-]*$/.test(latest)) {
        // Registry returned something that is not a semver tag — never
        // interpolate it into a command line.
        console.error('  ! registry returned a non-semver version string; refusing: ' + JSON.stringify(latest));
        process.exitCode = 1;
        break;
      }
      console.log('  ↑ newer version available: ' + latest);
      console.log('  upgrading global install: npm install -g archgen-skill@' + latest);
      const inv = npmInvocation(['install', '-g', 'archgen-skill@' + latest]);
      const up = spawnSync(inv.command, inv.args, { stdio: 'inherit', shell: inv.shell });
      if (up.status !== 0) {
        console.error('  ! global upgrade failed — run it manually, then re-run: archgen-skill update');
        process.exitCode = 1;
        break;
      }
      // The running process is the OLD code; re-exec the freshly installed binary.
      // The PATH search would find the FIRST match — often the OLD global
      // install — so the binary npm actually wrote is preferred.
      const freshBin = globalBinPath('archgen-skill') ?? whichOnPath('archgen-skill');
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
      const upDoctor = spawnSync(freshBin, ['doctor', dir], { stdio: 'inherit' });
      if (upDoctor.status !== 0) {
        // A failed doctor must fail the update too — the project was NOT
        // brought to the new version.
        console.error('  ! doctor failed during update (see message above)');
        process.exitCode = upDoctor.status ?? 1;
      }
      break;
    }
    case '--version': case '-v': {
      console.log(cliVersion(PACKAGE_ROOT));
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
  for (const b of r.backups ?? []) console.log('  ~ backup ' + b + ' (edited copy saved before removal)');
  if (r.failed > 0) process.exitCode = 1;
}
