// floor-scope-refusal.test.mjs — the floor REFUSES a wrong planDir; it never
// reports false facts about the project.
//
// WHY THIS TEST EXISTS.
//
// The floor read the artifact space from two places, each deriving it from the
// caller's `planDir` on its own: the coverage half read `planDir`, the audit
// half read `dirname(planDir)`. They agree only when `planDir` is the
// `plans` directory.
//
// A caller who named the SLUG directory instead got a report that was
// confident and false:
//
//   "no architecture.yaml — the mirrored-test-tree … rules are NOT ENFORCED"
//   "the plan records no profile — artifact necessity cannot be checked"
//   "task 'T-1' is not mentioned in any plan file under …"
//
// Every one of those was untrue: architecture.yaml existed, the profile was
// recorded, and the plan file mentioned the task. The coverage half had read
// the space's SURVEY doc (`codebase-map.md`) as if it were the plan.
//
// The fix is structural: the scope is resolved ONCE, at the boundary, and
// the two halves are handed the same directories. A wrong planDir is now a
// typed refusal with the exact call that would work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { createServer } from '../../src/server.mjs';
import { guard } from '../../src/envelope.mjs';
import { Context } from '../../src/context.mjs';

// The tool specs are registered when the server is created — the same way
// the real server registers them.
createServer();

const TASKS = [
  {
    id: 'T-1',
    title: 'The tokenizer caches its vocabulary',
    depends_on: [],
    file_ownership: ['src/tokenizer/**', 'tests/tokenizer/**'],
    acceptance: ['the probe result is persisted (covers E1)'],
  },
];

/** An artifact space that is COMPLETE: architecture, profile, plan, tasks. */
function space(root = null, slug = 'demo') {
  const projectRoot = root ?? mkdtempSync(join(tmpdir(), 'ag-floor-scope-'));
  const slugDir = join(projectRoot, '.archgen', slug);
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  mkdirSync(join(slugDir, 'docs'), { recursive: true });
  writeFileSync(
    join(slugDir, 'tasks.yaml'),
    `tasks:\n  - id: T-1\n    title: The tokenizer caches its vocabulary\n    depends_on: []\n` +
      `    file_ownership: ["src/tokenizer/**", "tests/tokenizer/**"]\n` +
      `    acceptance:\n      - "the probe result is persisted (covers E1)"\n`,
    'utf8',
  );
  // The plan mentions the task — the coverage half must find it.
  writeFileSync(join(slugDir, 'plans', 'demo.md'), '# Plan\n\n## T-1 — The tokenizer caches its vocabulary\n\nT-1 does the thing.\n', 'utf8');
  // The architecture declares its roots, so the mirrored-tree rule CAN run.
  writeFileSync(join(slugDir, 'architecture.yaml'), 'toolchain:\n  source_root: "src"\n  test_root: "tests"\n', 'utf8');
  // The profile is recorded, and it records a decision for EVERY artifact on
  // disk — so artifact necessity can be checked.
  writeFileSync(
    join(slugDir, 'answers.yaml'),
    'plan_profile:\n  confidence: high\n  signals: []\n  artifacts:\n' +
      '    - path: ".archgen/demo/plans/demo.md"\n      decision: create\n      reason: "the plan"\n' +
      '    - path: ".archgen/demo/tasks.yaml"\n      decision: create\n      reason: "the task file"\n' +
      '    - path: ".archgen/demo/architecture.yaml"\n      decision: create\n      reason: "the structure"\n' +
      '    - path: ".archgen/demo/codebase-map.md"\n      decision: create\n      reason: "the survey"\n',
    'utf8',
  );
  // The SURVEY doc — the file the coverage half used to read as the plan.
  writeFileSync(join(slugDir, 'codebase-map.md'), '# Codebase map\n\nsurvey notes\n', 'utf8');
  return { root: projectRoot, slugDir, tasks: join(slugDir, 'tasks.yaml'), plans: join(slugDir, 'plans') };
}

async function verify(root, args) {
  const ctx = new Context({ projectRoot: root, anchorRoot: root, home: root });
  return guard(getToolSpec('archgen_plan').handler, ctx, { action: 'verify', ...args });
}

