// Integration tests for update-agents.mjs (AGENTS.md features registry).
// Run: node --test scripts/test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = '<!-- archgen:features:start -->';
const END = '<!-- archgen:features:end -->';
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archgen-agents-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'update-agents.mjs'), ...args], { encoding: 'utf8' });
}
function makeFeature(slugName, yaml) {
  mkdirSync(join(dir, '.archgen', slugName), { recursive: true });
  const p = join(dir, '.archgen', slugName, 'tasks.yaml');
  writeFileSync(p, yaml);
  return p;
}
function ymd(p) {
  const d = statSync(p).mtime;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function task(id, status) {
  return `  - {id: ${id}, title: t, depends_on: [], file_ownership: ["${id.toLowerCase()}/**"], acceptance: ["x"]${status ? `, status: ${status}` : ''}}\n`;
}
function tasksYaml(...entries) {
  return 'tasks:\n' + entries.join('');
}
function seedRegistry(rowLines) {
  writeFileSync(
    join(dir, 'AGENTS.md'),
    '# Guide\n\n' + START + '\n| Feature | Status | Updated |\n| --- | --- | --- |\n' + rowLines + END + '\n',
  );
}
function agents() {
  return readFileSync(join(dir, 'AGENTS.md'), 'utf8');
}

test('update-agents: missing AGENTS.md -> minimal scaffold (H1 + pointer + markers + table)', () => {
  const tp = makeFeature('alpha', tasksYaml(task('T1')));
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(agents(), [
    '# Agent Guide',
    '',
    'This project uses the archgen skill at `.agents/skills/archgen/SKILL.md` for architecture generation and autonomous task execution.',
    '',
    START,
    '| Feature | Status | Updated |',
    '| --- | --- | --- |',
    `| alpha | planned | ${ymd(tp)} |`,
    END,
    '',
  ].join('\n'));
});

test('update-agents: existing file without markers -> appended, prior bytes untouched', () => {
  makeFeature('alpha', tasksYaml(task('T1')));
  const before = '# My Project\n\nCustom operator notes.\n';
  writeFileSync(join(dir, 'AGENTS.md'), before);
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  const after = agents();
  assert.ok(after.startsWith(before), 'prior bytes must survive verbatim as a strict prefix');
  assert.ok(after.includes(START + '\n| Feature | Status | Updated |\n| --- | --- | --- |\n| alpha | planned |'));
  assert.ok(after.endsWith(END + '\n'));
});

test('update-agents: double run is byte-stable (idempotent)', () => {
  makeFeature('alpha', tasksYaml(task('T1')));
  assert.equal(run([dir]).status, 0);
  const first = agents();
  const r2 = run([dir]);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(agents(), first);
  assert.match(r2.stdout, /registry: 1 feature\b/);
  assert.match(r2.stdout, /unchanged: 1/); // identical table -> reported as unchanged
  assert.match(r2.stdout, /unchanged: 1/);
});

test('update-agents: multi-slug rows sorted alphabetically; folders without tasks.yaml skipped', () => {
  const pb = makeFeature('beta', tasksYaml(task('B1', 'done'), task('B2')));
  const pa = makeFeature('alpha', tasksYaml(task('A1')));
  const pg = makeFeature('gamma', tasksYaml(task('G1', 'running')));
  mkdirSync(join(dir, '.archgen', 'stray')); // no tasks.yaml -> no registry row
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  const expectedTable = [
    '| Feature | Status | Updated |',
    '| --- | --- | --- |',
    `| alpha | planned | ${ymd(pa)} |`,
    `| beta | in progress | ${ymd(pb)} |`,
    `| gamma | in progress | ${ymd(pg)} |`,
    '',
  ].join('\n');
  assert.ok(agents().includes(expectedTable));
  assert.ok(!agents().includes('| stray'));
});

const BUCKETS = [
  ['all pending -> planned', [['P1']], 'planned'],
  ['ready counts as planned', [['R1', 'ready'], ['R2', 'ready']], 'planned'],
  ['any running -> in progress', [['W1', 'running'], ['W2', 'done']], 'in progress'],
  ['done+pending mix -> in progress', [['D1', 'done'], ['P9']], 'in progress'],
  ['all done -> done', [['X1', 'done'], ['X2', 'done']], 'done'],
  ['blocked beats everything', [['OK', 'done'], ['ST', 'blocked']], 'blocked'],
];
for (const [name, entries, want] of BUCKETS) {
  test(`update-agents: status bucket — ${name}`, () => {
    makeFeature('f', tasksYaml(...entries.map(([id, s]) => task(id, s))));
    const r = run([dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(agents().includes(`| f | ${want} |`));
  });
}

test('update-agents: unparseable tasks.yaml -> unknown row (not a crash)', () => {
  makeFeature('weird', 'tasks: [\n');
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(agents().includes('| weird | unknown |'));
});

test('update-agents: --slug/--status upsert overrides the derived status', () => {
  makeFeature('alpha', tasksYaml(task('A1')));
  const r = run([dir, '--slug', 'alpha', '--status', 'done']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(agents().includes('| alpha | done |'));
});

test('update-agents: bad flag combos exit 4 and write nothing', () => {
  makeFeature('alpha', tasksYaml(task('A1')));
  assert.equal(run([dir, '--slug', 'alpha']).status, 4);            // --slug without --status
  assert.equal(run([dir, '--status', 'done']).status, 4);           // --status without --slug
  assert.equal(run([dir, '--slug', 'a', '--status', 'bogus']).status, 4);
  assert.equal(run([dir, '--slug', '../evil', '--status', 'done']).status, 4);
  assert.equal(run([]).status, 4);                                  // missing projectRoot
  assert.equal(existsSync(join(dir, 'AGENTS.md')), false);
});

test('update-agents: rows for missing folders pruned by default and reported', () => {
  const tp = makeFeature('live', tasksYaml(task('L1')));
  seedRegistry('| ghost | done | 2020-01-01 |\n');
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  const body = agents();
  assert.ok(!body.includes('ghost'));
  assert.ok(body.includes(`| live | planned | ${ymd(tp)} |`));
  assert.match(r.stdout, /pruned: ghost/);
});

test('update-agents: --prune accepted as explicit no-op (same behavior)', () => {
  makeFeature('live', tasksYaml(task('L1')));
  seedRegistry('| ghost | done | 2020-01-01 |\n');
  const r = run([dir, '--prune']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pruned: ghost/);
  assert.ok(!agents().includes('ghost'));
});

test('update-agents: CRLF endings preserved outside block; table re-emitted as CRLF', () => {
  const tp = makeFeature('alpha', tasksYaml(task('A1')));
  writeFileSync(
    join(dir, 'AGENTS.md'),
    'guide intro\r\nmore text\r\n' + START + '\r\n| stale | done | 2019-01-01 |\r\n' + END + '\r\ntail section\r\n',
  );
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  const after = agents();
  assert.ok(after.startsWith('guide intro\r\nmore text\r\n'), 'bytes before start marker preserved');
  assert.ok(after.endsWith('\r\ntail section\r\n'), 'bytes after end marker preserved');
  const block = after.slice(after.indexOf(START), after.indexOf(END));
  assert.ok(block.includes(`| alpha | planned | ${ymd(tp)} |`));
  assert.ok(!block.includes('stale'));
  assert.equal(/(?<!\r)\n/.test(after), false, 'no bare LF anywhere — CRLF convention kept');
});

test('update-agents: BOM survives block replacement', () => {
  makeFeature('alpha', tasksYaml(task('A1')));
  writeFileSync(join(dir, 'AGENTS.md'), '\uFEFF# Title\n' + START + '\n| old | done | 2018-01-01 |\n' + END + '\n');
  const r = run([dir]);
  assert.equal(r.status, 0, r.stderr);
  const after = agents();
  assert.equal(after.charCodeAt(0), 0xfeff);
  assert.ok(after.includes('| alpha | planned |'));
  assert.ok(after.includes('# Title'));
});

test('update-agents: no .archgen dir -> exit 2, note printed, nothing changed', () => {
  writeFileSync(join(dir, 'AGENTS.md'), '# Untouched\n');
  const r = run([dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\.archgen/);
  assert.equal(agents(), '# Untouched\n');
});

test('update-agents: start marker without end marker exits 4 with guidance', () => {
  makeFeature('alpha', tasksYaml(task('A1')));
  writeFileSync(join(dir, 'AGENTS.md'), '# X\n' + START + '\nbroken\n');
  const r = run([dir]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /end marker|END_MARKER|features:end/);
});
