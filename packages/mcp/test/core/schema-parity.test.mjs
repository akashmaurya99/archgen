// schema-parity.test.mjs — the published schema and the validator must agree.
//
// `schemas/tasks.schema.json` is the CONTRACT for a tasks.yaml entry, and
// `core/validator.mjs` is the ENFORCEMENT of it. Two hand-maintained copies of
// the same rules drift the moment one is edited — and a plan that validates
// but violates the published schema (or the reverse) is a silent data bug.
//
// This test pins them together. It skips when the repo-level schema is not
// present (the published package ships no schemas/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUSES, REQUIRED, KNOWN_KEYS, ID_PATTERN } from '../../src/core/validator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', '..', 'schemas', 'tasks.schema.json');

const schema = existsSync(SCHEMA_PATH) ? JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) : null;

test('the task schema and the validator agree on the allowed keys', () => {
  if (!schema) return; // published package — no repo-level schemas
  const schemaKeys = Object.keys(schema.properties).sort();
  assert.deepEqual(schemaKeys, [...KNOWN_KEYS].sort(), 'the schema and the validator disagree on task keys');
});

test('the task schema and the validator agree on the required fields', () => {
  if (!schema) return;
  assert.deepEqual([...schema.required].sort(), [...REQUIRED].sort());
});

test('the task schema and the validator agree on the status enum', () => {
  if (!schema) return;
  assert.deepEqual(schema.properties.status.enum, [...STATUSES]);
});

test('the task schema and the validator agree on the id pattern', () => {
  if (!schema) return;
  assert.equal(schema.properties.id.pattern, ID_PATTERN.source);
});

test('the task schema and the validator agree on the acceptance contract', () => {
  if (!schema) return;
  // The verifier refuses a task with no acceptance criteria — so the schema
  // must not say acceptance is optional-and-empty either.
  assert.equal(schema.properties.acceptance.type, 'array');
  assert.equal(schema.properties.acceptance.default?.length ?? 0, 0);
  assert.match(schema.properties.acceptance.description, /verifiable/i);
});

test('the task schema forbids the file_ownership overlap the verifier rejects', () => {
  if (!schema) return;
  assert.equal(schema.properties.file_ownership.minItems, 1, 'file_ownership must be non-empty');
  assert.match(schema.properties.file_ownership.description, /never overlap/i);
});
