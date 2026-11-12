// installer-audit.test.mjs — the installer audit's findings, pinned.
//
// WHY THIS FILE EXISTS.
//
// An adversarial audit of install.sh and packages/cli found behaviours that
// were wrong rather than merely imperfect:
//
//   - `archgen uninstall <dir>` asked the MCP server to remove the wiring
//     with the default scope, which is BOTH — so removing one project tore
//     down the global wiring every other project shares;
//   - a GLOBAL install wrote its wiring manifest into whatever directory the
//     user happened to run it from;
//   - the global uninstall's allowlist was built from the CURRENT directory,
//     so an install made elsewhere could never be removed;
//   - `archgen doctor` CREATED the claude link, AGENTS.md and CLAUDE.md in a
//     project that had never been installed;
//   - `archgen restore --target <dir>` was documented and implemented, and
//     the flag parser refused it.
//
// Every one of them is a behaviour, so every one of them belongs here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installGlobal, uninstallGlobal, recordRoot, recordedRoots } from '../../lib/install.js';
import { doctorProject } from '../../lib/doctor.js';
import { restoreMain } from '../../lib/restore.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(CLI, 'bin', 'archgen.mjs');

let proj, home, mcpStub, mcpArgs;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-audit-'));
  home = join(proj, 'home');
  mkdirSync(home, { recursive: true });
  mcpArgs = join(proj, 'mcp-args.txt');
  // The MCP stub RECORDS its arguments: the scope of an uninstall is decided
  // in the arguments, not in the exit code.
  mcpStub = join(proj, 'mcp-stub.js');
  writeFileSync(
    mcpStub,
    `#!/usr/bin/env node\n` +
      `require('node:fs').appendFileSync(${JSON.stringify(mcpArgs)}, process.argv.slice(2).join(' ') + '\\n');\n` +
      `console.log(JSON.stringify({ removed: [], skipped: [] }));\n`,
    { mode: 0o755 },
  );
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

/** Run the CLI in a scratch cwd; never touches the real project. */
function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: proj,
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHGEN_CODEGRAPH: '0',
      ARCHGEN_MCP_BIN: mcpStub,
      HOME: home,
      ...extraEnv,
    },
  });
}

test('a project uninstall asks for the PROJECT scope only', () => {
  const target = join(proj, 'myproj');
  mkdirSync(target, { recursive: true });
  const r = run(['uninstall', target]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = existsSync(mcpArgs) ? readFileSync(mcpArgs, 'utf8') : '';
  assert.match(calls, /uninstall-mcp/, 'the MCP server was asked to remove the wiring');
  assert.match(calls, /--location project/, 'the scope is PROJECT — the global wiring is shared');
  assert.doesNotMatch(calls, /--location both/, 'the scope is never BOTH');
});

test('a GLOBAL install does not write into the directory it was run from', () => {
  // The wiring manifest belongs to the global scope. It used to be written
  // under the current directory, so a global install littered the user's
  // project with .archgen/.
  const r = installGlobal({ home, packageRoot: CLI, codegraph: false, mcp: false });
  assert.equal(r.failures, 0, 'the install itself succeeded');
  assert.ok(!existsSync(join(proj, '.archgen')), 'nothing was written into the working directory');
});

test('the global uninstall removes a destination recorded for another directory', () => {
  // The allowlist was built from the CURRENT directory, so an install made
  // in one directory could never be removed from another.
  const other = join(proj, 'other-project');
  const dest = join(other, '.github', 'skills', 'archgen');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'SKILL.md'), 'x', 'utf8');
  recordRoot(home, other);
  assert.deepEqual(recordedRoots(home), [other], 'the root is recorded');
  writeFileSync(
    join(home, '.archgen-install-manifest.list'),
    `copy\t${dest}\n`,
    'utf8',
  );

  const r = uninstallGlobal(home, { packageRoot: CLI });
  assert.equal(r.failed, 0, 'the entry was recognised');
  assert.equal(r.removed, 1, 'the destination was removed');
  assert.ok(!existsSync(dest), 'the destination is gone');
});

test('the doctor creates NOTHING in a project that has no install', () => {
  const target = join(proj, 'not-installed');
  mkdirSync(target, { recursive: true });
  const d = doctorProject(target, CLI);
  assert.ok(!existsSync(join(target, 'AGENTS.md')), 'AGENTS.md was not created');
  assert.ok(!existsSync(join(target, 'CLAUDE.md')), 'CLAUDE.md was not created');
  assert.ok(!existsSync(join(target, '.claude')), 'the claude link was not created');
  assert.ok(
    d.checks.some((c) => c.msg.includes('no archgen install')),
    'the doctor says the project has no install',
  );
});

test('the doctor DOES repair an installed project', () => {
  const target = join(proj, 'installed');
  mkdirSync(join(target, '.agents', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(target, '.agents', 'skills', 'archgen', 'SKILL.md'), 'x', 'utf8');
  const d = doctorProject(target, CLI);
  assert.ok(existsSync(join(target, 'AGENTS.md')), 'the pointer block was written');
  assert.ok(existsSync(join(target, '.claude', 'skills', 'archgen')), 'the claude link was created');
  assert.ok(d.checks.some((c) => c.status === 'OK' || c.status === 'FIXED'), 'the install was inspected');
});

test('`archgen restore --target <dir>` restores into the named directory', async () => {
  // The flag was documented in the command's own help and implemented in the
  // restore engine, and the flag parser refused it.
  const source = join(proj, 'source');
  // The snapshot mirrors the layout it restores: <vault>/<ts>/<relative path>.
  const snapshot = join(source, '.archgen', '.backup', '2026-01-01-00-00-00', '.agents', 'skills', 'archgen');
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, 'SKILL.md'), 'restored content', 'utf8');
  const dest = join(proj, 'restored-into');
  mkdirSync(dest, { recursive: true });

  const code = await restoreMain(['--project', source, '--snapshot', '2026-01-01-00-00-00', '--target', dest]);
  assert.equal(code, 0, 'the restore succeeded');
  assert.ok(
    existsSync(join(dest, '.agents', 'skills', 'archgen', 'SKILL.md')),
    'the snapshot landed in the TARGET directory',
  );
});