test('the CORRECT planDir approves the plan', async () => {
  const s = space();
  const env = await verify(s.root, { tasksYaml: s.tasks, planDir: s.plans });
  assert.equal(env.ok, true, env.error?.message);
  assert.equal(env.data.verdict, 'APPROVE', env.data.issues?.join(' | '));
  assert.equal(env.data.issues.length, 0, env.data.issues?.join(' | '));
});

test('THE BUG: the slug dir is REFUSED, not answered with false facts', async () => {
  const s = space();
  const env = await verify(s.root, { tasksYaml: s.tasks, planDir: s.slugDir });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_INPUT');
  assert.match(env.error.message, /plans dir must be the 'plans' directory beside the task file/);
  // The refusal names the call that would work.
  assert.match(env.error.details.nextAction, /planDir/);
  // AND it never claims the project is missing anything.
  const said = JSON.stringify(env);
  assert.doesNotMatch(said, /no architecture\.yaml/, 'the refusal must not assert a missing artifact');
  assert.doesNotMatch(said, /records no profile/, 'the refusal must not assert a missing profile');
  assert.doesNotMatch(said, /is not mentioned in any plan file/, 'the refusal must not assert missing coverage');
});

test('a plans dir from ANOTHER space is REFUSED', async () => {
  // The other space is INSIDE the same project — so the containment gate
  // passes and the SCOPE rule is what refuses it. (A space outside the
  // project is refused earlier, by containment.)
  const s = space();
  const other = space(s.root, 'other');
  const env = await verify(s.root, { tasksYaml: s.tasks, planDir: other.plans });
  assert.equal(env.ok, false);
  assert.equal(env.error.code, 'INVALID_INPUT');
  assert.match(env.error.message, /different artifact spaces/);
});

test('the coverage report reads the SAME space the audit reads', async () => {
  // The two halves used to read different directories. The scope is resolved
  // once now, so the coverage report and the floor agree by construction.
  const s = space();
  const ctx = new Context({ projectRoot: s.root, anchorRoot: s.root, home: s.root });
  const env = await guard(getToolSpec('archgen_plan').handler, ctx, {
    action: 'coverage',
    tasksYaml: s.tasks,
    planDir: s.plans,
  });
  assert.equal(env.ok, true, env.error?.message);
  // T-1 IS mentioned in the plan — so it is covered, not uncovered.
  const uncovered = env.data.uncovered?.items ?? [];
  assert.equal(uncovered.includes('T-1'), false, `T-1 was reported uncovered: ${JSON.stringify(uncovered)}`);
  assert.equal(env.data.profileRecorded, true, 'the profile was recorded and must be seen');
});

test('validate WITHOUT a planDir does not run the coverage check', async () => {
  // The scope always knows where the plans dir WOULD be — so the scope alone
  // must not turn the coverage check on. Without a planDir, `validate`
  // reports the task file's own rules and nothing else; with one, the
  // coverage of that space is checked too.
  const s = space();
  const ctx = new Context({ projectRoot: s.root, anchorRoot: s.root, home: s.root });
  const without = await guard(getToolSpec('archgen_plan').handler, ctx, {
    action: 'validate',
    tasksYaml: s.tasks,
  });
  assert.equal(without.ok, true, without.error?.message);
  assert.equal(without.data.valid, true, JSON.stringify(without.data.errors));
  assert.equal(
    (without.data.errors ?? []).some((e) => e.code === 'PLAN_TASK_COVERAGE'),
    false,
    'validate without a planDir must not report coverage',
  );

  const withDir = await guard(getToolSpec('archgen_plan').handler, ctx, {
    action: 'validate',
    tasksYaml: s.tasks,
    planDir: s.plans,
  });
  assert.equal(withDir.ok, true, withDir.error?.message);
  // The plan mentions T-1, so the coverage check runs and finds nothing.
  assert.equal(
    (withDir.data.errors ?? []).some((e) => e.code === 'PLAN_TASK_COVERAGE'),
    false,
    `the plan mentions T-1: ${JSON.stringify(withDir.data.errors)}`,
  );
});
