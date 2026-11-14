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

import { auditPlan } from '../../src/core/plan/plan-audit.mjs';
import { verifyPlan } from '../../src/core/plan/verifier.mjs';
import { scopeFor } from '../../src/core/plan/plan-scope.mjs';
import { waiverCovers } from '../../src/core/plan/waivers.mjs';

function fixture({ architecture = null, prd = null, plans = {}, waivers = null, answers = null, decisions = {}, tasksYaml = false, docs = {}, outside = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-floor-'));
  const slugDir = join(root, 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  if (architecture) writeFileSync(join(slugDir, 'architecture.yaml'), architecture, 'utf8');
  if (tasksYaml) writeFileSync(join(slugDir, 'tasks.yaml'), 'tasks: []\n', 'utf8');
  if (Object.keys(docs).length) {
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    for (const [name, text] of Object.entries(docs)) {
      writeFileSync(join(slugDir, 'docs', name), text, 'utf8');
    }
  }
  if (outside) writeFileSync(join(root, 'outside.md'), '# Outside\n\ntext\n', 'utf8');
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
    writeFileSync(
      join(f.slugDir, 'tasks.yaml'),
      'tasks:\n  - id: T1\n    title: api\n    depends_on: []\n    file_ownership: ["src/core/**", "tests/unit/core/**"]\n' +
        '    acceptance:\n      - "the probe result is persisted"\n',
      'utf8',
    );
    // The ledger is applied by the VERIFIER — over every finding the floor
    // reports. It used to be applied inside the audit, over the audit's
    // findings only, so a waiver naming a task-file defect suppressed
    // nothing.
    const report = verifyPlan(scopeFor(f.slugDir), {});
    assert.ok(
      !report.issues.some((i) => i.startsWith('MATRIX_CLAIMS_UNDECLARED')),
      `the waived finding must not remain an issue: ${report.issues.join(' | ')}`,
    );
    assert.ok(
      report.audit.waivedFindings.some((w) => w.finding.includes('MATRIX_CLAIMS_UNDECLARED')),
      'the waived finding must still be REPORTED — a deviation stays visible',
    );
    assert.equal(report.audit.waivedFindings[0].waiver, 'W1', 'the waiver that covered it is named');
  } finally {
    f.cleanup();
  }
});

