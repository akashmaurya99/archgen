import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArchitecture } from '../../src/core/plan/architecture-validator.mjs';

const valid = {
  name: 'Demo',
  slug: 'demo',
  toolchain: { source_root: 'src', test_root: 'tests/unit' },
  structure: [{ path: 'src/core/', purpose: 'core' }],
  modules: [{ name: 'core', responsibility: 'core', owns: ['src/core/**'], depends_on_modules: [], key_interfaces: [] }],
  decisions: [{ id: 'D1', title: 'One', consequences: ['tradeoff'] }],
};

test('a coherent architecture has no structural findings', () => {
  assert.deepEqual(validateArchitecture(valid, '/p/.archgen/demo'), []);
});

test('scalar collections and a mismatched slug are defects, not silent absence', () => {
  const issues = validateArchitecture({ ...valid, slug: 'other', structure: 'src/', modules: 'core' }, '/p/.archgen/demo');
  assert.ok(issues.some((issue) => issue.includes("slug 'other' must match")));
  assert.ok(issues.some((issue) => issue.includes('structure must be a sequence')));
  assert.ok(issues.some((issue) => issue.includes('modules must be a sequence')));
});

test('module ownership overlap is rejected', () => {
  const modules = [
    valid.modules[0],
    { name: 'other', responsibility: 'other', owns: ['src/core/foo.ts'], depends_on_modules: [], key_interfaces: [] },
  ];
  const issues = validateArchitecture({ ...valid, modules }, '/p/.archgen/demo');
  assert.ok(issues.some((issue) => issue.startsWith('MODULE_OVERLAP:')));
});

test('rich architecture contracts accept the canonical shape', () => {
  const architecture = {
    ...valid,
    existing_docs: [{ path: 'docs/prd.md', kind: 'prd', status: 'current' }],
    naming_conventions: { test_placement: 'colocated with source' },
    data_contracts: {
      Note: { storage: 'notes table', fields: [{ field: 'id', type: 'string', required: true, notes: 'uuid' }] },
    },
    api_contracts: {
      core: [{ endpoint: 'GET /notes', auth: 'none', request_payload: {}, success: 'Note[]', error_shape: { code: 'string', message: 'string', retryable: 'boolean' } }],
    },
    environment_matrix: [{ var: 'PORT', dev: '3000', ci: '3000', prod: '8080', required: true }],
  };
  assert.deepEqual(validateArchitecture(architecture, '/p/.archgen/demo'), []);
});

test('malformed rich contract fields are named instead of being ignored', () => {
  const architecture = {
    ...valid,
    existing_docs: [{ path: 'docs/prd.md', kind: 'other', status: 'unknown' }],
    naming_conventions: { test_placement: '' },
    data_contracts: { Note: { storage: 'notes', fields: [{ field: 'id', type: 'string', required: 'yes' }] } },
    api_contracts: { core: [{ endpoint: 'GET /notes', auth: 'none', request_payload: [], success: 'Note[]', error_shape: {} }] },
    environment_matrix: [{ var: 'PORT', dev: '3000', ci: '3000', prod: '8080', required: 'yes' }],
  };
  const issues = validateArchitecture(architecture, '/p/.archgen/demo');
  for (const expected of ['existing_docs[0].kind', 'existing_docs[0].status', 'naming_conventions.test_placement', 'fields[0]', 'request_payload', 'error_shape', 'environment_matrix[0]']) {
    assert.ok(issues.some((issue) => issue.includes(expected)), `missing ${expected}: ${issues.join(' | ')}`);
  }
});

test('module identities, dependency references, and cycles are validated', () => {
  const modules = [
    { name: 'a', responsibility: 'a', owns: ['src/a/**'], depends_on_modules: ['b'], key_interfaces: [] },
    { name: 'b', responsibility: 'b', owns: ['src/b/**'], depends_on_modules: ['a', 'missing'], key_interfaces: [] },
    { name: 'a', responsibility: 'duplicate', owns: ['src/c/**'], depends_on_modules: [], key_interfaces: [] },
  ];
  const issues = validateArchitecture({ ...valid, modules }, '/p/.archgen/demo');
  assert.ok(issues.some((issue) => issue.includes('duplicates module name')));
  assert.ok(issues.some((issue) => issue.includes("unknown module 'missing'")));
  assert.ok(issues.some((issue) => issue.includes('contains a cycle')));
});

test('mirrored source and test roots cannot be identical', () => {
  const architecture = { ...valid, toolchain: { source_root: './src', test_root: 'src/' } };
  assert.ok(validateArchitecture(architecture, '/p/.archgen/demo').some((issue) => issue.includes('must name different roots')));
});

test('ADR consequences are a sequence, not a scalar', () => {
  const architecture = { ...valid, decisions: [{ id: 'D1', title: 'One', consequences: 'tradeoff' }] };
  assert.ok(validateArchitecture(architecture, '/p/.archgen/demo').some((issue) => issue.includes('consequences')));
});
