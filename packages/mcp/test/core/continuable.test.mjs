// continuable.test.mjs — a bound must never hide the tail.
//
// WHY THIS FILE EXISTS.
//
// The floor's findings were capped at 40 with no way to reach the rest: the
// agent could see that there were 120 and never see findings 41–120. A bound
// that hides the tail without a way to reach it is not a bound — it is a loss,
// and the agent ends up fixing a class it cannot enumerate.
//
// Every bounded output must therefore be CONTINUABLE: the payload names the
// next call, and calling it returns the next window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';
import { verifyPlan, planCoverage, MAX_FINDINGS } from '../../src/core/verifier.mjs';
import { docIndex } from '../../src/core/doc-navigator.mjs';

createServer();

const HERE = dirname(fileURLToPath(import.meta.url));

/** N tasks, each missing its mirrored test path (roots declared). */
function brokenPlan(n) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-cont-'));
  const slugDir = join(root, '.archgen', 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
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

test('the floor\'s findings are WALKABLE — the whole tail is reachable', () => {
  const p = brokenPlan(120);
  try {
    const first = verifyPlan(p.tasksYaml, p.plansDir, { offset: 0 });
    assert.equal(first.issues.length, MAX_FINDINGS);
    // Walk the list: every finding is reachable, none is seen twice, and the
    // totals never change.
    const seen = new Set(first.issues);
    let offset = first.issues.length;
    let window = first;
    while (window.omitted.issues > 0) {
      window = verifyPlan(p.tasksYaml, p.plansDir, { offset });
      assert.equal(window.issuesTotal, first.issuesTotal, 'the total never changes');
      assert.equal(window.issueCodes.MIRROR_MISSING, first.issueCodes.MIRROR_MISSING, 'the counts never change');
      for (const issue of window.issues) {
        assert.ok(!seen.has(issue), 'a finding was shown twice');
        seen.add(issue);
      }
      offset += window.issues.length;
    }
    assert.equal(seen.size, first.issuesTotal, 'every finding is reachable');
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('the coverage action\'s uncovered list is walkable', () => {
  const p = brokenPlan(120);
  try {
    const first = planCoverage(p.tasksYaml, p.plansDir, { offset: 0 });
    assert.equal(first.uncovered.length, MAX_FINDINGS);
    const seen = new Set(first.uncovered);
    let offset = first.uncovered.length;
    let window = first;
    while (window.uncovered.length && seen.size < window.uncoveredTotal) {
      window = planCoverage(p.tasksYaml, p.plansDir, { offset });
      assert.equal(window.uncoveredTotal, first.uncoveredTotal, 'the total never changes');
      for (const id of window.uncovered) {
        assert.ok(!seen.has(id), 'an id was shown twice');
        seen.add(id);
      }
      offset += window.uncovered.length;
    }
    assert.equal(seen.size, first.uncoveredTotal, 'every uncovered id is reachable');
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('the tool names the next call for a truncated answer', async () => {
  const p = brokenPlan(120);
  try {
    const ctx = new Context({ projectRoot: p.root, anchorRoot: p.root, home: p.root, env: { PATH: '/nonexistent' } });
    const spec = getToolSpec('archgen_plan');
    const env = await guard(spec.handler, ctx, {
      action: 'verify',
      tasksYaml: p.tasksYaml,
      planDir: p.plansDir,
    });
    assert.ok(env.ok, env.error?.message);
    assert.ok(env.data.issues.length < env.data.issuesTotal, 'the answer is bounded');
    assert.ok(env.meta?.next, 'the payload names the next call');
    assert.match(env.meta.next, /offset:\d+/, 'the next call walks the list');

    // And that next call really returns the next window.
    const at = Number(/offset:(\d+)/.exec(env.meta.next)?.[1] ?? 0);
    const next = await guard(spec.handler, ctx, {
      action: 'verify',
      tasksYaml: p.tasksYaml,
      planDir: p.plansDir,
      offset: at,
    });
    assert.ok(next.ok);
    assert.notDeepEqual(next.data.issues, env.data.issues, 'the next call returns new findings');
    assert.equal(next.data.issuesTotal, env.data.issuesTotal, 'the total is unchanged');
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('a digest scoped to ONE file is complete', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-cont-digest-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    const sections = Array.from({ length: 120 }, (_, s) => `## Section ${s + 1}\n\ntext\n`).join('\n');
    writeFileSync(join(slugDir, 'docs', 'big.md'), `# Big\n\n${sections}`, 'utf8');
    const out = docIndex(slugDir, { mode: 'digest', file: 'docs/big.md', projectRoot: root });
    const file = out.data.files[0];
    assert.equal(file.sectionCount, 121, 'the count is the whole outline');
    assert.equal(file.sections.length, 121, 'a file-scoped digest is COMPLETE');
    assert.equal(file.truncated, undefined, 'nothing was cut');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
