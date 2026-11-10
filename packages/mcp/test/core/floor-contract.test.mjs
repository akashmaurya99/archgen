// floor-contract.test.mjs — the floor's NEW contracts, pinned by example.
//
// WHY THIS FILE EXISTS.
//
// Two independent audits found that the floor did not do what the references
// said it did:
//
//   - A WAIVER suppressed nothing. The references said "a waived finding is
//     not a defect to fix" in three places; the floor read the ledger and
//     then ignored it. A plan with an approved deviation could therefore
//     NEVER reach APPROVE — the gate was unpassable for every waived
//     defect.
//   - A recorded `create` decision could never be satisfied. The ladder's
//     paths were literal placeholders (`decisions/NNNN-<title>.md`), so the
//     floor compared the placeholder against disk, reported
//     PROFILE_CREATE_MISSING for the real file, and PROFILE_UNRECORDED for
//     the file that actually existed.
//   - A matrix row carrying the template's placeholder (`<ID>#1`) did not
//     parse — so the row escaped EVERY traceability check, silently.
//   - A plan with edge-case rows and NO declared claim was reported as
//     clean, while the reference promised the floor would say so.
//
// Each of those is a promise the references made and the floor broke. These
// tests pin the corrected behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditPlan, waiverCovers } from '../../src/core/plan-audit.mjs';

