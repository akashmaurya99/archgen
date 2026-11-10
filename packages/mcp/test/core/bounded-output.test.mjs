// bounded-output.test.mjs — a broken plan must not produce an unbounded answer.
//
// WHY.
//
// A plan with 120 tasks, each missing its mirrored test path, produced 120
// findings — 7,191 tokens of near-identical prose in the orchestrator's
// context, for a list it would fix as ONE class ("every task needs its
// mirrored test path"). The digest had the same shape: 13 files x 20
// sections rendered 11,775 tokens of outline, more than the plan it indexed.
//
// The bound must never lose information the agent needs:
//   - the COUNTS per class stay exact, so a class is reported once with its
//     count instead of one line per instance;
//   - the verdict is computed from the full set;
//   - the digest spends its budget on STRUCTURE first, so every file keeps
//     its top-level headings and only the deeper detail is rationed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyPlan, planCoverage, MAX_FINDINGS } from '../../src/core/verifier.mjs';
import { docIndex, DIGEST_SECTION_BUDGET } from '../../src/core/doc-navigator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** N tasks, every one missing its mirrored test path (the roots are declared). */
function brokenPlan(n) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-bounded-'));
  const slugDir = join(root, '.archgen', 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  mkdirSync(join(slugDir, 'docs'), { recursive: true });
  const tasks = Array.from({ length: n }, (_, i) => `  - id: T${i + 1}
    title: module ${i + 1}
    depends_on: []
    file_ownership: ["src/m${i + 1}/**"]
    acceptance:
      - "the module ${i + 1} behaviour holds"`).join('\n');
  writeFileSync(join(slugDir, 'tasks.yaml'), `tasks:\n${tasks}\n`, 'utf8');
  writeFileSync(join(slugDir, 'plans', 'demo.md'), `# Plan\n\nT1 does it.\n`, 'utf8');
  writeFileSync(join(slugDir, 'architecture.yaml'), 'toolchain:\n  source_root: src\n  test_root: tests/unit\n', 'utf8');
  return { root, slugDir, tasksYaml: join(slugDir, 'tasks.yaml'), plansDir: join(slugDir, 'plans') };
}

test('the floor bounds its findings but keeps the counts exact', () => {
  const p = brokenPlan(120);
  try {
    const out = verifyPlan(p.tasksYaml, p.plansDir);
    assert.equal(out.verdict, 'ISSUES');
    assert.ok(out.issues.length <= MAX_FINDINGS, 'the list is bounded');
    assert.equal(out.issueCodes.MIRROR_MISSING, 120, 'the per-class count is exact');
    assert.ok(out.issuesTotal >= 120, 'the TOTAL is exact');
    assert.equal(out.omitted.issues, out.issuesTotal - out.issues.length, 'what was left is reported');
    assert.ok(out.warningsTotal >= 0);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('coverage bounds the uncovered list and reports the total', () => {
  const p = brokenPlan(60);
  try {
    const out = planCoverage(p.tasksYaml, p.plansDir);
    assert.ok(out.tasks.uncovered.length <= MAX_FINDINGS, 'the list is bounded');
    // The plan mentions T1, so T1 is covered and the other 59 are not.
    assert.equal(out.tasks.uncoveredTotal, 59, 'the total is exact');
    assert.equal(out.tasks.coveredTotal, 1, 'the covered total is exact');
    assert.ok(out.findings.total >= out.findings.items.length, 'the findings are bounded and counted');
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('the digest spends its budget on STRUCTURE first — every file keeps its top-level headings', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-digest-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    for (let f = 0; f < 12; f++) {
      const sections = Array.from({ length: 20 }, (_, s) => `## Section ${s + 1}\n\ntext\n`).join('\n');
      writeFileSync(join(slugDir, 'docs', `doc-${f}.md`), `# Doc ${f}\n\n${sections}`, 'utf8');
    }
    const out = docIndex(slugDir, { mode: 'digest', projectRoot: root });
    const total = out.data.files.reduce((n, f) => n + f.sectionCount, 0);
    assert.ok(total > DIGEST_SECTION_BUDGET, 'the fixture exceeds the budget');
    for (const file of out.data.files) {
      assert.ok(file.sections.length > 0, `${file.path} lost its whole outline`);
      assert.equal(file.sectionCount, 21, 'the real count is always reported (20 sections + the title)');
      assert.ok(file.truncated > 0, 'the file says how much of its outline was left out');
    }
    assert.equal(out.data.sectionsOmitted, true, 'the omission is stated');
    assert.match(out.data.hint, /scope the digest to one file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
