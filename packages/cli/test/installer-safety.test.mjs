// Installer-safety tests (Todo 22): symlink write-through refusal (lstat
// before write), realpath-escape refusal, backup-before-replace, duplicated
// managed-block marker normalization, and install.sh parity for all of it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { installGlobal } from '../lib/install.js';
import { doctorProject } from '../lib/doctor.js';
import {
  END,
  START,
  detectBlockVersion,
  renderBlock,
  stripBlock,
  stripManagedFile,
  upsertBlock,
} from '../lib/block.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(CLI, 'vendor', 'skills', 'archgen');
const INSTALL_SH = join(CLI, '..', '..', 'install.sh');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');
const REFUSE_RE = /Refusing to write through symlink/;

let proj, home, pkgRoot, outsideDirs;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-sec-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ag-sec-home-'));
  pkgRoot = mkdtempSync(join(tmpdir(), 'ag-sec-pkg-'));
  mkdirSync(join(pkgRoot, 'vendor', 'skills'), { recursive: true });
  cpSync(VENDOR, join(pkgRoot, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: 'archgen-skill', version: VERSION }));
  outsideDirs = [];
});

afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(pkgRoot, { recursive: true, force: true });
  for (const d of outsideDirs) rmSync(d, { recursive: true, force: true });
});

function outsideDir() {
  const d = mkdtempSync(join(tmpdir(), 'ag-sec-outside-'));
  outsideDirs.push(d);
  return d;
}

function runInstallSh(args) {
  return spawnSync('bash', [INSTALL_SH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    cwd: proj,
  });
}

// ---- symlink write-through refusal (CLI) ------------------------------------

test('init aborts when the store path is a symlink (lstat before write)', () => {
  const outside = outsideDir();
  writeFileSync(join(outside, 'precious.txt'), 'VICTIM DATA\n');
  mkdirSync(join(proj, '.agents', 'skills'), { recursive: true });
  symlinkSync(outside, STORE(proj));

  assert.throws(() => initProject(proj, CLI), REFUSE_RE);
  assert.ok(lstatSync(STORE(proj)).isSymbolicLink(), 'symlink left in place');
  assert.deepEqual(readdirSync(outside), ['precious.txt'], 'nothing written through the link');
});

test('init aborts when a parent harness dir symlinks outside the project (realpath escape)', () => {
  const outside = outsideDir();
  mkdirSync(join(outside, 'skills'), { recursive: true });
  symlinkSync(outside, join(proj, '.agents'));

  assert.throws(() => initProject(proj, CLI), REFUSE_RE);
  assert.ok(!existsSync(join(outside, 'skills', 'archgen')), 'nothing created through the escape');
});

test('init aborts when AGENTS.md is a symlink; victim file untouched', () => {
  const victim = join(outsideDir(), 'victim.md');
  writeFileSync(victim, 'VICTIM CONTENT\n');
  symlinkSync(victim, join(proj, 'AGENTS.md'));

  assert.throws(() => initProject(proj, CLI), REFUSE_RE);
  assert.equal(readFileSync(victim, 'utf8'), 'VICTIM CONTENT\n');
  assert.ok(lstatSync(join(proj, 'AGENTS.md')).isSymbolicLink(), 'symlink left in place');
});

test('stripManagedFile refuses a symlinked managed file (uninstall path)', () => {
  const victim = join(outsideDir(), 'victim.md');
  writeFileSync(victim, START + '\nmanaged\n' + END + '\n');
  symlinkSync(victim, join(proj, 'AGENTS.md'));

  assert.throws(() => stripManagedFile(join(proj, 'AGENTS.md')), REFUSE_RE);
  assert.ok(readFileSync(victim, 'utf8').includes('archgen:start'), 'victim not stripped through the link');
});

test('doctor reports FAIL (no write-through) for a dangling-symlink AGENTS.md', () => {
  symlinkSync(join(proj, 'nonexistent-target'), join(proj, 'AGENTS.md'));
  const d = doctorProject(proj, CLI);
  assert.ok(
    d.checks.some((c) => c.status === 'FAIL' && REFUSE_RE.test(c.msg)),
    `expected a symlink-refusal FAIL row, got: ${JSON.stringify(d.checks)}`,
  );
  assert.ok(lstatSync(join(proj, 'AGENTS.md')).isSymbolicLink(), 'dangling symlink untouched');
  assert.ok(!existsSync(join(proj, 'nonexistent-target')), 'no file created at the link target');
});

// ---- symlink write-through refusal (global install) --------------------------

test('global --copy install refuses a foreign symlinked harness dir (lstat before write)', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const outside = outsideDir();
  const dest = join(home, '.claude', 'skills', 'archgen');
  symlinkSync(outside, dest);

  const r = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.ok(r.failures >= 1);
  const row = r.rows.find((x) => x[2].startsWith(dest));
  assert.equal(row[0], 'FAILED');
  assert.match(row[2], REFUSE_RE);
  assert.ok(lstatSync(dest).isSymbolicLink(), 'foreign symlink untouched');
  assert.deepEqual(readdirSync(outside), [], 'symlink target untouched');
});

test('global --copy converts our own link install into a real copy (success path preserved)', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const r1 = installGlobal({ home, packageRoot: pkgRoot });
  assert.equal(r1.failures, 0);
  const dest = join(home, '.claude', 'skills', 'archgen');
  assert.ok(lstatSync(dest).isSymbolicLink());

  const r2 = installGlobal({ home, packageRoot: pkgRoot, copy: true });
  assert.equal(r2.failures, 0, JSON.stringify(r2.rows));
  const st = lstatSync(dest);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), 'our link upgraded to a real copy');
  assert.ok(existsSync(join(dest, 'SKILL.md')));
});