function fixture({ architecture = null, prd = null, plans = {}, waivers = null, answers = null, decisions = {}, tasksYaml = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-floor-'));
  const slugDir = join(root, 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  if (architecture) writeFileSync(join(slugDir, 'architecture.yaml'), architecture, 'utf8');
  if (tasksYaml) writeFileSync(join(slugDir, 'tasks.yaml'), 'tasks: []\n', 'utf8');
  if (prd) {
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    writeFileSync(join(slugDir, 'docs', 'prd.md'), prd, 'utf8');
  }
  for (const [name, text] of Object.entries(plans)) {
    writeFileSync(join(slugDir, 'plans', name), text, 'utf8');
  }
  if (Object.keys(decisions).length) {
    mkdirSync(join(slugDir, 'decisions'), { recursive: true });
    for (const [name, text] of Object.entries(decisions)) {
      writeFileSync(join(slugDir, 'decisions', name), text, 'utf8');
    }
  }
  if (waivers) writeFileSync(join(slugDir, 'waivers.yaml'), waivers, 'utf8');
  if (answers) writeFileSync(join(slugDir, 'answers.yaml'), answers, 'utf8');
  return { root, slugDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const TASKS = [
  {
    id: 'T1',
    depends_on: [],
    file_ownership: ['src/core/**', 'tests/unit/core/**'],
    acceptance: ['the probe result is persisted (covers E1)'],
  },
];

/** A plan whose matrix rows exist but whose acceptances declare no claim. */
const TASKS_UNCLAIMED = [
  {
    id: 'T1',
    depends_on: [],
    file_ownership: ['src/core/**', 'tests/unit/core/**'],
    acceptance: ['the probe result is persisted'],
  },
];

const MATRIX = [
  '| Case | Input/state | Expected behavior | Covered by |',
  '| --- | --- | --- | --- |',
  '| E1 | empty | returns an empty list | T1#1 |',
  '',
].join('\n');

// ── 1. a waiver SUPPRESSES the finding it covers ───────────────────────────

test('a valid waiver suppresses the finding it covers, and the plan can approve', () => {
  const f = fixture({
    architecture: 'toolchain:\n  source_root: src\n  test_root: tests/unit\n',
    plans: { 'demo.md': MATRIX },
    waivers: [
      'waivers:',
      '  - id: W1',
      '    scope: ["MATRIX_CLAIMS_UNDECLARED"]',
      '    finding: "the matrix rows are not claimed"',
      '    reason: "this plan predates the claim convention"',
      '    approved_by: user',
      '    approved_at: 2026-11-10',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS_UNCLAIMED });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('MATRIX_CLAIMS_UNDECLARED')),
      `the waived finding must not remain an issue: ${audit.issues.join(' | ')}`,
    );
    assert.ok(
      audit.waivedFindings.some((w) => w.finding.includes('MATRIX_CLAIMS_UNDECLARED')),
      'the waived finding must still be REPORTED — a deviation stays visible',
    );
    assert.equal(audit.waivedFindings[0].waiver, 'W1', 'the waiver that covered it is named');
  } finally {
    f.cleanup();
  }
});

test('a waiver that covers one instance does not cover the whole class', () => {
  const issue = "MIRROR_MISSING: task 'T19' owns 'src/a/**' but no task owns the mirrored test path";
  assert.ok(waiverCovers({ scope: ['T19'] }, issue), 'the subject matches');
  assert.ok(!waiverCovers({ scope: ['T20'] }, issue), 'a different subject does not');
  assert.ok(waiverCovers({ scope: ['MIRROR_MISSING'] }, issue), 'the code covers the class');
  assert.ok(!waiverCovers({ scope: ['T1'] }, issue), 'a prefix does not match a longer id');
});

test('a waiver missing a required field is INVALID and suppresses nothing', () => {
  const f = fixture({
    architecture: 'toolchain:\n  source_root: src\n  test_root: tests/unit\n',
    plans: { 'demo.md': MATRIX },
    waivers: [
      'waivers:',
      '  - id: W1',
      '    scope: ["MATRIX_CLAIMS_UNDECLARED"]',
      '    finding: "the matrix rows are not claimed"',
      '    reason: ""',
      '    approved_by: user',
      '    approved_at: 2026-11-10',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS_UNCLAIMED });
    assert.ok(
      audit.issues.some((i) => i.startsWith('WAIVER_INVALID')),
      'a waiver without a reason is not a waiver',
    );
    assert.ok(
      audit.issues.some((i) => i.startsWith('MATRIX_CLAIMS_UNDECLARED')),
      'an invalid waiver suppresses nothing',
    );
  } finally {
    f.cleanup();
  }
});

// ── 2. the profile's decisions are proved against FAMILIES ─────────────────

test('a recorded create decision is satisfied by the real file, not the placeholder', () => {
  const f = fixture({
    decisions: { '0001-store-engine.md': '# D1\n\n## Decision\n\nUse Postgres.\n' },
    plans: { 'demo.md': '# Plan\n\nThe plan of record.\n' },
    tasksYaml: true,
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/decisions/NNNN-<title>.md',
      '      decision: create',
      '      reason: irreversible storage decision',
      '    - path: .archgen/demo/plans/demo.md',
      '      decision: create',
      '      reason: the plan of record',
      '    - path: .archgen/demo/tasks.yaml',
      '      decision: create',
      '      reason: the task contract',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_CREATE_MISSING')),
      `the real decision file must satisfy the create: ${audit.issues.join(' | ')}`,
    );
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_UNRECORDED')),
      `the real decision file must not be unrecorded: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a reuse decision without a host_path is invalid', () => {
  const f = fixture({
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/docs/prd.md',
      '      decision: reuse',
      '      reason: the host PRD is current',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.issues.some((i) => i.startsWith('PROFILE_DECISION_INVALID') && i.includes('host_path')),
      `a reuse decision must name the host file: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 3. the matrix's unbound rows are VISIBLE ───────────────────────────────

test('a matrix row still carrying the template placeholder is reported', () => {
  const table = [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
    '| E1 | empty | returns an empty list | <ID>#1 |',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': table } });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.issues.some((i) => i.startsWith('MATRIX_CITATION_UNRESOLVED')),
      `an unbound row must be reported: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a matrix with rows and NO declared claim is reported', () => {
  const table = [
    '| Case | Input/state | Expected behavior | Covered by |',
    '| --- | --- | --- | --- |',
    '| E1 | empty | returns an empty list | T1#1 |',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': table } });
  try {
    const audit = auditPlan({
      slugDir: f.slugDir,
      tasks: [{ id: 'T1', depends_on: [], file_ownership: ['src/core/**'], acceptance: ['the probe persists'] }],
    });
    assert.ok(
      audit.issues.some((i) => i.startsWith('MATRIX_CLAIMS_UNDECLARED')),
      `the unbound matrix must be reported: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a matrix whose acceptance claims the row is clean', () => {
  const f = fixture({ plans: { 'demo.md': MATRIX } });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('MATRIX_')),
      `a bound matrix must be clean: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 4. the mirror uses the DECLARED roots, never a guessed level ───────────

test('the mirror uses the DECLARED test root — no guessed level', () => {
  const f = fixture({
    architecture: 'toolchain:\n  source_root: src\n  test_root: tests/unit\n',
  });
  try {
    const audit = auditPlan({
      slugDir: f.slugDir,
      tasks: [{ id: 'T1', depends_on: [], file_ownership: ['src/core/**'], acceptance: ['x'] }],
    });
    const mirror = audit.issues.find((i) => i.startsWith('MIRROR_MISSING'));
    assert.ok(mirror, 'the missing mirror must be reported');
    // The declared root is used AS DECLARED. The floor used to insert its own
    // `unit/` level, which demanded 'tests/unit/unit/core' for a host that
    // had declared 'tests/unit'.
    assert.ok(mirror.includes('tests/unit/core'), `the declared root must be used: ${mirror}`);
    assert.ok(!mirror.includes('unit/unit'), `the floor must not guess a level: ${mirror}`);
  } finally {
    f.cleanup();
  }
});

test('a task that owns the mirrored path is clean, under the declared root', () => {
  const f = fixture({
    architecture: 'toolchain:\n  source_root: src\n  test_root: tests/unit\n',
  });
  try {
    const audit = auditPlan({
      slugDir: f.slugDir,
      tasks: [
        {
          id: 'T1',
          depends_on: [],
          file_ownership: ['src/core/**', 'tests/unit/core/**'],
          acceptance: ['x'],
        },
      ],
    });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('MIRROR_MISSING')),
      `the mirrored path must satisfy the rule: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a different declared test root is honoured too — the floor never guesses', () => {
  const f = fixture({
    architecture: 'toolchain:\n  source_root: src\n  test_root: spec\n',
  });
  try {
    const audit = auditPlan({
      slugDir: f.slugDir,
      tasks: [{ id: 'T1', depends_on: [], file_ownership: ['src/core/**', 'spec/core/**'], acceptance: ['x'] }],
    });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('MIRROR_MISSING')),
      `any declared test root must work: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 6. the profile's own home is a real artifact ───────────────────────────

test('a MEDIUM plan can satisfy its own recorded create of answers.yaml', () => {
  // `answers.yaml` is where the profile is RECORDED, so it is exempt from
  // the "needs a decision" list — but it is still an artifact the profile
  // marks `create`. Exempting it from the list must not exempt it from
  // EXISTING: otherwise a MEDIUM/LARGE plan can never satisfy its own
  // profile and the floor can never approve it.
  const f = fixture({
    tasksYaml: true,
    plans: { 'demo.md': '# Plan\n\nThe plan of record.\n' },
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/answers.yaml',
      '      decision: create',
      '      reason: captured requirements and the plan profile',
      '    - path: .archgen/demo/plans/demo.md',
      '      decision: create',
      '      reason: the plan of record',
      '    - path: .archgen/demo/tasks.yaml',
      '      decision: create',
      '      reason: the task contract',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_CREATE_MISSING')),
      `the recorded create must be satisfiable: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('an answers.yaml marked omit is still caught when the file exists', () => {
  const f = fixture({
    tasksYaml: true,
    plans: { 'demo.md': '# Plan\n\nThe plan of record.\n' },
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/answers.yaml',
      '      decision: omit',
      '      reason: a SMALL plan keeps the profile in the plan',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.issues.some((i) => i.startsWith('PROFILE_OMIT_PRESENT')),
      `an omit decision about a file that exists must be caught: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 7. the gate block is found wherever it was written ─────────────────────

test('the gate in the plan fence is read even when answers.yaml carries the profile', () => {
  const plan = [
    '# demo — plan',
    '',
    '## Profile',
    '',
    '```yaml',
    'scope_class: SMALL',
    'artifacts:',
    '  - path: .archgen/demo/plans/demo.md',
    '    decision: create',
    '    reason: the plan of record',
    'gate:',
    '  verifier: ""',
    '  rounds: 2',
    '  waived: 0',
    '```',
    '',
  ].join('\n');
  const f = fixture({
    plans: { 'demo.md': plan },
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/plans/demo.md',
      '      decision: create',
      '      reason: the plan of record',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.warnings.some((w) => w.startsWith('GATE_IDENTITY_MISSING')),
      `the fence gate must be read: ${audit.warnings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a Profile fence carrying ONLY a gate block is still a record', () => {
  const plan = [
    '# demo — plan',
    '',
    '## Profile',
    '',
    '```yaml',
    'gate:',
    '  verifier: ""',
    '  rounds: 2',
    '  waived: 0',
    '```',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': plan } });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.warnings.some((w) => w.startsWith('GATE_IDENTITY_MISSING')),
      `a fence with only a gate must still be checked: ${audit.warnings.join(' | ')}`,
    );
    // A gate-only fence is NOT an artifact profile. Treating it as one gave
    // an EMPTY decision set, and every artifact on disk then read as
    // PROFILE_UNRECORDED — a plan that records no artifact profile at all
    // would BLOCK the floor instead of warning about it.
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_UNRECORDED')),
      `a gate-only fence must not turn every artifact into a defect: ${audit.issues.join(' | ')}`,
    );
    assert.ok(
      audit.warnings.some((w) => w.startsWith('PROFILE_NOT_RECORDED')),
      `the missing artifact profile must warn: ${audit.warnings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 8. a waiver's glob covers the paths it names ───────────────────────────

test('a waiver scoped to a GLOB covers the paths inside it', () => {
  const issue = "MIRROR_MISSING: task 'T1' owns 'src/a/x.ts' but no task owns the mirrored test path";
  assert.ok(
    waiverCovers({ scope: ['src/a/**'] }, issue),
    'a glob scope must cover the file it names, not only the glob text',
  );
  assert.ok(
    !waiverCovers({ scope: ['src/b/**'] }, issue),
    'a glob scope must not cover an unrelated path',
  );
});

test('a SMALL plan records its gate in the plan Profile fence, and the floor reads it', () => {
  const plan = [
    '# demo — plan',
    '',
    '## Profile',
    '',
    '```yaml',
    'scope_class: SMALL',
    'artifacts:',
    '  - path: .archgen/demo/plans/demo.md',
    '    decision: create',
    '    reason: the plan of record',
    'gate:',
    '  verifier: "the user"',
    '  rounds: 2',
    '  findings:',
    '    blocking: 0',
    '    nit: 0',
    '    observation: 0',
    '  waived: 0',
    '  residual: 0',
    '  at: "2026-11-10T09:00:00Z"',
    '```',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': plan } });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      !audit.warnings.some((w) => w.startsWith('GATE_IDENTITY_MISSING')),
      `the gate in the plan fence must be read: ${audit.warnings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});