test('a waiver covers a TASK-FILE defect too, not only an audit finding', () => {
  // The skill promises that "a waived finding never blocks the gate". A
  // waiver naming NO_ACCEPTANCE used to suppress NOTHING — the ledger was
  // applied to the audit's findings alone — so the plan still failed and
  // the agent was told to fix a defect the user had already signed off.
  const f = fixture({
    waivers: [
      'waivers:',
      '  - id: W2',
      '    scope: ["NO_ACCEPTANCE"]',
      '    finding: "the task has no acceptance criteria"',
      '    reason: "the acceptance is verified manually in review"',
      '    approved_by: user',
      '    approved_at: 2026-11-10',
    ].join('\n'),
  });
  try {
    // An EMPTY acceptance list — the validator's NO_ACCEPTANCE.
    writeFileSync(
      join(f.slugDir, 'tasks.yaml'),
      'tasks:\n  - id: T1\n    title: api\n    depends_on: []\n    file_ownership: ["src/core/**"]\n    acceptance: []\n',
      'utf8',
    );
    const report = verifyPlan(scopeFor(f.slugDir), {});
    assert.ok(
      !report.issues.some((i) => i.startsWith('NO_ACCEPTANCE')),
      `the waived task-file finding must not remain an issue: ${report.issues.join(' | ')}`,
    );
    assert.ok(
      report.audit.waivedFindings.some((w) => w.finding.includes('NO_ACCEPTANCE')),
      `the waiver is recorded against the finding it covered: ${JSON.stringify(report.audit.waivedFindings)}`,
    );
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

test('a \'./\'-prefixed root or glob does not silently skip the mirror rule', () => {
  // `./src` and `src` are the same root. The floor compared them literally,
  // so a plan that declared one and owned the other skipped the rule and
  // still reached APPROVE.
  const f = fixture({
    architecture: 'toolchain:\n  source_root: ./src\n  test_root: ./tests\n',
  });
  try {
    const audit = auditPlan({
      slugDir: f.slugDir,
      tasks: [{ id: 'T1', depends_on: [], file_ownership: ['./src/core/**'], acceptance: ['x'] }],
    });
    assert.ok(
      audit.issues.some((i) => i.startsWith('MIRROR_MISSING')),
      `the mirror rule must still run: ${audit.issues.join(' | ')}`,
    );
    assert.ok(
      audit.issues.some((i) => i.includes('tests/core/**')),
      `the mirrored path must use the DECLARED root: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a host_path that merely CONTAINS .archgen/ is not rewritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-host-'));
  const slugDir = join(root, '.archgen', 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  mkdirSync(join(root, 'packages', 'app', '.archgen'), { recursive: true });
  writeFileSync(join(root, 'packages', 'app', '.archgen', 'config.md'), '# Config\n', 'utf8');
  writeFileSync(
    join(slugDir, 'answers.yaml'),
    [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/docs/prd.md',
      '      decision: reuse',
      '      reason: the host PRD is current',
      '      host_path: packages/app/.archgen/config.md',
      '',
    ].join('\n'),
    'utf8',
  );
  try {
    const audit = auditPlan({ slugDir, tasks: TASKS });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_REUSE_MISSING')),
      `the host path must resolve as written: ${audit.issues.join(' | ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('a waiver scoped to a WORD in the prose does NOT suppress the finding', () => {
  // The finding's PROSE said "mirrored test path". A scope of "test" (or
  // "path") matched that prose and approved an unrelated defect.
  const issue = "MIRROR_MISSING: task 'T1' owns 'src/core/**' but no task owns the mirrored test path 'tests/unit/core/**'";
  assert.ok(!waiverCovers({ scope: ['test'] }, issue), 'a word in the prose is not a subject');
  assert.ok(!waiverCovers({ scope: ['path'] }, issue), 'a word in the prose is not a subject');
  assert.ok(!waiverCovers({ scope: ['src'] }, issue), 'a directory fragment is not the subject');
  // The ACTUAL subject — the quoted path and the task id — still matches.
  assert.ok(waiverCovers({ scope: ['T1'] }, issue), 'the task id is a subject');
  assert.ok(waiverCovers({ scope: ['src/core/**'] }, issue), 'the quoted path is a subject');
});

test('a waiver scoped to one acceptance does not cover a LONGER one', () => {
  const issue = "MATRIX_CLAIM_MISMATCH: edge-case matrix row 'E4' cites T9#20, but that acceptance does not claim 'E4'";
  assert.ok(waiverCovers({ scope: ['T9#20'] }, issue), 'the exact acceptance matches');
  assert.ok(!waiverCovers({ scope: ['T9#2'] }, issue), 'T9#2 must not cover T9#20');
});

test('a waiver does not cover a finding through its DETAIL clause', () => {
  // The finding is about T19#1. T1#1 appears only in the detail clause —
  // "the acceptance that claims it is T1#1" — so a waiver scoped to T1#1
  // must not silence it.
  const issue =
    "MATRIX_CLAIM_MISMATCH: edge-case matrix row 'E1' cites T19#1, but that acceptance does not claim 'E1' — the acceptance that claims it is T1#1.";
  assert.ok(!waiverCovers({ scope: ['T1#1'] }, issue), 'the detail clause is not a subject');
  assert.ok(waiverCovers({ scope: ['T19#1'] }, issue), 'the subject matches');
});

test('a bare wildcard waiver scope approves nothing', () => {
  const issue = "MIRROR_MISSING: task 'T1' owns 'src/core/**' but no task owns the mirrored test path";
  assert.ok(!waiverCovers({ scope: ['*'] }, issue), 'a bare wildcard is a blanket, not a scope');
  assert.ok(!waiverCovers({ scope: ['**'] }, issue), 'a bare wildcard is a blanket, not a scope');
});

// ── 9. the family a file belongs to ────────────────────────────────────────

test('a sibling artifact does not satisfy a DIFFERENT family\'s decision', () => {
  // `docs/prd.md` and `docs/<module>.md` are different families whose
  // PATTERNS overlap. Matching the pattern let a PRD satisfy the
  // module-diagram family's `create` — so a missing diagram passed.
  const f = fixture({
    plans: { 'demo.md': '# Plan\n\ntext\n' },
    docs: { 'prd.md': '# PRD\n\ntext\n' },
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/docs/<module>.md',
      '      decision: create',
      '      reason: a topology diagram per module',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.issues.some((i) => i.startsWith('PROFILE_CREATE_MISSING')),
      `the missing module diagram must be reported: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

test('an artifact recorded omit is not flagged because a SIBLING family exists', () => {
  const f = fixture({
    plans: { 'demo.md': '# Plan\n\ntext\n' },
    docs: { 'prd.md': '# PRD\n\ntext\n' },
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/docs/<module>.md',
      '      decision: omit',
      '      reason: no non-obvious topology',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_OMIT_PRESENT')),
      `a PRD must not block a plan that omitted the module diagram: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 10. the Profile fence is read from ITS OWN section ─────────────────────

test('a YAML fence in a LATER section is not the plan profile', () => {
  const plan = [
    '# demo — plan',
    '',
    '## Profile',
    '',
    'Prose only — the record is in answers.yaml.',
    '',
    '## Appendix',
    '',
    '```yaml',
    'artifacts:',
    '  - path: .archgen/demo/docs/prd.md',
    '    decision: omit',
    '    reason: not in this plan',
    '```',
    '',
  ].join('\n');
  const f = fixture({ plans: { 'demo.md': plan } });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      !audit.issues.some((i) => i.startsWith('PROFILE_OMIT_PRESENT')),
      `the appendix block must not become the plan profile: ${audit.issues.join(' | ')}`,
    );
    assert.ok(
      audit.warnings.some((w) => w.startsWith('PROFILE_NOT_RECORDED')),
      `the missing profile must warn: ${audit.warnings.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// ── 11. a recorded path may not escape the artifact space ──────────────────

test('a recorded path that escapes the artifact space satisfies nothing', () => {
  const f = fixture({
    plans: { 'demo.md': '# Plan\n\ntext\n' },
    outside: true,
    answers: [
      'plan_profile:',
      '  artifacts:',
      '    - path: .archgen/demo/../outside.md',
      '      decision: create',
      '      reason: a file outside the artifact space',
      '',
    ].join('\n'),
  });
  try {
    const audit = auditPlan({ slugDir: f.slugDir, tasks: TASKS });
    assert.ok(
      audit.issues.some((i) => i.startsWith('PROFILE_CREATE_MISSING')),
      `a path outside the artifact space must not satisfy a create: ${audit.issues.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
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
