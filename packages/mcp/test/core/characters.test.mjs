// characters.test.mjs — every printable character, through every layer.
//
// WHY THIS FILE EXISTS. The complaint that started all of this was a plan
// rejected for a character in a title. A single character must never decide
// whether a plan is usable, so this walks EVERY printable ASCII character —
// and the ones that break out of a quoted string — through the three layers
// an agent's text crosses:
//
//   1. the PARSER reads it;
//   2. the VALIDATOR judges it;
//   3. the WRITER emits it and the parser reads it back.
//
// A character that survives all three is safe to type. A character that
// fails one of them is a defect, and the defect names the layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseYaml, stringifyYaml } from '../../src/core/yaml.mjs';
import { validateTasksYaml } from '../../src/core/validator.mjs';

/** Every printable ASCII character, plus the ones that break a quoted string. */
const CHARACTERS = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  'é', '—', '中', '😀', '\t', '\\', '\n', '"', "'", '`', '$', '{', '}', '[', ']',
];

/** The text an agent would put in a title. */
const asText = (c) => `Build ${c} the thing`;

/** A plan carrying that text in a title and in an acceptance criterion. */
function planWith(text) {
  return [
    'tasks:',
    '  - id: T1',
    `    title: ${JSON.stringify(text)}`,
    '    depends_on: []',
    '    file_ownership: ["src/**"]',
    '    acceptance:',
    `      - ${JSON.stringify(`the thing ${text} works`)}`,
    '',
  ].join('\n');
}

test('every character parses inside a quoted value', () => {
  const failures = [];
  for (const c of CHARACTERS) {
    const text = asText(c);
    try {
      const { data } = parseYaml(planWith(text), { filename: 'case.yaml' });
      if (data.tasks[0].title !== text) failures.push(`${JSON.stringify(c)}: the title did not survive`);
    } catch (e) {
      failures.push(`${JSON.stringify(c)}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `a character the parser refused:\n  ${failures.join('\n  ')}`);
});

test('every character validates inside a quoted value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-chars-'));
  const file = join(dir, 'tasks.yaml');
  const failures = [];
  try {
    for (const c of CHARACTERS) {
      writeFileSync(file, planWith(asText(c)), 'utf8');
      const report = validateTasksYaml(file);
      if (!report.valid) failures.push(`${JSON.stringify(c)}: ${JSON.stringify(report.errors)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, [], `a character the validator refused:\n  ${failures.join('\n  ')}`);
});

test('every character survives the write and the read back', () => {
  const failures = [];
  for (const c of CHARACTERS) {
    const text = asText(c);
    try {
      const { data } = parseYaml(planWith(text), { filename: 'case.yaml' });
      const out = stringifyYaml(data);
      const back = parseYaml(out, { filename: 'case.yaml' });
      if (back.data.tasks[0].title !== text) {
        failures.push(`${JSON.stringify(c)}: the title changed to ${JSON.stringify(back.data.tasks[0].title)}`);
      }
      if (back.data.tasks[0].acceptance[0] !== `the thing ${text} works`) {
        failures.push(`${JSON.stringify(c)}: the acceptance changed`);
      }
    } catch (e) {
      failures.push(`${JSON.stringify(c)}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `a character the writer could not carry:\n  ${failures.join('\n  ')}`);
});

test('a plain value with a colon is one scalar, not two', () => {
  // The complaint itself: a title with ": " in it.
  const { data } = parseYaml('tasks:\n  - id: T1\n    title: Refactor: the auth module\n', {
    filename: 'case.yaml',
  });
  assert.equal(data.tasks[0].title, 'Refactor: the auth module');
});

test('an unquoted criterion with a colon is reported with the fix, not refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag-chars-'));
  const file = join(dir, 'tasks.yaml');
  try {
    writeFileSync(
      file,
      'tasks:\n  - id: T1\n    title: api\n    depends_on: []\n    file_ownership: ["src/**"]\n    acceptance:\n      - Test: returns 200\n',
      'utf8',
    );
    const report = validateTasksYaml(file);
    assert.equal(report.valid, false);
    const finding = report.errors.find((e) => e.code === 'TASK_FIELD_TYPE');
    assert.ok(finding, `expected a type defect, got ${JSON.stringify(report.errors)}`);
    assert.match(finding.fix, /quote it so it reads as a string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
