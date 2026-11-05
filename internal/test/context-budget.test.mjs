// Integration tests for the internal context-budget tool (never shipped in
// the npm payload or the installed skill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, exactTokens, pctOf } from '../tools/tokens.mjs';

const INTERNAL = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(INTERNAL, 'tools');
const SKILL = join(INTERNAL, '..', 'skill');

function run(args, cwd) {
  return spawnSync(process.execPath, [join(TOOLS, 'context-budget.mjs'), ...args], { encoding: 'utf8', cwd });
}

// --- estimator ---------------------------------------------------------------

test('tokens: empty input costs zero', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('tokens: English prose lands within ±25% of the chars/4 rule of thumb', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
  const est = estimateTokens(text);
  const naive = text.length / 4;
  assert.ok(est > naive * 0.75 && est < naive * 1.25, `estimate ${est} vs naive ${naive}`);
});

test('tokens: prose is monotonic in length and CJK is denser than latin', () => {
  const a = estimateTokens('hello world');
  const b = estimateTokens('hello world hello world');
  assert.ok(b > a);
  const latin = estimateTokens('abcdefghij '.repeat(10));
  const cjk = estimateTokens('字'.repeat(20));
  assert.ok(cjk > latin * 0.5, 'CJK must not be undercounted');
});

test('tokens: pctOf clamps and formats percentages', () => {
  assert.equal(pctOf(50_000, 200_000), 25);
  assert.equal(pctOf(0, 200_000), 0);
  assert.equal(pctOf(10, 0), 0);
});

test('tokens: exactTokens returns null for an unavailable tokenizer module', async () => {
  assert.equal(await exactTokens('hello', 'this-module-does-not-exist-xyz'), null);
});

// --- report ------------------------------------------------------------------

test('context-budget: JSON report carries skill payload, scenarios and window pressure', () => {
  const r = run(['--skill-dir', SKILL, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.skill.totalTokens > 0);
  assert.ok(out.skill.files.length > 0);
  const ids = out.scenarios.map((s) => s.id);
  for (const id of ['skill-trigger', 'skill-mode', 'skill-full']) assert.ok(ids.includes(id), `missing scenario ${id}`);
  assert.ok(out.windows.includes(200000));
  assert.ok(out.windows.includes(1000000));
  const trigger = out.scenarios.find((s) => s.id === 'skill-trigger');
  assert.ok(trigger.pct[200000] < 10, `SKILL.md alone must stay small vs 200k (got ${trigger.pct[200000]}%)`);
});

test('context-budget: dev-only test files are excluded from the shipped payload', () => {
  const r = run(['--skill-dir', SKILL, '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.skill.files.some((f) => f.file.startsWith('scripts/test/')), 'scripts/test never ships');
  const shipped = out.skill.files.reduce((n, f) => n + f.tokens, 0);
  assert.equal(shipped, out.skill.totalTokens);
});

test('context-budget: artifact payload is measured for every .archgen slug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-budget-test-'));
  try {
    mkdirSync(join(dir, '.archgen', 'demo', 'plans'), { recursive: true });
    writeFileSync(join(dir, '.archgen', 'demo', 'tasks.yaml'), 'tasks:\n  - {id: TASK-01, title: x, depends_on: [], file_ownership: ["a/**"], acceptance: ["ok"]}\n');
    writeFileSync(join(dir, '.archgen', 'demo', 'plans', 'p.md'), '# Plan\n\nSome content here.\n');
    const r = run(['--project', dir, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.artifacts[0].slug, 'demo');
    assert.ok(out.artifacts[0].total > 0);
    assert.ok(out.artifacts[0].tasksYamlTokens > 0);
    assert.ok(out.scenarios.some((s) => s.id === 'artifacts-full:demo'));
    assert.ok(out.scenarios.some((s) => s.id === 'worker-context:demo'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-budget: --budget makes an over-budget run exit 1', () => {
  const r = run(['--skill-dir', SKILL, '--budget', '1', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.ok(out.overBudget.length > 0);
});

test('context-budget: a generous budget exits 0', () => {
  const r = run(['--skill-dir', SKILL, '--budget', '100000000', '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).overBudget.length, 0);
});

test('context-budget: unknown options are usage errors', () => {
  const r = run(['--nope']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /unknown option/);
});
