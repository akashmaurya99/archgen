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
import { verifyPlan, planCoverage, MAX_FINDINGS } from '../../src/core/plan/verifier.mjs';
import { scopeFor } from '../../src/core/plan/plan-scope.mjs';
import { docIndex } from '../../src/core/docs/doc-navigator.mjs';

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
    const first = verifyPlan(scopeFor(dirname(p.plansDir)), { offset: 0 });
    assert.equal(first.issues.length, MAX_FINDINGS);
    // Walk the list: every finding is reachable, none is seen twice, and the
    // totals never change.
    const seen = new Set(first.issues);
    let offset = first.issues.length;
    let window = first;
    while (window.omitted.issues > 0) {
      window = verifyPlan(scopeFor(dirname(p.plansDir)), { offset });
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
    const first = planCoverage(scopeFor(dirname(p.plansDir)), { collection: 'uncovered' });
    assert.equal(first.uncovered.items.length, MAX_FINDINGS);
    const seen = new Set(first.uncovered.items);
    let offset = first.uncovered.items.length;
    let window = first;
    while (seen.size < window.uncovered.total) {
      window = planCoverage(scopeFor(dirname(p.plansDir)), { collection: 'uncovered', offset });
      assert.equal(window.uncovered.total, first.uncovered.total, 'the total never changes');
      for (const id of window.uncovered.items) {
        assert.ok(!seen.has(id), 'an id was shown twice');
        seen.add(id);
      }
      offset += window.uncovered.items.length;
    }
    assert.equal(seen.size, first.uncovered.total, 'every uncovered id is reachable');
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('the coverage action\'s TASK list is walkable too — the default collection has a cursor', () => {
  const p = brokenPlan(120);
  try {
    const first = planCoverage(scopeFor(dirname(p.plansDir)), { collection: 'tasks', limit: 10 });
    assert.equal(first.tasks.items.length, 10);
    const seen = new Set(first.tasks.items.map((t) => t.id));
    let offset = first.tasks.items.length;
    while (seen.size < first.tasks.total) {
      const window = planCoverage(scopeFor(dirname(p.plansDir)), { collection: 'tasks', limit: 10, offset });
      assert.equal(window.tasks.total, first.tasks.total, 'the total never changes');
      for (const t of window.tasks.items) {
        assert.ok(!seen.has(t.id), 'a task was shown twice');
        seen.add(t.id);
      }
      offset += window.tasks.items.length;
    }
    assert.equal(seen.size, first.tasks.total, 'every task is reachable');
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

test('a continuation NEVER points at the same offset — the tail terminates', async () => {
  // THE LOOPING DEFECT. The truncation test compared the PAGE length with
  // the TOTAL, which is true at the tail as well — so the published
  // continuation pointed at the SAME offset, and an agent that followed it
  // spun on an empty page forever.
  const p = brokenPlan(60);
  try {
    const ctx = new Context({
      projectRoot: p.root,
      anchorRoot: p.root,
      home: p.root,
      env: { PATH: '/nonexistent' },
    });
    const spec = getToolSpec('archgen_plan');
    for (const action of ['verify', 'coverage']) {
      const args = {
        action,
        tasksYaml: p.tasksYaml,
        planDir: p.plansDir,
        limit: 10,
      };
      // Walk to the end and make sure the chain STOPS.
      let offset = 0;
      const seen = new Set();
      for (let i = 0; i < 40; i++) {
        const envelope = await guard(spec.handler, ctx, { ...args, offset });
        assert.ok(envelope.ok, envelope.error?.message);
        const next = envelope.meta?.next;
        if (!next) break;
        const at = Number(/offset:(\d+)/.exec(next)?.[1] ?? -1);
        assert.ok(at >= 0, `${action}: the continuation must carry an offset: ${next}`);
        assert.ok(!seen.has(at), `${action}: the continuation REPEATED offset ${at} — it loops forever`);
        seen.add(at);
        assert.ok(at > offset, `${action}: the continuation must ADVANCE (offset ${offset} -> ${at})`);
        offset = at;
      }
      assert.ok(
        seen.size < 40,
        `${action}: the continuation chain must terminate, not run forever`,
      );
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test('a collection the action does not have is a typed error, not a silent zero', async () => {
  const p = brokenPlan(20);
  try {
    const ctx = new Context({
      projectRoot: p.root,
      anchorRoot: p.root,
      home: p.root,
      env: { PATH: '/nonexistent' },
    });
    const spec = getToolSpec('archgen_plan');
    // `issues` is a verify collection, not a coverage one.
    const envelope = await guard(spec.handler, ctx, {
      action: 'coverage',
      tasksYaml: p.tasksYaml,
      planDir: p.plansDir,
      collection: 'issues',
    });
    assert.ok(!envelope.ok, 'a mismatched collection must be refused');
    assert.equal(envelope.error?.code, 'INVALID_INPUT');
    assert.match(envelope.error?.message ?? '', /not a collection of 'coverage'/);
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

test('a 501-section file is still COMPLETE when it is the one you asked for', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-cont-big-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    const sections = Array.from({ length: 501 }, (_, s) => `## Section ${s + 1}\n\ntext\n`).join('\n');
    writeFileSync(join(slugDir, 'docs', 'huge.md'), `# Huge\n\n${sections}`, 'utf8');
    const out = docIndex(slugDir, { mode: 'digest', file: 'docs/huge.md', projectRoot: root });
    const file = out.data.files[0];
    assert.equal(file.sectionCount, 502, 'the count is the whole outline');
    assert.equal(file.sections.length, 502, 'NOTHING is cut from a file-scoped digest');
    assert.equal(file.truncated, undefined, 'nothing was cut');
    assert.equal(out.data.sectionsOmitted, undefined, 'nothing was omitted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the file map reaches EVERY file — the old 100-file cap made 101+ unreachable', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-cont-files-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(slugDir, 'docs', `doc-${String(i).padStart(3, '0')}.md`), `# Doc ${i}\n\ntext\n`, 'utf8');
    }
    const out = docIndex(slugDir, { mode: 'overview', projectRoot: root });
    assert.equal(out.data.totalFiles, 120, 'the true count is reported');
    assert.equal(out.data.files.length, 120, 'every file is reachable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
