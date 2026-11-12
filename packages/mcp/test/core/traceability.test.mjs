// traceability.test.mjs — the link is written down, and the floor joins it.
//
// WHY THIS FILE EXISTS.
//
// The gate agent kept reporting the same class of finding by eye: an edge-case
// matrix row pointing at the acceptance that does NOT verify it ("E4 cites
// T9#1, but T9#1 is the probe-correctness check"). That is a JOIN, not a
// judgement — so the join belongs in the data.
//
// An acceptance that verifies a case now says so — "(covers E4)" — and the
// floor checks that the matrix row and the acceptance agree. The ids are
// artifact ids, never code names: the rule is identical in every ecosystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditPlan } from '../../src/core/plan/plan-audit.mjs';
import { readWaivers } from '../../src/core/plan/waivers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function fixture({ architecture = null, prd = null, plans = {}, waivers = null, answers = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-trace-'));
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
  if (waivers) writeFileSync(join(slugDir, 'waivers.yaml'), waivers, 'utf8');
  if (answers) writeFileSync(join(slugDir, 'answers.yaml'), answers, 'utf8');
  return { root, slugDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const MATRIX = (row, ref) =>
  [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
    `| ${row} | probe persistence | result stored for audit | ${ref} |`,
    '',
  ].join('\n');

test('a row whose acceptance does not claim it is an issue', () => {
  // The matrix points E4 at T1#1, but that acceptance claims E5 — the exact
  // "row points at the wrong acceptance" defect the gate used to find by eye.
  const table = [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
    '| E4 | probe persistence | result stored for audit | T1#1 |',
    '| E5 | probe correctness | probe returns the expected value | T1#1 |',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': table } });
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['the probe returns the expected value (covers E5)'] },
    ];
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.ok(
      issues.some((x) => x.includes("edge-case matrix row 'E4'") && x.includes('does not claim')),
      `the mismatched claim must be reported: ${issues.join(' | ')}`,
    );
    assert.ok(!issues.some((x) => x.includes("row 'E5'")), 'the matching row must stay clean');
  } finally {
    f.cleanup();
  }
});

test('a row whose acceptance claims it is clean, and the map carries the claim', () => {
  const f = fixture({ plans: { 'demo.md': MATRIX('E4', 'T1#1') } });
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['the probe result is persisted (covers E4)'] },
    ];
    const { issues, maps } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.deepEqual(issues.filter((x) => x.includes('edge-case matrix')), []);
    assert.deepEqual(maps.edgeMatrix[0].claims, ['E4']);
    assert.equal(maps.edgeMatrix[0].claimOk, true);
  } finally {
    f.cleanup();
  }
});

test('a plan that declares no claims is not blocked — the convention is detected', () => {
  const f = fixture({ plans: { 'demo.md': MATRIX('E4', 'T1#1') } });
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['the probe result is persisted'] },
    ];
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.deepEqual(issues.filter((x) => x.includes('does not claim')), []);
  } finally {
    f.cleanup();
  }
});

test('an acceptance claiming an edge row that does not exist is an issue', () => {
  const f = fixture({ plans: { 'demo.md': MATRIX('E4', 'T1#1') } });
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['the probe result is persisted (covers E4, E9)'] },
    ];
    const { issues } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.ok(
      issues.some((x) => x.includes("claims edge case 'E9'")),
      `a dangling claim must be reported: ${issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a requirement claim counts as a citation', () => {
  const f = fixture({ prd: '# PRD\n\n- FR-API-01: the api returns the list\n' });
  try {
    const tasks = [
      { id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['the api returns the list (covers FR-API-01)'] },
    ];
    const { issues, maps } = auditPlan({ slugDir: f.slugDir, tasks });
    assert.deepEqual(issues.filter((x) => x.includes('FR-API-01')), []);
    assert.equal(maps.requirements[0].covered, true);
    assert.match(maps.requirements[0].text, /the api returns the list/);
  } finally {
    f.cleanup();
  }
});

test('the waiver ledger is read, and its count is checked against the record', () => {
  const waivers = [
    'waivers:',
    '  - id: W1',
    '    scope: ["T1#1"]',
    '    finding: "the live check needs credentials"',
    '    reason: "it runs on the operator machine"',
    '    approved_by: user',
    '    approved_at: 2026-11-10',
    '',
  ].join('\n');
  const f = fixture({ waivers, answers: 'plan_profile:\n  gate:\n    waived: 0\n' });
  try {
    const list = readWaivers(join(f.slugDir, 'waivers.yaml'));
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'W1');
    assert.equal(list[0].approvedBy, 'user');
    const { warnings } = auditPlan({ slugDir: f.slugDir, tasks: [{ id: 'T1', depends_on: [], file_ownership: ['src/a/**'], acceptance: ['x'] }] });
    assert.ok(
      warnings.some((w) => w.includes('records 0 waived') && w.includes('lists 1')),
      `a ledger that disagrees with the record must be reported: ${warnings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('the mirror rule is reported as NOT ENFORCED when the roots are undeclared', () => {
  const f = fixture({ architecture: 'structure:\n  - path: src/core/\n    purpose: core\n' });
  try {
    const { warnings } = auditPlan({
      slugDir: f.slugDir,
      tasks: [{ id: 'T1', depends_on: [], file_ownership: ['src/core/**'], acceptance: ['x'] }],
    });
    assert.ok(
      warnings.some((w) => w.includes('NOT ENFORCED') && w.includes('toolchain.source_root')),
      `an unenforceable rule must say so: ${warnings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('no architecture.yaml at all says so loudly too', () => {
  const f = fixture({});
  try {
    const { warnings } = auditPlan({
      slugDir: f.slugDir,
      tasks: [{ id: 'T1', depends_on: [], file_ownership: ['src/core/**'], acceptance: ['x'] }],
    });
    assert.ok(warnings.some((w) => w.includes('NOT ENFORCED')));
  } finally {
    f.cleanup();
  }
});
