// plan-coverage.test.mjs — which tasks does the plan actually document?
//
// The coverage report answers "which task ids does the plan mention?". It
// used to RE-DERIVE that answer from the checker's NEGATIVE findings — and
// an uncovered task's finding NAMES the task, so every uncovered task was
// reported as covered and every covered task as uncovered. The inversion
// was invisible: the shape of the answer was right, only its meaning was
// backwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPlanCoverage } from '../../src/core/plan/plan-coverage.mjs';

let dir;
let plans;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-cov-'));
  plans = join(dir, 'plans');
  mkdirSync(plans, { recursive: true });
});
test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tasks = [
  { id: 'TASK-1', title: 'first', artifacts: [], acceptance: [] },
  { id: 'TASK-2', title: 'second', artifacts: [], acceptance: [] },
];

test('a task mentioned in a plan file is referenced', () => {
  writeFileSync(join(plans, 'design.md'), '# Design\n\nTASK-1 is implemented here.\n');
  const { referenced, findings } = checkPlanCoverage(plans, tasks);
  assert.ok(referenced.has('TASK-1'));
  assert.ok(!referenced.has('TASK-2'));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /TASK-2.*not mentioned/);
});

test('a task mentioned by ANOTHER task is covered too', () => {
  const withDeps = [
    { id: 'TASK-1', title: 'first', artifacts: [], acceptance: [] },
    { id: 'TASK-2', title: 'builds on TASK-1', artifacts: [], acceptance: [] },
  ];
  const { mentionedInTasks } = checkPlanCoverage(plans, withDeps);
  assert.ok(mentionedInTasks.has('TASK-1'));
  assert.ok(!mentionedInTasks.has('TASK-2'));
});

test('an empty plan directory leaves every task unreferenced', () => {
  const { referenced, mentionedInTasks } = checkPlanCoverage(plans, tasks);
  assert.equal(referenced.size, 0);
  assert.equal(mentionedInTasks.size, 0);
});

test('a missing plan directory is a finding, not a crash', () => {
  const { findings } = checkPlanCoverage(join(dir, 'nope'), tasks);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /plans dir not found/);
});
