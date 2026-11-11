// yaml-subset.test.mjs — the subset contract is checked against the parser.
//
// WHY THIS FILE EXISTS. The YAML subset was documented in one line of a
// reference the skill never asked the agent to load, and that line omitted
// the restriction that broke every run: a plain value containing ": ". The
// agent learned the rules by failing.
//
// So the rules live in code — core/yaml-subset.mjs — with an example each.
// This file runs every example through the REAL parser and asserts it
// behaves as documented. The reference states the same rules in prose; the
// last test asserts every rule is named there, so the prose cannot drift
// from the behaviour either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../src/core/yaml.mjs';
import { YAML_SUBSET } from '../../src/core/yaml-subset.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REFS = join(HERE, '..', '..', 'assets', 'references');

test('the subset contract is not empty', () => {
  assert.ok(YAML_SUBSET.length >= 10, `the subset must document its rules (found ${YAML_SUBSET.length})`);
});

for (const rule of YAML_SUBSET) {
  test(`${rule.id}: ${rule.rule}`, () => {
    if (rule.expect.error) {
      assert.throws(
        () => parseYaml(rule.yaml, { filename: 'subset.yaml' }),
        rule.expect.error,
        `${rule.id}: the parser must refuse this input`,
      );
      return;
    }
    const { data } = parseYaml(rule.yaml, { filename: 'subset.yaml' });
    assert.deepEqual(data, rule.expect.data, `${rule.id}: the parser must read this input as documented`);
  });
}

test('the reference states every rule of the subset', () => {
  const ref = join(REFS, 'artifact-templates.md');
  if (!existsSync(ref)) return; // published package — no repo-level references
  const text = readFileSync(ref, 'utf8');
  for (const rule of YAML_SUBSET) {
    assert.ok(text.includes(rule.id), `artifact-templates.md must state the subset rule '${rule.id}'`);
  }
});
