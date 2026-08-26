// Version-stamp contract tests: `.archgen-version` (exact `MAJOR.MINOR.PATCH\n`)
// written by every flow that lays down skill files — init, global install in
// symlink AND --copy mode, update-style refreshes — readable through links,
// tolerant readers, doctor inventory lines, and removal on uninstall.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { installGlobal } from '../lib/install.js';
import { doctorProject } from '../lib/doctor.js';
import { uninstallProject } from '../lib/uninstall-project.js';
import { readStamp, writeStamp } from '../lib/version-stamp.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(CLI, 'vendor', 'skills', 'archgen');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');
const STAMP = '.archgen-version';

let proj, home, pkgRoot;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-stamp-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ag-stamp-home-'));
  // Hermetic package root: a private vendor copy + package.json so global
  // install tests never stamp the repo's own vendor/ tree.
  pkgRoot = mkdtempSync(join(tmpdir(), 'ag-stamp-pkg-'));
  mkdirSync(join(pkgRoot, 'vendor', 'skills'), { recursive: true });
  cpSync(VENDOR, join(pkgRoot, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'archgen-skill', version: VERSION }));
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
});

test('writeStamp/readStamp: exact bytes, idempotent overwrite, tolerant read, garbage rejected', () => {
  const tree = join(proj, 'skilltree');
  writeStamp(tree, '1.2.3');
  assert.equal(readFileSync(join(tree, STAMP), 'utf8'), '1.2.3\n', 'EXACT content incl trailing newline');
  assert.equal(readStamp(tree), '1.2.3');
  writeStamp(tree, '1.2.3');
  assert.equal(readFileSync(join(tree, STAMP), 'utf8'), '1.2.3\n', 'same-version rewrite is byte-identical');

  for (const [raw, want] of [['0.0.3\r\n', '0.0.3'], ['  9.9.9 \n\t', '9.9.9'], ['\n0.4.1\n', '0.4.1']]) {
    writeFileSync(join(tree, STAMP), raw);
    assert.equal(readStamp(tree), want, `${JSON.stringify(raw)} tolerated`);
  }
  for (const bad of ['', '   ', 'abc', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta']) {
    writeFileSync(join(tree, STAMP), bad + '\n');
    assert.equal(readStamp(tree), null, `${JSON.stringify(bad)} rejected as unknown`);
  }
  assert.equal(readStamp(join(proj, 'nope')), null, 'missing file reads as unknown');
});

test('init leaves the exact stamp in the canonical store; re-init keeps it fresh without backup', () => {
  initProject(proj, CLI);
  assert.equal(readFileSync(join(STORE(proj), STAMP), 'utf8'), VERSION + '\n');

  const r2 = initProject(proj, CLI);
  assert.deepEqual(r2.backups, [], 'stamp must never read as divergence');
  assert.equal(readFileSync(join(STORE(proj), STAMP), 'utf8'), VERSION + '\n');
});

test('update-style refresh rewrites a stale stamp; doctor repairs a corrupt one', () => {
  initProject(proj, CLI);
  writeFileSync(join(STORE(proj), STAMP), '0.0.1\n'); // simulate older CLI
  initProject(proj, CLI); // what `update` runs via runInitAndDoctor
  assert.equal(readFileSync(join(STORE(proj), STAMP), 'utf8'), VERSION + '\n');

  writeFileSync(join(STORE(proj), STAMP), 'garbage\n');
  const d = doctorProject(proj, CLI, { home });
  assert.equal(d.failures, 0);
  assert.ok(d.checks.some((c) => c.status === 'FIXED' && /version stamp updated/.test(c.msg)));
  assert.equal(readFileSync(join(STORE(proj), STAMP), 'utf8'), VERSION + '\n');
});

test('install --copy stamps every copied tree with exact bytes', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.cursor', 'skills'), { recursive: true });
  const r = installGlobal({ home, copy: true, packageRoot: pkgRoot });
  assert.equal(r.failures, 0);
  const copies = r.rows.filter((row) => row[0] === 'OK' && row[1] === 'copy');
  assert.equal(copies.length, 2);
  for (const [, , dest] of copies) {
    assert.equal(readFileSync(join(dest, STAMP), 'utf8'), VERSION + '\n', `stamp in ${dest}`);
    assert.equal(readStamp(dest), VERSION);
  }
});

test('symlink-mode install: stamp readable THROUGH the link, bytes inside the resolved target', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const source = join(pkgRoot, 'vendor', 'skills', 'archgen');
  const r = installGlobal({ home, packageRoot: pkgRoot });
  assert.equal(r.failures, 0);

  const link = join(home, '.claude', 'skills', 'archgen');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(join(link, STAMP), 'utf8'), VERSION + '\n', 'read through the link');
  assert.equal(readFileSync(join(source, STAMP), 'utf8'), VERSION + '\n', 'physical bytes in the real dir');

  const r2 = installGlobal({ home, packageRoot: pkgRoot }); // SAME path stays stamped
  assert.ok(r2.rows.some((row) => row[0] === 'SAME'));
  assert.equal(readFileSync(join(link, STAMP), 'utf8'), VERSION + '\n');
});

test('uninstall removes the store dir so the stamp disappears with it', () => {
  initProject(proj, CLI);
  const stamp = join(STORE(proj), STAMP);
  assert.ok(existsSync(stamp));
  const u = uninstallProject(proj, CLI);
  assert.equal(u.storeRemoved, true);
  assert.ok(!existsSync(stamp));
});

test('doctor reports one line per detected install: project store + globals', () => {
  initProject(proj, CLI);
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  installGlobal({ home, packageRoot: pkgRoot });

  const d = doctorProject(proj, CLI, { home });
  const inv = d.checks.filter((c) => /^skill /.test(c.msg));
  assert.ok(
    inv.some((c) => c.status === 'OK' && c.msg.includes(join(proj, '.agents', 'skills', 'archgen')) && c.msg.endsWith(`: ${VERSION}`)),
    'project store line with resolved path + version',
  );
  assert.ok(
    inv.some((c) => c.status === 'OK' && c.msg.includes(join(home, '.claude', 'skills', 'archgen')) && c.msg.endsWith(`: ${VERSION}`)),
    'global symlinked install line',
  );
  assert.equal(d.failures, 0);

  mkdirSync(join(home, '.cursor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(home, '.cursor', 'skills', 'archgen', 'SKILL.md'), 'legacy\n');
  const d2 = doctorProject(proj, CLI, { home });
  assert.ok(
    d2.checks.some((c) => c.status === 'WARN' && c.msg.includes('.cursor') && c.msg.endsWith(': missing')),
    'unstamped legacy tree reported as missing',
  );

  writeFileSync(join(home, '.cursor', 'skills', 'archgen', STAMP), 'junk\n');
  const d3 = doctorProject(proj, CLI, { home });
  assert.ok(
    d3.checks.some((c) => c.msg.includes('.cursor') && c.msg.includes('unknown (pre-0.1 stamp)')),
    'corrupt stamp reported as unknown',
  );
  assert.equal(d3.failures, 0);
});
