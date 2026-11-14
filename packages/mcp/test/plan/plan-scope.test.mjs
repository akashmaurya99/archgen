// plan-scope.test.mjs — the ONE owner of the artifact space.
//
// WHY THIS TEST EXISTS.
//
// The floor read the artifact space from TWO places, each deriving it from
// the caller's `planDir` on its own: the coverage half read `planDir`, the
// audit half read `dirname(planDir)`. They agree only when `planDir` is the
// `plans` directory. A caller who named the SLUG directory instead got a
// report that was confident and false — "no architecture.yaml" (it existed),
// "the plan records no profile" (it did), "TASK-01 is not mentioned in any
// plan file" (it was, in `plans/<slug>.md`).
//
// These tests pin the rule that makes that impossible: the task file and the
// plans directory must name the SAME artifact space, and the scope is
// resolved ONCE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePlanScope, scopeFor } from '../../src/core/plan/plan-scope.mjs';
import { ArchgenError } from '../../src/core/protocol/errors.mjs';

/** An artifact space: `<root>/.archgen/<slug>/` with a task file and a plan. */
function space(slug = 'demo') {
  const root = mkdtempSync(join(tmpdir(), 'ag-scope-'));
  const slugDir = join(root, '.archgen', slug);
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  writeFileSync(join(slugDir, 'tasks.yaml'), 'tasks: []\n', 'utf8');
  writeFileSync(join(slugDir, 'plans', `${slug}.md`), `# Plan\n\nT1 does the thing.\n`, 'utf8');
  const real = realpathSync(slugDir);
  return { root: realpathSync(root), slugDir: real, slug, tasks: join(real, 'tasks.yaml'), plans: join(real, 'plans') };
}

test('the task file and the plans dir resolve to ONE space', () => {
  const s = space();
  const scope = resolvePlanScope({ tasksYaml: s.tasks, planDir: s.plans, projectRoot: s.root });
  assert.equal(scope.slug, 'demo');
  assert.equal(scope.slugDir, s.slugDir);
  assert.equal(scope.plansDir, s.plans);
  assert.equal(scope.tasksFile, s.tasks);
});

test('the plans dir ALONE resolves the space it belongs to', () => {
  const s = space();
  const scope = resolvePlanScope({ planDir: s.plans, projectRoot: s.root });
  assert.equal(scope.slugDir, s.slugDir);
  assert.equal(scope.plansDir, s.plans);
  assert.equal(scope.tasksFile, s.tasks);
});

test('the task file ALONE resolves the space it belongs to', () => {
  const s = space();
  const scope = resolvePlanScope({ tasksYaml: s.tasks, projectRoot: s.root });
  assert.equal(scope.slugDir, s.slugDir);
  assert.equal(scope.plansDir, s.plans);
});

test('THE BUG: the slug dir is NOT a plans dir — it is refused', () => {
  // This is the call that produced the false report: `planDir` named the
  // artifact space itself, so the coverage half read the space's survey doc
  // (`codebase-map.md`) as if it were the plan, and the audit half read
  // `.archgen/` — one level too high.
  const s = space();
  assert.throws(
    () => resolvePlanScope({ tasksYaml: s.tasks, planDir: s.slugDir, projectRoot: s.root }),
    (e) => {
      assert.ok(e instanceof ArchgenError);
      assert.equal(e.code, 'INVALID_INPUT');
      assert.match(e.message, /plans dir must be the 'plans' directory beside the task file/);
      return true;
    },
  );
});

test('a plans dir from ANOTHER space is refused', () => {
  const a = space('demo');
  const b = space('other');
  assert.throws(
    () => resolvePlanScope({ tasksYaml: a.tasks, planDir: b.plans, projectRoot: a.root }),
    (e) => {
      assert.ok(e instanceof ArchgenError);
      assert.equal(e.code, 'INVALID_INPUT');
      assert.match(e.message, /different artifact spaces/);
      return true;
    },
  );
});

test('with nothing to resolve from, the error names what is missing', () => {
  const s = space();
  assert.throws(
    () => resolvePlanScope({ projectRoot: s.root }),
    (e) => {
      assert.ok(e instanceof ArchgenError);
      assert.equal(e.code, 'INVALID_INPUT');
      assert.deepEqual(e.details.missing, ['tasksYaml', 'planDir', 'slug']);
      return true;
    },
  );
});

test('a scope built from a known space names the same two directories', () => {
  const s = space();
  const scope = scopeFor(s.slugDir);
  assert.equal(scope.slugDir, s.slugDir);
  assert.equal(scope.plansDir, s.plans);
  assert.equal(scope.tasksFile, s.tasks);
});
