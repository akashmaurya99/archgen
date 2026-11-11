// invariants.test.mjs — the behaviours the old scripts guaranteed must survive
// the move into the MCP core.
//
// Each of these was a deliberate property of skill/scripts/*.mjs. If one
// regresses, an agent's plan silently becomes wrong — so each has its own
// test rather than being folded into a happy-path suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateTasksYaml } from '../../src/core/validator.mjs';
import { verifyPlan } from '../../src/core/verifier.mjs';
import { resolveWaves } from '../../src/core/wave-resolver.mjs';
import { setTaskStatus, detectEol } from '../../src/core/status-mutator.mjs';
import { analyzeImpact } from '../../src/core/impact-analyzer.mjs';
import { updateRegistry } from '../../src/core/registry-updater.mjs';
import { ArchgenError } from '../../src/core/errors.mjs';

const work = mkdtempSync(join(tmpdir(), 'archgen-core-'));

const TASKS = `# a plan
tasks:
  - id: A
    title: First
    status: pending
    file_ownership:
      - src/a/**
    depends_on: []
    acceptance:
      - "a is done"
  - id: B
    title: Second
    status: pending
    file_ownership:
      - src/b/**
    depends_on:
      - A
    acceptance:
      - "b is done"
`;

/** Write a tasks.yaml into the temp dir and return its path. */
function writeTasks(name, body = TASKS) {
  const p = join(work, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

// ── error taxonomy ──────────────────────────────────────────────────────────

test('a dependency cycle is CYCLE, not INTERNAL', () => {
  const p = writeTasks(
    'cycle.yaml',
    `tasks:
  - id: A
    title: A
    file_ownership: ["a"]
    depends_on: ["B"]
  - id: B
    title: B
    file_ownership: ["b"]
    depends_on: ["A"]
`,
  );
  assert.throws(
    () => resolveWaves(p),
    (e) => e instanceof ArchgenError && e.code === 'CYCLE',
  );
  // The verifier is a GATE, not a thrower: it reports the cycle as a finding
  // (APPROVE/ISSUES), exactly as the old verify-plan.mjs did.
  const verdict = verifyPlan(p, work);
  assert.equal(verdict.verdict, 'ISSUES');
  assert.ok(verdict.issues.some((i) => /cycle/i.test(i)), JSON.stringify(verdict.issues));
});

test('a same-wave ownership overlap is OWNERSHIP_CONFLICT', () => {
  const p = writeTasks(
    'clash.yaml',
    `tasks:
  - id: A
    title: A
    file_ownership: ["src/shared/**"]
    depends_on: []
  - id: B
    title: B
    file_ownership: ["src/shared/logger.ts"]
    depends_on: []
`,
  );
  assert.throws(
    () => resolveWaves(p),
    (e) => e instanceof ArchgenError && e.code === 'OWNERSHIP_CONFLICT',
  );
});

test('an unparseable file is a finding, never a raw stack', () => {
  // A TAB-indented mapping is illegal YAML (tabs may not be used for
  // indentation) — the same input the repo's yaml-corpus calls malformed-tab.
  // The file is broken, not the CALL: it comes back as a finding the agent
  // can act on, with the line to fix.
  const p = writeTasks('bad.yaml', 'good: 1\n\tbad_indent: 2\n');
  const result = validateTasksYaml(p);
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UNPARSEABLE');
  assert.doesNotThrow(() => validateTasksYaml(p));
});

// ── validator ───────────────────────────────────────────────────────────────

test('validate reports every error and never throws for a broken plan', () => {
  const p = writeTasks(
    'invalid.yaml',
    `tasks:
  - id: A
    title: ""
    file_ownership: []
    status: nonsense
  - id: "1 bad id"
    file_ownership: ["x"]
`,
  );
  const result = validateTasksYaml(p);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 4, `expected several errors, got ${JSON.stringify(result.errors)}`);
  assert.equal(result.counts.tasks, 2);
});

test('validate treats an unknown key as a warning, not an error', () => {
  const p = writeTasks(
    'unknown-key.yaml',
    `tasks:
  - id: A
    title: A
    file_ownership: ["a"]
    surprise: 1
`,
  );
  const result = validateTasksYaml(p);
  assert.equal(result.valid, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'TASK_FIELD_UNKNOWN');
  assert.match(result.warnings[0].message, /unknown key/);
});

// ── status mutator: atomicity, line endings, comments, force gate ───────────

test('set_status preserves author comments', () => {
  const p = writeTasks(
    'comments.yaml',
    `# leading comment
tasks:
  - id: A
    title: First
    # inline comment
    status: pending
    file_ownership: ["a"]
    acceptance: ["ok"]
`,
  );
  setTaskStatus(p, 'A', 'running');
  const out = readFileSync(p, 'utf8');
  assert.match(out, /# leading comment/);
  assert.match(out, /# inline comment/);
  assert.match(out, /status: running/);
});

test('set_status preserves CRLF line endings', () => {
  const p = writeTasks('crlf.yaml', TASKS.replace(/\n/g, '\r\n'));
  setTaskStatus(p, 'A', 'running');
  const out = readFileSync(p, 'utf8');
  assert.equal(detectEol(out), '\r\n');
  assert.ok(!/(?<!\r)\n/.test(out), 'no lone LF may survive');
});

test('set_status refuses to reopen a done task without force', () => {
  const p = writeTasks(
    'done.yaml',
    TASKS.replace('status: pending', 'status: done'),
  );
  assert.throws(
    () => setTaskStatus(p, 'A', 'running'),
    (e) => e instanceof ArchgenError && e.code === 'CONFLICT',
  );
  // The file must be untouched after the refusal.
  assert.match(readFileSync(p, 'utf8'), /status: done/);

  const forced = setTaskStatus(p, 'A', 'running', { force: true });
  assert.equal(forced.from, 'done');
  assert.equal(forced.to, 'running');
  assert.match(readFileSync(p, 'utf8'), /status: running/);
});

test('set_status rejects an unknown status', () => {
  const p = writeTasks('status.yaml');
  assert.throws(
    () => setTaskStatus(p, 'A', 'invented'),
    (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
  );
});

test('set_status rejects an unknown task id', () => {
  const p = writeTasks('missing.yaml');
  assert.throws(
    () => setTaskStatus(p, 'NOPE', 'done'),
    (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
  );
});

test('set_status leaves no temp file behind', () => {
  const p = writeTasks('tidy.yaml');
  setTaskStatus(p, 'A', 'running');
  const strays = readdirSync(work).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(strays, []);
});

// ── wave resolver ───────────────────────────────────────────────────────────

test('resolveWaves orders tasks by dependency', () => {
  const p = writeTasks('waves.yaml');
  const { waves } = resolveWaves(p);
  assert.equal(waves.length, 2);
  assert.equal(waves[0][0].id, 'A');
  assert.equal(waves[1][0].id, 'B');
});

test('resolveWaves excludes tasks blocked by a failure', () => {
  const p = writeTasks(
    'blocked.yaml',
    `tasks:
  - id: A
    title: A
    status: failed
    file_ownership: ["a"]
  - id: B
    title: B
    status: pending
    file_ownership: ["b"]
    depends_on: ["A"]
`,
  );
  const { waves, blockedByFailure } = resolveWaves(p);
  assert.deepEqual(blockedByFailure, ['B']);
  assert.ok(!waves.flat().some((t) => t.id === 'B'), 'B must not be executable');
});

// ── impact ──────────────────────────────────────────────────────────────────

test('analyzeImpact reports direct and transitive dependents', () => {
  const p = writeTasks(
    'impact.yaml',
    `tasks:
  - id: A
    title: A
    file_ownership: ["a"]
  - id: B
    title: B
    file_ownership: ["b"]
    depends_on: ["A"]
  - id: C
    title: C
    file_ownership: ["c"]
    depends_on: ["B"]
    artifacts: ["src/c.ts"]
`,
  );
  const result = analyzeImpact(p, 'A');
  assert.deepEqual(result.direct, ['B']);
  assert.deepEqual(result.transitive, ['C']);
  assert.deepEqual(result.artifacts, ['src/c.ts']);
});

test('analyzeImpact accepts an artifact path as the target', () => {
  const p = writeTasks(
    'impact-artifact.yaml',
    `tasks:
  - id: A
    title: A
    file_ownership: ["a"]
    artifacts: ["src/a.ts"]
`,
  );
  const result = analyzeImpact(p, 'src/a.ts');
  assert.deepEqual(result.direct, []);
  assert.deepEqual(result.transitive, []);
});

test('analyzeImpact rejects a target nothing claims', () => {
  const p = writeTasks('impact-none.yaml');
  assert.throws(
    () => analyzeImpact(p, 'nobody/claims/this'),
    (e) => e instanceof ArchgenError && e.code === 'NOT_FOUND',
  );
});

// ── registry updater ────────────────────────────────────────────────────────

test('updateRegistry preserves every byte outside the managed block', () => {
  const dir = join(work, 'registry');
  mkdirSync(join(dir, '.archgen', 'demo'), { recursive: true });
  writeFileSync(join(dir, '.archgen', 'demo', 'tasks.yaml'), TASKS, 'utf8');
  writeFileSync(
    join(dir, 'AGENTS.md'),
    '# Mine\n\nSome prose.\n\n<!-- archgen:features:start -->\n| Feature | Status | Updated |\n| --- | --- | --- |\n<!-- archgen:features:end -->\n\nTrailing prose.\n',
    'utf8',
  );

  updateRegistry(dir);
  const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(out, /^# Mine/);
  assert.match(out, /Some prose\./);
  assert.match(out, /Trailing prose\./);
  assert.match(out, /\| demo \| planned \| /);
});

test('updateRegistry refuses a slug without a status', () => {
  const dir = join(work, 'registry-bad');
  mkdirSync(join(dir, '.archgen'), { recursive: true });
  assert.throws(
    () => updateRegistry(dir, { slug: 'demo', status: null }),
    (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
  );
});
