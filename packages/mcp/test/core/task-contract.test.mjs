// task-contract.test.mjs — the task file's contract, enforced.
//
// WHY THIS FILE EXISTS. `schemas/tasks.schema.json` is the published
// contract for a task entry, and `core/validator.mjs` is its enforcement.
// They used to agree on four things — the key set, the required fields, the
// status enum and the id pattern — and on NOTHING else. Every item type,
// every `uniqueItems` and every `minItems` was unenforced, so a plan that
// violated the published schema came back from `validate` as `valid:true`.
//
// And the floor checked the same file separately, with its own codes. A
// dangling dependency and a duplicate id were both reported as `CYCLE`, so
// the documented `DANGLING_DEP` and `DUPLICATE_TASK_ID` codes could never be
// emitted — and an agent that groups its fixes by code could not tell a
// cycle from a typo.
//
// These cases pin the contract and the codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateTasksYaml } from '../../src/core/validator.mjs';
import { verifyPlan, issueCode } from '../../src/core/verifier.mjs';

let dir;
let file;

/** Write a tasks.yaml and validate it. */
function validate(body) {
  writeFileSync(file, body, 'utf8');
  return validateTasksYaml(file);
}

/** The codes the report carries. */
function codesOf(report) {
  return [...report.errors.map((e) => e.code), ...report.warnings.map((w) => w.code)];
}

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-contract-'));
  file = join(dir, 'tasks.yaml');
});
test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const OK_TASK = `tasks:
  - id: T1
    title: api
    depends_on: []
    file_ownership: ["src/**"]
    acceptance: ["returns the list"]
`;

test('a conforming task file is valid', () => {
  const report = validate(OK_TASK);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.deepEqual(report.errors, []);
});

test('a list field that is not a list is a defect', () => {
  const report = validate(OK_TASK.replace('file_ownership: ["src/**"]', 'file_ownership: src/a.js'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('TASK_FIELD_TYPE'));
});

test('a list entry that is not a string is a defect, with the value quoted back', () => {
  const report = validate(`tasks:
  - id: T1
    title: api
    depends_on: []
    file_ownership: ["src/**"]
    acceptance:
      - Test: returns 200
`);
  assert.equal(report.valid, false);
  const finding = report.errors.find((e) => e.code === 'TASK_FIELD_TYPE');
  assert.ok(finding, `expected a type defect, got ${JSON.stringify(report.errors)}`);
  assert.match(finding.message, /acceptance\[0\]/);
  assert.match(finding.fix, /Test: returns 200/);
});

test('a repeated list entry is a defect', () => {
  const report = validate(OK_TASK.replace('["src/**"]', '["src/**", "src/**"]'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('TASK_FIELD_DUPLICATE'));
});

test('an empty acceptance list is a defect', () => {
  const report = validate(OK_TASK.replace('acceptance: ["returns the list"]', 'acceptance: []'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('NO_ACCEPTANCE'));
});

test('an empty file_ownership list is a defect', () => {
  const report = validate(OK_TASK.replace('file_ownership: ["src/**"]', 'file_ownership: []'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('EMPTY_OWNERSHIP'));
});

test('a non-string parallel_group is a defect', () => {
  const report = validate(OK_TASK.replace('depends_on: []', 'depends_on: []\n    parallel_group: 7'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('TASK_FIELD_TYPE'));
});

test('an invalid status is a defect', () => {
  const report = validate(OK_TASK.replace('depends_on: []', 'depends_on: []\n    status: cancelled'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('TASK_STATUS_INVALID'));
});

test('an invalid id is a defect', () => {
  const report = validate(OK_TASK.replace('id: T1', 'id: "1 bad id"'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('TASK_ID_INVALID'));
});

test('an unknown key is a warning, never an error', () => {
  const report = validate(OK_TASK.replace('depends_on: []', 'depends_on: []\n    surprise: 1'));
  assert.equal(report.valid, true);
  assert.ok(report.warnings.some((w) => w.code === 'TASK_FIELD_UNKNOWN'));
});

test('a dangling dependency is DANGLING_DEP, not CYCLE', () => {
  const report = validate(OK_TASK.replace('depends_on: []', 'depends_on: ["T9"]'));
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('DANGLING_DEP'));
  assert.ok(!codesOf(report).includes('CYCLE'));
});

test('a duplicate id is DUPLICATE_TASK_ID, not CYCLE', () => {
  const report = validate(`${OK_TASK}  - id: T1
    title: api again
    depends_on: []
    file_ownership: ["src/b/**"]
    acceptance: ["ok"]
`);
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('DUPLICATE_TASK_ID'));
  assert.ok(!codesOf(report).includes('CYCLE'));
});

test('a real cycle is CYCLE', () => {
  const report = validate(`tasks:
  - id: A
    title: a
    depends_on: ["B"]
    file_ownership: ["src/a/**"]
    acceptance: ["ok"]
  - id: B
    title: b
    depends_on: ["A"]
    file_ownership: ["src/b/**"]
    acceptance: ["ok"]
`);
  assert.equal(report.valid, false);
  assert.ok(codesOf(report).includes('CYCLE'));
});

test('an artifact the task does not own is reported, but never blocks', () => {
  const report = validate(`tasks:
  - id: T1
    title: api
    depends_on: []
    file_ownership: ["src/**"]
    artifacts: ["docs/guide.md"]
    acceptance: ["ok"]
`);
  assert.equal(report.valid, true, 'the rule is reported, not enforced');
  assert.ok(report.warnings.some((w) => w.code === 'ARTIFACT_NOT_OWNED'));
});

test('every defect carries the field it is in and the fix that clears it', () => {
  const report = validate(`tasks:
  - id: T1
    title: api
    depends_on: []
    file_ownership: ["src/**"]
    acceptance: []
    status: nonsense
`);
  assert.equal(report.valid, false);
  for (const finding of report.errors) {
    assert.ok(finding.code, 'every finding carries a code');
    assert.ok(finding.message, 'every finding carries a message');
    assert.ok(finding.fix, `every finding carries a fix: ${JSON.stringify(finding)}`);
  }
});

test('the floor and the validator agree on the task file', () => {
  const broken = `tasks:
  - id: T1
    title: api
    depends_on: ["T9"]
    file_ownership: ["src/**"]
    acceptance: ["ok"]
`;
  writeFileSync(file, broken, 'utf8');
  const report = validateTasksYaml(file);
  const planDir = join(dir, 'plans');
  mkdirSync(planDir, { recursive: true });
  const floor = verifyPlan(file, planDir);
  assert.ok(codesOf(report).includes('DANGLING_DEP'));
  assert.ok(floor.issues.map(issueCode).includes('DANGLING_DEP'));
});

test('a plan artifact that does not parse is reported as unparseable, not missing', () => {
  const planDir = join(dir, 'plans');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(file, OK_TASK, 'utf8');
  writeFileSync(join(dir, 'architecture.yaml'), 'toolchain:\n\tsource_root: src\n', 'utf8');
  const floor = verifyPlan(file, planDir);
  const warningCodes = floor.warnings.map(issueCode);
  assert.ok(
    warningCodes.includes('CONFIG_UNPARSEABLE'),
    `the broken architecture.yaml must be named, got ${JSON.stringify(floor.warnings)}`,
  );
});