// ---- duplicated managed-block marker normalization ---------------------------

test('upsertBlock collapses duplicated blocks to exactly one (user content kept)', () => {
  const two = 'HEAD\n' + START + '\nold a\n' + END + '\nMID\n' + START + '\nold b\n' + END + '\nTAIL\n';
  const out = upsertBlock(two, renderBlock());
  assert.equal(out.split(START).length, 2, 'exactly one start marker remains');
  assert.equal(out.split(END).length, 2, 'exactly one end marker remains');
  assert.ok(out.startsWith('HEAD\n'), 'prefix preserved');
  assert.ok(out.includes('\nMID\n') && out.includes('TAIL'), 'content between/after blocks preserved');
  assert.ok(!out.includes('old a') && !out.includes('old b'), 'stale block bodies removed');
  assert.deepEqual(detectBlockVersion(out), { present: true, version: VERSION });
});

test('upsertBlock still throws on orphan markers left after dedup', () => {
  assert.throws(() => upsertBlock(START + '\na\n' + END + '\n' + START + '\norphan\n', 'B'), /one archgen marker/);
  assert.throws(() => upsertBlock(START + '\n' + START + '\n', 'B'), /one archgen marker/);
});

test('stripBlock removes every duplicated block', () => {
  const { content, hadBlock } = stripBlock('x\n' + START + '\na\n' + END + '\ny\n' + START + '\nb\n' + END + '\n');
  assert.equal(hadBlock, true);
  assert.ok(!content.includes('archgen:start'), 'all blocks stripped');
  assert.ok(content.includes('x') && content.includes('y'), 'user content kept');
});

test('install normalizes a file with two start markers to exactly one block', () => {
  writeFileSync(join(proj, 'AGENTS.md'), 'x\n' + START + '\na\n' + END + '\n' + START + '\nb\n' + END + '\n');
  const r = initProject(proj, CLI);
  assert.ok(r.contextFiles.includes('AGENTS.md'));
  const after = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.equal(after.split(START).length, 2, 'exactly one managed block after install');
  assert.equal(after.split(END).length, 2);
  assert.ok(after.startsWith('x\n'), 'user content preserved');
  assert.ok(!after.includes('\na\n') && !after.includes('\nb\n'), 'stale block bodies gone');
});

// ---- install.sh parity --------------------------------------------------------

test('install.sh --init aborts on a symlinked AGENTS.md; victim untouched', () => {
  const victim = join(home, 'victim.md');
  writeFileSync(victim, 'VICTIM\n');
  symlinkSync(victim, join(proj, 'AGENTS.md'));

  const r = runInstallSh(['--init', proj]);
  assert.notEqual(r.status, 0, 'install.sh must abort');
  assert.match(r.stderr, REFUSE_RE);
  assert.equal(readFileSync(victim, 'utf8'), 'VICTIM\n');
});

test('install.sh --copy refuses a foreign symlinked harness dir', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const outside = join(home, 'outside-target');
  mkdirSync(outside);
  symlinkSync(outside, join(home, '.claude', 'skills', 'archgen'));

  const r = runInstallSh(['--copy']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /Refusing to write through symlink/);
  assert.ok(lstatSync(join(home, '.claude', 'skills', 'archgen')).isSymbolicLink(), 'symlink untouched');
  assert.deepEqual(readdirSync(outside), [], 'symlink target untouched');
});

test('install.sh link mode keeps a live foreign symlink and does not record it', () => {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const usersOwn = join(home, 'users-own');
  mkdirSync(usersOwn);
  writeFileSync(join(usersOwn, 'SKILL.md'), 'user skill\n');
  symlinkSync(usersOwn, join(home, '.claude', 'skills', 'archgen'));

  const r = runInstallSh([]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /KEPT/);
  assert.equal(readlinkSync(join(home, '.claude', 'skills', 'archgen')), usersOwn, 'user link untouched');
  const manifest = join(home, '.archgen-install-manifest.list');
  assert.ok(!existsSync(manifest) || !readFileSync(manifest, 'utf8').includes('.claude'), 'foreign link not recorded');
});

test('install.sh --init normalizes duplicated managed blocks to one', () => {
  writeFileSync(join(proj, 'AGENTS.md'), 'x\n' + START + '\na\n' + END + '\n' + START + '\nb\n' + END + '\n');
  const r = runInstallSh(['--init', proj]);
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.equal(after.split('<!-- archgen:start').length, 2, 'exactly one block after normalization');
  assert.ok(after.includes('x'), 'user content preserved');
  assert.ok(!after.includes('\na\n') && !after.includes('\nb\n'), 'stale block bodies gone');
});

test('install.sh --init happy path still succeeds and is idempotent', () => {
  const r = runInstallSh(['--init', proj]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(STORE(proj), 'SKILL.md')), 'canonical store created');
  const agents = readFileSync(join(proj, 'AGENTS.md'), 'utf8');
  assert.equal(agents.split('<!-- archgen:start').length, 2);

  const r2 = runInstallSh(['--init', proj]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(proj, 'AGENTS.md'), 'utf8').split('<!-- archgen:start').length, 2);
});
