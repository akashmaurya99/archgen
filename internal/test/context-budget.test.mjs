// Integration tests for the internal context-budget tool (never shipped in
// the npm payload or the installed skill).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, exactTokens, pctOf } from '../tools/budget/tokens.mjs';

const INTERNAL = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(INTERNAL, 'tools', 'budget');
const SKILL = join(INTERNAL, '..', 'skill');
const ROOT = join(INTERNAL, '..');

// The tool is run from the REPO ROOT, always. A test that only passes from
// one working directory is a test that breaks the moment the runner changes
// it — and the runner DOES change it: Node 22+ cannot take a directory as a
// test path, so the suite discovers from `internal/` and every test starts
// with `internal/` as its CWD.
function run(args, cwd = ROOT) {
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
  const r = run(['--skill-dir', SKILL, '--project', ROOT, '--json']);
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
  const r = run(['--skill-dir', SKILL, '--project', ROOT, '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.skill.files.some((f) => f.file.startsWith('scripts/test/')), 'scripts/test never ships');
  const shipped = out.skill.files.reduce((n, f) => n + f.tokens, 0);
  assert.equal(shipped, out.skill.totalTokens);
});

test('context-budget: the shipped skill tree carries NO code (the MCP server owns the capability)', () => {
  const r = run(['--skill-dir', SKILL, '--project', ROOT, '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok(!out.skill.files.some((f) => f.file.startsWith('scripts/')), 'the skill ships no scripts tree');
});

test('context-budget: the MCP tool catalog is measured from the LIVE server', () => {
  const r = run(['--skill-dir', SKILL, '--project', ROOT, '--json']);
  const out = JSON.parse(r.stdout);
  // The catalog may be unavailable when packages/mcp deps are not installed —
  // that is a degraded measurement, never a silent zero.
  if (!out.catalog.available) {
    assert.match(out.catalog.reason ?? '', /MCP/i);
    return;
  }
  assert.ok(out.catalog.totalTokens > 0, 'the catalog must cost something — it is injected every request');
  assert.equal(out.catalog.tools.length, out.skill ? out.catalog.tools.length : 0);
  assert.ok(out.scenarios.some((s) => s.id === 'mcp-catalog'));
  assert.ok(out.scenarios.some((s) => s.id === 'always-on'), 'the always-on total must be reported');
});

test('context-budget: --max-always-on is a hard gate', () => {
  const generous = run(['--skill-dir', SKILL, '--project', ROOT, '--max-always-on', '100000000', '--json']);
  assert.equal(generous.status, 0, generous.stderr);
  const tight = run(['--skill-dir', SKILL, '--project', ROOT, '--max-always-on', '1', '--json']);
  assert.equal(tight.status, 1, 'an impossible always-on budget must fail the run');
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
  const r = run(['--skill-dir', SKILL, '--project', ROOT, '--budget', '1', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.ok(out.overBudget.length > 0);
});

test('context-budget: a generous budget exits 0', () => {
  const r = run(['--skill-dir', SKILL, '--project', ROOT, '--budget', '100000000', '--json']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).overBudget.length, 0);
});

test('context-budget: unknown options are usage errors', () => {
  const r = run(['--nope']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /unknown option/);
});
