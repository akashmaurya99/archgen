// plan-corpus.test.mjs — the floor's behaviour, locked by example.
//
// WHY A CORPUS.
//
// The floor is the gate: if it cries wolf, the whole gate gets bypassed; if
// it goes quiet, broken plans reach execution. Unit tests pin the rules one
// at a time, but a corpus pins the COMBINATION — every poisoned plan produces
// exactly the codes it should, and no others.
//
// It follows the yaml-corpus precedent: the cases live in `fixtures/`, not in
// the test file, so a case is readable as a plan and the expectation is a
// short, stable list of codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../src/core/yaml.mjs';
import { verifyPlan, issueCode } from '../../src/core/verifier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', '..', '..', 'fixtures', 'plan-corpus');

function cases() {
  if (!existsSync(CORPUS)) return [];
  return readdirSync(CORPUS)
    .filter((name) => existsSync(join(CORPUS, name, 'expect.json')))
    .sort();
}

for (const name of cases()) {
  test(`plan corpus: ${name}`, () => {
    const dir = join(CORPUS, name);
    const expected = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8'));
    const { data } = parseYaml(readFileSync(join(dir, 'tasks.yaml'), 'utf8'), { filename: 'tasks.yaml' });
    const result = verifyPlan(join(dir, 'tasks.yaml'), join(dir, 'plans'));

    const codes = result.issues.map(issueCode).sort();
    assert.deepEqual(
      codes,
      [...(expected.codes ?? [])].sort(),
      `${name}: ${expected.name ?? name}\n${result.issues.join('\n')}`,
    );
    if (expected.warnings) {
      const warningCodes = result.warnings.map(issueCode).sort();
      for (const w of expected.warnings) {
        assert.ok(warningCodes.includes(w), `${name}: expected the warning ${w}, got ${warningCodes.join(', ')}`);
      }
    }
  });
}

test('the corpus is not empty — a gate with no cases is a gate with no memory', () => {
  assert.ok(cases().length >= 5, `the plan corpus must hold real cases, found ${cases().length}`);
});

test('every corpus case fails the gate (a passing case would be a useless case)', () => {
  for (const name of cases()) {
    const dir = join(CORPUS, name);
    const result = verifyPlan(join(dir, 'tasks.yaml'), join(dir, 'plans'));
    assert.equal(result.verdict, 'ISSUES', `${name} must be rejected by the floor`);
  }
});
