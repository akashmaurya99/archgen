// status-mutator.test.mjs — the status writer.
//
// Three properties are load-bearing and each one has a failure mode that
// looks like nothing happened:
//
//   1. THE FILE MUST SURVIVE THE ROUND-TRIP. A key the author quoted
//      (`"odd: key"`) used to be emitted bare, and the rewrite produced a
//      file that no longer parsed — one status update destroyed the plan.
//   2. THE UPDATE MUST NOT BE LOST. Parallel workers in one wave each read
//      the same bytes and each write its own status; without a lock the
//      second write silently discarded the first.
//   3. THE ID MUST BE ADDRESSABLE. YAML resolves `id: 007` to the number 7,
//      so a strict comparison made that task impossible to update.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTaskStatus, sameId } from '../../src/core/plan/status-mutator.mjs';
import { parseYaml } from '../../src/core/fs/yaml.mjs';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-mut-'));
  file = join(dir, 'tasks.yaml');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TWO_TASKS = 'tasks:\n  - id: T-1\n    status: pending\n  - id: T-2\n    status: pending\n';

test('a status change is written and the file still parses', () => {
  writeFileSync(file, TWO_TASKS);
  const r = setTaskStatus(file, 'T-1', 'done');
  assert.equal(r.to, 'done');
  assert.equal(r.changed, true);
  const { data } = parseYaml(readFileSync(file, 'utf8'), { filename: file });
  assert.equal(data.tasks[0].status, 'done');
  assert.equal(data.tasks[1].status, 'pending');
});

test('a quoted key containing a colon survives the rewrite', () => {
  writeFileSync(file, 'tasks:\n  - id: T-1\n    status: pending\n    "odd: key": 1\n');
  setTaskStatus(file, 'T-1', 'done');
  const raw = readFileSync(file, 'utf8');
  assert.match(raw, /"odd: key": 1/);
  const { data } = parseYaml(raw, { filename: file });
  assert.equal(data.tasks[0]['odd: key'], 1);
});

test('a quoted string value stays a string', () => {
  writeFileSync(file, 'tasks:\n  - id: T-1\n    status: pending\n    count: "123"\n');
  setTaskStatus(file, 'T-1', 'done');
  const { data } = parseYaml(readFileSync(file, 'utf8'), { filename: file });
  assert.equal(data.tasks[0].count, '123');
});

test('two updates in a row both survive', () => {
  writeFileSync(file, TWO_TASKS);
  setTaskStatus(file, 'T-1', 'done');
  setTaskStatus(file, 'T-2', 'running');
  const { data } = parseYaml(readFileSync(file, 'utf8'), { filename: file });
  assert.equal(data.tasks[0].status, 'done');
  assert.equal(data.tasks[1].status, 'running');
});

test('a criterion containing ": " survives the rewrite', () => {
  // The writer emitted the criterion as a block item the reader then took for
  // a mapping, so the file it wrote could not be parsed back — and a plan in
  // that state could never be marked running or done.
  writeFileSync(
    file,
    'tasks:\n  - id: T-1\n    status: pending\n    acceptance: ["Test: returns 200"]\n',
  );
  const r = setTaskStatus(file, 'T-1', 'done');
  assert.equal(r.to, 'done');
  const { data } = parseYaml(readFileSync(file, 'utf8'), { filename: file });
  assert.deepEqual(data.tasks[0].acceptance, ['Test: returns 200']);
});

test('a list on the first key survives the rewrite', () => {
  writeFileSync(file, 'tasks:\n  - acceptance: ["a", "b"]\n    id: T-1\n    status: pending\n');
  setTaskStatus(file, 'T-1', 'done');
  const { data } = parseYaml(readFileSync(file, 'utf8'), { filename: file });
  assert.deepEqual(data.tasks[0].acceptance, ['a', 'b']);
  assert.equal(data.tasks[0].status, 'done');
});

test('the lock is released after the update', () => {
  writeFileSync(file, TWO_TASKS);
  setTaskStatus(file, 'T-1', 'done');
  assert.equal(existsSync(`${file}.lock`), false);
});

test('the lock is released even when the update fails', () => {
  writeFileSync(file, TWO_TASKS);
  assert.throws(() => setTaskStatus(file, 'NOPE', 'done'));
  assert.equal(existsSync(`${file}.lock`), false);
});

test('a no-op transition reports changed: false', () => {
  writeFileSync(file, TWO_TASKS);
  setTaskStatus(file, 'T-1', 'done');
  const again = setTaskStatus(file, 'T-1', 'done');
  assert.equal(again.changed, false);
  assert.equal(again.from, 'done');
});

test('a numeric id is addressable by the text the agent read', () => {
  writeFileSync(file, 'tasks:\n  - id: 007\n    status: pending\n');
  const r = setTaskStatus(file, '007', 'done');
  assert.equal(r.to, 'done');
});

test('a quoted id matches exactly, never by value', () => {
  writeFileSync(file, 'tasks:\n  - id: "7"\n    status: pending\n');
  assert.throws(() => setTaskStatus(file, '07', 'done'), (e) => e.code === 'INVALID_INPUT');
});

test('sameId compares text, and numeric ids by value', () => {
  assert.equal(sameId('T-1', 'T-1'), true);
  assert.equal(sameId('T-1', 'T-2'), false);
  assert.equal(sameId(7, '007'), true);
  assert.equal(sameId(7, '7'), true);
  assert.equal(sameId('7', '07'), false);
  assert.equal(sameId('T-1', undefined), false);
});
