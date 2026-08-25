#!/usr/bin/env node
// archgen — npm CLI for the archgen skill.
//
//   npx archgen-skill init            Install skill into THIS project + write
//                               AGENTS.md / CLAUDE.md context pointers
//   npx archgen-skill install         Install skill into global harness dirs
//                               (Claude Code, OpenCode, Cursor, agentskills)
//   npx archgen-skill uninstall       Remove globally-installed copies (manifest-based)
//
// Zero dependencies. Cross-platform (Windows included — no bash required).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal, uninstallGlobal } from '../lib/install.js';
import { initProject } from '../lib/init.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `archgen — architecture generation & autonomous task execution for coding agents

Usage:
  npx archgen-skill init [dir]        Prepare a project: copy the skill into
                                .agents/skills/archgen + .claude/skills/archgen
                                and generate AGENTS.md / CLAUDE.md pointer blocks
                                so every agent harness auto-discovers it.
  npx archgen-skill install           Install into global harness skill dirs
    [--copy]                      real copies instead of symlinks
    [--uninstall]                 remove manifest-recorded entries
  npx archgen-skill uninstall         Alias for install --uninstall
  npx archgen-skill --help            This help

Docs: https://github.com/akash/archgen`;

const [, , cmd, ...rest] = process.argv;

function flag(name) {
  const i = rest.indexOf(name);
  if (i === -1) return false;
  rest.splice(i, 1);
  return true;
}

try {
  switch (cmd) {
    case 'init': {
      const dir = rest[0] ? resolve(rest[0]) : process.cwd();
      const r = initProject(dir, PACKAGE_ROOT);
      console.log('archgen: skill installed into project');
      for (const p of r.skillCopies) console.log('  + ' + p);
      for (const f of r.contextFiles) {
        console.log(`  ${r.createdContextFiles.includes(f) ? 'created' : 'updated'} ${f} (archgen pointer block)`);
      }
      console.log('\nNext: open this project in your agent and say "generate architecture" or "add feature X".');
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
      uninstall();
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
