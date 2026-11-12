// dev-excludes.test.mjs — what must never reach end users, and what must be
// cleaned out of stores carried over from an older layout.
//
// The skill used to ship a scripts/ tree (11 scripts + a lib/ folder). It no
// longer does: every capability moved into the archgen MCP server. So:
//   - a FRESH install must contain NO scripts/ tree at all;
//   - an install carried over from the pre-MCP layout must have that tree
//     PRUNED (it is dead weight, and it would otherwise read as a customized
//     store);
//   - the dev-only exclusion list keeps its meaning: repo-only test tooling
//     never ships and never reads as divergence.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashDir, DEV_ONLY_RELPATHS, OBSOLETE_RELPATHS } from '../../lib/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, '..', '..'); // packages/cli
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

test('the dev-only exclusion list is exactly scripts/test', () => {
  assert.deepEqual(DEV_ONLY_RELPATHS, ['scripts/test']);
});

test('the obsolete list names the pre-MCP code tree', () => {
  assert.deepEqual(OBSOLETE_RELPATHS, ['scripts']);
});

test('a fresh init ships NO scripts tree at all (the skill carries no code)', () => {
  const proj = initProject();
  const store = storeOf(proj);
  assert.ok(existsSync(join(store, 'SKILL.md')), 'SKILL.md must be installed');
  assert.ok(existsSync(join(store, 'references')), 'references must be installed');
  assert.ok(!existsSync(join(store, 'scripts')), 'the skill must ship no scripts tree');
});

test('doctor prunes an obsolete scripts/ tree from an upgraded store', () => {
  const proj = initProject();
  const store = storeOf(proj);
  // Simulate an install carried over from the pre-MCP layout.
  mkdirSync(join(store, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(store, 'scripts', 'lib', 'yaml.mjs'), 'export const x = 1;\n');
  writeFileSync(join(store, 'scripts', 'next-tasks.mjs'), '// old\n');

  // --check reports without mutating.
  const check = runCli(['doctor', proj, '--check']);
  assert.equal(check.status, 0, check.stderr + check.stdout);
  assert.match(check.stdout, /obsolete scripts\/ tree/i);
  assert.ok(existsSync(join(store, 'scripts')), '--check must not mutate the store');

  // Repair mode prunes it — and does NOT cry "diverges from packaged skill".
  const fix = runCli(['doctor', proj]);
  assert.equal(fix.status, 0, fix.stderr + fix.stdout);
  assert.ok(!existsSync(join(store, 'scripts')), 'doctor must prune the obsolete scripts tree');
  assert.doesNotMatch(fix.stdout, /diverges from packaged skill/i);
});

test('re-init replaces an obsolete scripts/ tree wholesale', () => {
  const proj = initProject();
  const store = storeOf(proj);
  mkdirSync(join(store, 'scripts'), { recursive: true });
  writeFileSync(join(store, 'scripts', 'stale.mjs'), '// old\n');
  const r = runCli(['init', proj]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!existsSync(join(store, 'scripts')), 're-init must not restore the obsolete tree');
});

test('hashDir still flags a real content edit as divergent', () => {
  const a = mkdtempSync(join(tmpdir(), 'archgen-hash-a-'));
  const b = mkdtempSync(join(tmpdir(), 'archgen-hash-b-'));
  try {
    for (const root of [a, b]) {
      mkdirSync(join(root, 'references'), { recursive: true });
      writeFileSync(join(root, 'SKILL.md'), '# skill\n');
      writeFileSync(join(root, 'references', 'a.md'), 'x\n');
    }
    assert.equal(hashDir(a), hashDir(b), 'identical trees hash equal');
    writeFileSync(join(b, 'references', 'a.md'), 'y\n');
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
      writeFileSync(join(root, 'SKILL.md'), '# skill\n');
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
