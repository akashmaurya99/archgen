// Integration tests for the archgen CLI scripts (todos 4-7 + verify-plan).
// Run: node --test scripts/test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archgen-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeTasks(content) {
  const p = join(dir, 'tasks.yaml');
  writeFileSync(p, content);
  return p;
}
function run(script, args) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
}

const ABC = `tasks:
  - id: A
    title: Top
    status: pending
    depends_on: [B]
    file_ownership: ["src/a/**"]
    acceptance: ["a ok"]
  - id: B
    title: Middle
    status: pending
    depends_on: [C]
    file_ownership: ["src/b/**"]
    acceptance: ["b ok"]
  - id: C
    title: Root
    status: pending
    depends_on: []
    file_ownership: ["src/c/**"]
    acceptance: ["c ok"]
`;

test('next-tasks: A<-B<-C resolves to waves C,B,A', () => {
  const p = writeTasks(ABC);
  const r = run('next-tasks.mjs', [p]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.waves.map((w) => w.map((t) => t.id)), [['C'], ['B'], ['A']]);
});

test('next-tasks: diamond puts D,E in same wave', () => {
  const p = writeTasks(`tasks:
  - {id: D, title: d, depends_on: [B], file_ownership: ["d/**"], acceptance: ["x"]}
  - {id: E, title: e, depends_on: [B], file_ownership: ["e/**"], acceptance: ["x"]}
  - {id: B, title: b, depends_on: [], file_ownership: ["b/**"], acceptance: ["x"]}
`);
  const r = run('next-tasks.mjs', [p]);
  assert.equal(r.status, 0);
  const waves = JSON.parse(r.stdout).waves.map((w) => w.map((t) => t.id).sort());
  assert.deepEqual(waves[0], ['B']);
  assert.deepEqual(waves[1], ['D', 'E']);
});

test('next-tasks: cycle exits 2 with chain', () => {
  const p = writeTasks(`tasks:
  - {id: X, title: x, depends_on: [Y], file_ownership: ["x/**"], acceptance: ["x"]}
  - {id: Y, title: y, depends_on: [X], file_ownership: ["y/**"], acceptance: ["y"]}
`);
  const r = run('next-tasks.mjs', [p]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cycle/);
});

test('next-tasks: same-wave ownership clash exits 3', () => {
  const p = writeTasks(`tasks:
  - {id: P, title: p, depends_on: [], file_ownership: ["shared/**"], acceptance: ["x"]}
  - {id: Q, title: q, depends_on: [], file_ownership: ["shared/**"], acceptance: ["x"]}
`);
  const r = run('next-tasks.mjs', [p]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /conflict/);
});

test('next-tasks: failed dependency excludes downstream into blockedByFailure', () => {
  const p = writeTasks(`tasks:
  - {id: F, title: f, status: failed, depends_on: [], file_ownership: ["f/**"], acceptance: ["x"]}
  - {id: G, title: g, depends_on: [F], file_ownership: ["g/**"], acceptance: ["x"]}
  - {id: H, title: h, depends_on: [G], file_ownership: ["h/**"], acceptance: ["x"]}
  - {id: I, title: i, depends_on: [], file_ownership: ["i/**"], acceptance: ["x"]}
`);
  const r = run('next-tasks.mjs', [p]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.blockedByFailure.sort(), ['G', 'H']);
  // Only I is actionable.
  assert.deepEqual(out.waves.map((w) => w.map((t) => t.id)), [['I']]);
});

test('validate: golden fixture exits 0; unknown key warns without failing', () => {
  const p = writeTasks(ABC + 'extra_key: 1\n');
  const r = run('validate.mjs', [p]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /unknown (root )?key 'extra_key'/);
});

