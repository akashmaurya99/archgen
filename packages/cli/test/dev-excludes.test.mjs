// dev-excludes.test.mjs — dev-only artifacts (scripts/test) must never reach
// end users: not in a fresh `init` store, not in the npm vendor payload, and
// cleaned out of existing stores on re-init/doctor — all WITHOUT weakening
// hashDir's real-divergence detection and WITHOUT excluding scripts/lib (a
// runtime dependency of the skill scripts).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDir, DEV_ONLY_RELPATHS } from '../lib/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, '..'); // packages/cli
const BIN = join(CLI_ROOT, 'bin', 'archgen.mjs');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archgen-devex-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir, ...opts });
}
function initProject(proj = dir) {
  const r = spawnSync(process.execPath, [BIN, 'init', proj], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return proj;
}
function storeOf(proj) {
  return join(proj, '.agents', 'skills', 'archgen');
}

test('the shared dev-only exclusion list is exactly scripts/test (scripts/lib is NOT excluded)', () => {
  assert.deepEqual(DEV_ONLY_RELPATHS, ['scripts/test']);
  assert.ok(!DEV_ONLY_RELPATHS.some((p) => p === 'scripts/lib' || p.startsWith('scripts/lib/')),
    'scripts/lib is a runtime dependency and must never be dev-only-excluded');
});

test('fresh init installs scripts/lib but NOT the dev-only scripts/test', () => {
  const proj = initProject();
  const store = storeOf(proj);
  assert.ok(existsSync(join(store, 'SKILL.md')), 'SKILL.md must be installed');
  assert.ok(existsSync(join(store, 'scripts', 'lib')), 'scripts/lib must be installed (runtime dependency)');
  assert.ok(!existsSync(join(store, 'scripts', 'test')), 'dev-only scripts/test must NOT be installed');
});

test('re-init prunes a stale scripts/test from an existing store without error or spurious backup', () => {
  const proj = initProject();
  const store = storeOf(proj);
  // Simulate an older installer that shipped the dev-only suite into the store.
  mkdirSync(join(store, 'scripts', 'test'), { recursive: true });
  writeFileSync(join(store, 'scripts', 'test', 'stale.test.mjs'), '// stale dev-only test\n');
  const r = runCli(['init', proj]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(join(store, 'scripts', 'test')), 'stale scripts/test must be pruned on re-init');
  assert.ok(existsSync(join(store, 'scripts', 'lib')), 'scripts/lib must survive re-init');
  // The store hashed identical (scripts/test is ignored on both sides of
  // hashDir), so re-init must NOT have moved it aside into a backup.
  assert.ok(!existsSync(join(proj, '.archgen', '.backup')),
    're-init must not create a spurious full-store backup for a store that only carried scripts/test');
});

test('doctor prunes a stale scripts/test from an existing store (--check reports, repair removes)', () => {
  const proj = initProject();
  const store = storeOf(proj);
  mkdirSync(join(store, 'scripts', 'test'), { recursive: true });
  writeFileSync(join(store, 'scripts', 'test', 'stale.test.mjs'), '// stale dev-only test\n');
  // --check reports without mutating.
  const check = runCli(['doctor', proj, '--check']);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /scripts\/test/i);
  assert.ok(existsSync(join(store, 'scripts', 'test')), '--check must not mutate the store');
  // Repair mode prunes it, keeps scripts/lib, and does not cry "divergent".
  const fix = runCli(['doctor', proj]);
  assert.equal(fix.status, 0, fix.stderr + fix.stdout);
  assert.ok(!existsSync(join(store, 'scripts', 'test')), 'doctor must prune the dev-only scripts/test');
  assert.ok(existsSync(join(store, 'scripts', 'lib')), 'scripts/lib must survive doctor');
  assert.doesNotMatch(fix.stdout, /diverges from packaged skill/i);
});

test('hashDir still flags a real content edit as divergent', () => {
  const a = mkdtempSync(join(tmpdir(), 'archgen-hash-a-'));
  const b = mkdtempSync(join(tmpdir(), 'archgen-hash-b-'));
  try {
    for (const root of [a, b]) {
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
      writeFileSync(join(root, 'SKILL.md'), '# skill\n');
      writeFileSync(join(root, 'scripts', 'lib', 'yaml.mjs'), 'export const x = 1;\n');
    }
    assert.equal(hashDir(a), hashDir(b), 'identical trees hash equal');
    writeFileSync(join(b, 'scripts', 'lib', 'yaml.mjs'), 'export const x = 2;\n');
    assert.notEqual(hashDir(a), hashDir(b), 'a real content edit must read as divergent');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('hashDir ignores scripts/test on both sides (dev-only presence is not divergence)', () => {
  const a = mkdtempSync(join(tmpdir(), 'archgen-hash-c-'));
  const b = mkdtempSync(join(tmpdir(), 'archgen-hash-d-'));
  try {
    for (const root of [a, b]) {
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
      writeFileSync(join(root, 'SKILL.md'), '# skill\n');
      writeFileSync(join(root, 'scripts', 'lib', 'yaml.mjs'), 'export const x = 1;\n');
    }
    assert.equal(hashDir(a), hashDir(b));
    mkdirSync(join(a, 'scripts', 'test'), { recursive: true });
    writeFileSync(join(a, 'scripts', 'test', 'foo.test.mjs'), '// dev only\n');
    assert.equal(hashDir(a), hashDir(b),
      'scripts/test present on one side only must not read as divergence');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
