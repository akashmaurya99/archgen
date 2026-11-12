// plan-audit.test.mjs — the mechanical floor, and the false positives it must
// not produce.
//
// WHY THIS FILE EXISTS.
//
// The gate agent was doing arithmetic by hand, every round: proving that a
// source-owning task owns the mirrored test path, that a matrix row points at
// an acceptance that exists, that every requirement is cited. Those are facts,
// and facts belong in a tool. The gate ran three or four times because each
// pass surfaced one more category of the same mechanical checks.
//
// And the floor itself had a false positive that made it worse: `SHA-256` was
// parsed as an unknown TASK ID, so a plan mentioning a hash algorithm could
// never pass the deterministic gate. That is the "silly mistake" class — the
// gate failing on legitimate prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditPlan } from '../../src/core/plan-audit.mjs';
import { parseEdgeMatrix } from '../../src/core/artifact-space.mjs';
import { checkPlanCoverage } from '../../src/core/plan-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Build a slug dir with the artifacts the audit reads. */
function fixture({ architecture = null, prd = null, plans = {}, decisions = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-audit-'));
  const slugDir = join(root, 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  if (architecture) writeFileSync(join(slugDir, 'architecture.yaml'), architecture, 'utf8');
  if (prd) {
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    writeFileSync(join(slugDir, 'docs', 'prd.md'), prd, 'utf8');
  }
  for (const [name, text] of Object.entries(plans)) {
    writeFileSync(join(slugDir, 'plans', name), text, 'utf8');
  }
  if (decisions.length) {
    mkdirSync(join(slugDir, 'decisions'), { recursive: true });
    for (const d of decisions) writeFileSync(join(slugDir, 'decisions', d), '# decision\n', 'utf8');
  }
  return { root, slugDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TASKS = [
  { id: 'T1', title: 'core', depends_on: [], file_ownership: ['src/core/**', 'tests/unit/core/**'], acceptance: ['the core test passes'] },
  { id: 'T2', title: 'api', depends_on: ['T1'], file_ownership: ['src/api/**', 'tests/unit/api/**'], acceptance: ['the api test passes', 'the api returns 200'] },
];

test('a technical constant is NOT an unknown task id', () => {
  const f = fixture({ plans: { 'demo.md': '# Plan\n\nThe digest uses SHA-256 and SHA-512.\n' } });
  try {
    const { findings } = checkPlanCoverage(join(f.slugDir, 'plans'), [{ id: 'T1' }]);
    assert.deepEqual(
      findings.filter((x) => x.includes('unknown task id')),
      [],
      `a hash algorithm must not be read as a task id: ${findings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a genuinely unknown task id IS still reported', () => {
  const f = fixture({ plans: { 'demo.md': '# Plan\n\nTask TASK-99 does the thing.\n' } });
  try {
    const { findings } = checkPlanCoverage(join(f.slugDir, 'plans'), [{ id: 'TASK-01' }]);
    assert.ok(
      findings.some((x) => x.includes("unknown task id 'TASK-99'")),
      `a dangling task reference must be reported: ${findings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a dangling task id is reported even when the plan uses NO dashed ids', () => {
  // The poisoned fixture case: tasks are named BASE, and the plan references
  // TASK-999. A prefix rule that only trusted the plan's own prefixes would
  // let that through.
  const f = fixture({ plans: { 'demo.md': '# Plan\n\nThe cleanup crew lives in TASK-999.\n' } });
  try {
    const { findings } = checkPlanCoverage(join(f.slugDir, 'plans'), [{ id: 'BASE' }]);
    assert.ok(
      findings.some((x) => x.includes("unknown task id 'TASK-999'")),
      `a dangling task reference must be reported: ${findings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a requirement id is never read as a task id', () => {
  const f = fixture({ plans: { 'demo.md': '# Plan\n\nThe catalog reads FR-CATALOG-01 and NFR-PERF-2.\n' } });
  try {
    const { findings } = checkPlanCoverage(join(f.slugDir, 'plans'), [{ id: 'T1' }]);
    assert.deepEqual(
      findings.filter((x) => x.includes('unknown task id')),
      [],
      `requirement ids must not be read as task ids: ${findings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('the mirror check fires when a source owner has no mirrored test path', () => {
  const f = fixture({
    architecture: 'toolchain:\n  source_root: src\n  test_root: tests/unit\n',
  });
  try {
    const tasks = [{ id: 'T1', depends_on: [], file_ownership: ['src/core/**'], acceptance: ['x'] }];
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.ok(
      issues.some((x) => x.includes('mirrored test path') && x.includes('tests/unit/core')),
      `the missing mirror must be reported: ${issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('the mirror check stays quiet when the mirrored path is owned', () => {
  const f = fixture({ architecture: 'toolchain:\n  source_root: src\n  test_root: tests/unit\n' });
  try {
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.deepEqual(issues.filter((x) => x.includes('mirrored test path')), []);
  } finally {
    f.cleanup();
  }
});

test('a matrix row citing an acceptance that does not exist is an issue', () => {
  const plan = [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
    '| E1 | empty: no rows | returns an empty list | T2#9 |',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': plan } });
  try {
    const { issues, maps } = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(issues.some((x) => x.includes('T2#9') && x.includes('2 acceptance criteria')));
    assert.equal(maps.edgeMatrix[0].valid, false);
  } finally {
    f.cleanup();
  }
});

test('a matrix row citing a real acceptance is carried with its text', () => {
  const plan = [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
    '| E1 | empty: no rows | returns an empty list | T2#2 |',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': plan } });
  try {
    const { issues, maps } = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.deepEqual(issues.filter((x) => x.includes('edge-case matrix')), []);
    assert.equal(maps.edgeMatrix[0].acceptance, 'the api returns 200');
  } finally {
    f.cleanup();
  }
});

test('a PRD requirement no acceptance cites is an issue; a cited one is not', () => {
  const prd = '# PRD\n\n- FR-CORE-01: the core stores the seed\n- FR-API-01: the api returns a list\n';
  const f = fixture({ prd });
  try {
    const { issues, maps } = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      issues.some((x) => x.includes("FR-API-01") && x.includes('no task acceptance cites it')),
      `an uncited requirement must be reported: ${issues.join(' | ')}`,
    );
    assert.equal(maps.requirements.find((r) => r.id === 'FR-CORE-01').covered, false);
  } finally {
    f.cleanup();
  }
});

test('an acceptance citing a requirement the PRD does not define is an issue', () => {
  const prd = '# PRD\n\n- FR-CORE-01: the core stores the seed\n';
  const f = fixture({ prd });
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/core/**'], acceptance: ['the core stores the seed (FR-CORE-01)'] },
      { id: 'T2', depends_on: [], file_ownership: ['src/api/**'], acceptance: ['the api returns a list (FR-API-01)'] },
    ];
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.ok(
      issues.some((x) => x.includes('FR-API-01') && x.includes('not defined in docs/prd.md')),
      `a dangling FR citation must be reported: ${issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a declared decision without its file is an issue; with the file it is not', () => {
  const arch = 'decisions:\n  - id: D5\n    title: loopback control plane\n';
  const missing = fixture({ architecture: arch });
  try {
    const { issues } = auditPlan({ slugDir: missing.slugDir, tasks: TASKS });
    assert.ok(issues.some((x) => x.includes("decision 'D5'") && x.includes('no decisions/ file')));
  } finally {
    missing.cleanup();
  }

  const present = fixture({ architecture: arch, decisions: ['0005-loopback-control-plane.md'] });
  try {
    const { issues } = auditPlan({ slugDir: present.slugDir, tasks: TASKS });
    assert.deepEqual(issues.filter((x) => x.includes('decision')), []);
  } finally {
    present.cleanup();
  }
});

test('a declared path with no owning task is an issue', () => {
  const arch = 'structure:\n  - path: src/shared/\n    purpose: shared utilities\n';
  const f = fixture({ architecture: arch });
  try {
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(issues.some((x) => x.includes("declares 'src/shared/'") && x.includes('no task owns it')));
  } finally {
    f.cleanup();
  }
});

test('a wave label that disagrees with the DAG is an issue', () => {
  const f = fixture();
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['x'], parallel_group: 'wave-1' },
      { id: 'T2', depends_on: ['T1'], file_ownership: ['src/b/**'], acceptance: ['x'], parallel_group: 'wave-1' },
    ];
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.ok(
      issues.some((x) => x.includes('parallel_group') && x.includes('wave is 2')),
      `a stale wave label must be reported: ${issues.join(' | ')}`,
    );
    assert.ok(issues.some((x) => x.includes('spans') && x.includes('dependency waves')));
  } finally {
    f.cleanup();
  }
});

test('cross-wave ownership containment is a WARNING, never a block', () => {
  const f = fixture();
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['tests/integration/**'], acceptance: ['x'] },
      { id: 'T2', depends_on: ['T1'], file_ownership: ['tests/integration/browser/**'], acceptance: ['x'] },
    ];
    const { issues, warnings } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.deepEqual(issues, [], 'containment alone must not block the gate');
    assert.ok(warnings.some((w) => w.includes('INSIDE') && w.includes('overwrite')));
  } finally {
    f.cleanup();
  }
});

test('the matrix parser reads a plan table and ignores tables without a Covered by column', () => {
  const text = [
    '| Case | Input | Covered by |',
    '| --- | --- | --- |',
    '| E1 | empty | T1#1 |',
    '',
    '| Other | Value |',
    '| --- | --- |',
    '| x | y |',
    '',
  ].join('\n');
  const rows = parseEdgeMatrix(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].task, 'T1');
  assert.equal(rows[0].index, 1);
});