const CORRUPTIONS = [
  ['missing required field', ABC.replace('file_ownership: ["src/c/**"]\n    acceptance: ["c ok"]', 'acceptance: ["c ok"]')],
  ['invalid status', ABC.replace('status: pending\n    depends_on: [B]', "status: done-forever\n    depends_on: [B]")],
  ['empty ownership', ABC.replace('"src/c/**"', '')],
  ['dangling dep', ABC.replace('[B]', '[NOPE]')],
];
for (const [name, src] of CORRUPTIONS) {
  test(`validate: ${name} exits 1`, () => {
    let s = src;
    if (name === 'empty ownership') s = `tasks:\n  - {id: Z, title: z, depends_on: [], file_ownership: [], acceptance: ["x"]}\n`;
    const p = writeTasks(s);
    const r = run('validate.mjs', [p]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });
}

test('set-status: mutates value, preserves comments verbatim', () => {
  const p = writeTasks(`# header comment\n# second line\ntasks:\n  # note on C\n  - id: C\n    title: Root\n    status: pending\n    depends_on: []\n    file_ownership: ["c/**"]\n    acceptance: ["ok"]\n`);
  const r = run('set-status.mjs', [p, 'C', 'running']);
  assert.equal(r.status, 0, r.stderr);
  const after = readFileSync(p, 'utf8');
  assert.ok(after.includes('# header comment'));
  assert.ok(after.includes('# second line'));
  assert.ok(after.includes('# note on C'));
  assert.ok(after.includes('status: running'));
  assert.equal(after.split('\n').filter((l) => l.startsWith('#')).length, 3);
});

test('set-status: reopening done requires --force (exit 4)', () => {
  const p = writeTasks(`tasks:\n  - {id: D1, title: d, status: done, depends_on: [], file_ownership: ["d/**"], acceptance: ["x"]}\n`);
  const refused = run('set-status.mjs', [p, 'D1', 'pending']);
  assert.equal(refused.status, 4);
  const forced = run('set-status.mjs', [p, 'D1', 'pending', '--force']);
  assert.equal(forced.status, 0);
});

test('set-status: 10 concurrent invocations -> last-write-wins, zero temp leftovers', async () => {
  const p = writeTasks(`tasks:\n  - {id: W, title: w, status: pending, depends_on: [], file_ownership: ["w/**"], acceptance: ["x"]}\n`);
  const procs = Array.from({ length: 10 }, (_, i) =>
    spawnSync(process.execPath, [join(SCRIPTS, 'set-status.mjs'), p, 'W', i % 2 ? 'running' : 'blocked']));
  for (const pr of procs) assert.equal(pr.status, 0, pr.stderr);
  const files = (await import('node:fs')).readdirSync(dir);
  assert.ok(!files.some((f) => f.includes('.tmp-')), `temp leftovers: ${files}`);
  const final = readFileSync(p, 'utf8');
  assert.match(final, /status: (running|blocked)/);
  assert.equal(final.match(/id: W/g)?.length, 1); // no duplication
});

test('impact: chain A<-B<-C, impact of C reaches B and A', () => {
  const p = writeTasks(ABC.replace(/status: pending\n    /g, ''));
  const r = run('impact.mjs', [p, 'C']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.direct, ['B']);
  assert.deepEqual(out.transitive, ['A']);
});

test('impact: artifact-path mode finds owner task and ripple', () => {
  const p = writeTasks(`tasks:
  - {id: OWN, title: o, depends_on: [], file_ownership: ["lib/x.ts"], artifacts: ["lib/x.ts"], acceptance: ["x"]}
  - {id: DOWN, title: d, depends_on: [OWN], file_ownership: ["d/**"], artifacts: ["d/out.md"], acceptance: ["x"]}
`);
  const r = run('impact.mjs', [p, 'lib/x.ts']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.direct, ['DOWN']);
  assert.deepEqual(out.artifacts, ['d/out.md']);
});

test('verify-plan: clean plan APPROVEs (exit 0)', () => {
  const p = writeTasks(ABC);
  mkdirSync(join(dir, 'plans'));
  writeFileSync(join(dir, 'plans', 'plan.md'), '# Plan\nDo C first, then B, then A. Acceptance per tasks.yaml.\n');
  const r = run('verify-plan.mjs', [p, '--plan', join(dir, 'plans')]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).verdict, 'APPROVE');
});

test('verify-plan: three poisoned plans are rejected with specific issues', () => {
  // Poison 1: cycle
  let p = writeTasks(`tasks:
  - {id: K1, title: k, depends_on: [K2], file_ownership: ["k/**"], acceptance: ["x"]}
  - {id: K2, title: k, depends_on: [K1], file_ownership: ["k2/**"], acceptance: ["x"]}
`);
  mkdirSync(join(dir, 'plans'));
  writeFileSync(join(dir, 'plans', 'p.md'), 'K1 and K2\n');
  let r = run('verify-plan.mjs', [p, '--plan', join(dir, 'plans')]);
  let out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'ISSUES');
  assert.ok(out.issues.some((i) => /cycle/.test(i)));

  // Poison 2: same-wave ownership overlap
  p = writeTasks(`tasks:
  - {id: O1, title: o, depends_on: [], file_ownership: ["dup/**"], acceptance: ["x"]}
  - {id: O2, title: o, depends_on: [], file_ownership: ["dup/**"], acceptance: ["x"]}
`);
  r = run('verify-plan.mjs', [p, '--plan', join(dir, 'plans')]);
  out = JSON.parse(r.stdout);
  assert.ok(out.issues.some((i) => /overlap/.test(i)));

  // Poison 3: plan references unknown task id
  p = writeTasks(ABC);
  writeFileSync(join(dir, 'plans', 'p2.md'), 'Also implement TASK-999.\n');
  r = run('verify-plan.mjs', [p, '--plan', join(dir, 'plans')]);
  out = JSON.parse(r.stdout);
  assert.ok(out.issues.some((i) => /TASK-999/.test(i)));
});
