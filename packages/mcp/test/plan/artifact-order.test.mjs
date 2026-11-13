// artifact-order.test.mjs — the write order the artifacts must be written in.
//
// WHY THIS FILE EXISTS.
//
// The ladder's rule array WAS the write order: the profile's artifacts are
// built by iterating those rules, and the scaffold served the create set in
// that order. So the tool published an order that put `tasks.yaml` FIRST —
// before the PRD whose `FR-<MODULE>-nn` ids its acceptance lines cite, and
// before the `architecture.yaml` whose `owns[]` its ownership globs mirror.
//
// Writing a dependent before its dependency is not a style preference: it is
// a content inconsistency the moment the file is written. So the edges are
// data now, the order is derived from them, and this file pins the result.
//
// The order is not invented here. Every edge names the floor code that
// PROVES the join it describes, or is marked guidance-only — an edge with
// neither is a claim nobody can check, and this file fails on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAsset } from '../../src/context.mjs';
import { buildWriteOrder } from '../../src/core/plan/artifact-order.mjs';
import { buildPlanProfile } from '../../src/core/plan/plan-profile.mjs';
import { buildScaffold } from '../../src/core/plan/scaffold.mjs';
import { KNOWN_CODES } from '../../src/core/protocol/codes.mjs';

const ladder = loadAsset('depth-ladder.json');
const rules = ladder.profile.artifactRules;

/** The rule that speaks for a family. */
const ruleOf = (family) => rules.find((r) => r.pattern === family);

/**
 * THE PROVING CODES — one per edge.
 *
 * `null` means the edge is GUIDANCE-ONLY: the floor cannot prove the join
 * (the content of one artifact becomes the content of another, with no
 * machine-readable link between them), so the order is the only thing that
 * keeps them consistent.
 *
 * Every code here must be a code the floor can actually report.
 */
const PROVING_CODES = {
  'answers.yaml|codebase-map.md': null,
  'docs/prd.md|answers.yaml': null,
  'architecture.yaml|answers.yaml': null,
  'architecture.yaml|codebase-map.md': null,
  'architecture.yaml|docs/prd.md': null,
  'decisions/*.md|architecture.yaml': 'DECISION_MISSING',
  'docs/*.md|architecture.yaml': null,
  'docs/mermaid-snippets.md|architecture.yaml': null,
  'tasks.yaml|docs/prd.md': 'REQ_UNKNOWN',
  'tasks.yaml|architecture.yaml': 'PATH_UNOWNED',
  'tasks.yaml|answers.yaml': 'PROFILE_NOT_RECORDED',
  'tasks.yaml|codebase-map.md': null,
  'tasks.yaml|decisions/*.md': null,
  'plans/*.md|tasks.yaml': 'PLAN_TASK_COVERAGE',
  'plans/*.md|docs/*.md': null,
};

test('the ladder declares one edge per dependency, and every edge is accounted for', () => {
  const seen = new Set();
  for (const rule of rules) {
    for (const dep of rule.dependsOn ?? []) {
      const key = `${rule.pattern}|${dep.family}`;
      seen.add(key);
      assert.ok(
        Object.prototype.hasOwnProperty.call(PROVING_CODES, key),
        `the edge ${key} has no proving code and is not marked guidance-only`,
      );
      assert.ok(ruleOf(dep.family), `the edge ${key} names a family no rule claims`);
    }
  }
  // An edge that vanished must be deleted from the table in the same commit.
  for (const key of Object.keys(PROVING_CODES)) {
    assert.ok(seen.has(key), `the proving table names ${key}, which no rule declares`);
  }
});

test('every proving code is one the floor can actually report', () => {
  for (const [key, code] of Object.entries(PROVING_CODES)) {
    if (!code) continue;
    assert.ok(KNOWN_CODES.has(code), `${key} is proven by ${code}, which the floor cannot report`);
  }
});

test('the ladder array IS the write order — every dependency comes first', () => {
  // The array order and the declared edges are one source of truth: if a
  // rule moves in the array, its edges must still point backwards.
  rules.forEach((rule, i) => {
    for (const dep of rule.dependsOn ?? []) {
      const j = rules.findIndex((r) => r.pattern === dep.family);
      assert.ok(j >= 0, `${rule.pattern} depends on ${dep.family}, which is not a rule`);
      assert.ok(j < i, `${rule.pattern} (index ${i}) depends on ${dep.family} (index ${j}), which comes later`);
    }
  });
});

test('the order is the ladder chain, restricted to the create set', () => {
  const profile = buildPlanProfile(ladder, {
    intent: 'GREENFIELD-SYSTEM',
    signals: ['product-facing', 'production', 'multi-module'],
    modules: 4,
    tasks: 20,
    slug: 'demo',
  });
  const order = buildWriteOrder(profile.artifacts, rules);
  assert.deepEqual(
    order.order.map((p) => p.replace('.archgen/demo/', '')),
    ['answers.yaml', 'docs/prd.md', 'architecture.yaml', 'docs/<module>.md', 'docs/mermaid-snippets.md', 'tasks.yaml', 'plans/demo.md'],
  );
});

test('the create set is served in the order, not in the rule array accident', () => {
  // The regression this file exists for: the served order used to start with
  // tasks.yaml — before the PRD its acceptance lines cite.
  const built = buildScaffold(ladder, 'LARGE', {
    slug: 'demo',
    intent: 'GREENFIELD-SYSTEM',
    signals: ['product-facing', 'production', 'multi-module'],
    modules: 4,
    tasks: 20,
  });
  assert.equal(built.writeThese[0], '.archgen/demo/answers.yaml');
  assert.ok(
    built.writeThese.indexOf('.archgen/demo/tasks.yaml') > built.writeThese.indexOf('.archgen/demo/docs/prd.md'),
    'the task file must come after the PRD whose FR ids it cites',
  );
  assert.ok(
    built.writeThese.indexOf('.archgen/demo/tasks.yaml') > built.writeThese.indexOf('.archgen/demo/architecture.yaml'),
    'the task file must come after the architecture whose owns[] it mirrors',
  );
  assert.ok(
    built.writeThese.indexOf('.archgen/demo/plans/demo.md') > built.writeThese.indexOf('.archgen/demo/tasks.yaml'),
    'the plan must come after the task file whose ids it cites',
  );
});

test('a SMALL brownfield plan writes the survey first', () => {
  const built = buildScaffold(ladder, 'SMALL', {
    slug: 'demo',
    intent: 'BROWNFIELD-CHANGE',
    signals: [],
  });
  assert.deepEqual(
    built.writeThese.map((p) => p.replace('.archgen/demo/', '')),
    ['codebase-map.md', 'tasks.yaml', 'plans/demo.md'],
  );
});

test('an omitted dependency dissolves its edge', () => {
  // SMALL has no answers.yaml, so nothing waits for it.
  const profile = buildPlanProfile(ladder, { intent: 'BROWNFIELD-CHANGE', signals: [], slug: 'demo' });
  const order = buildWriteOrder(profile.artifacts, rules);
  const tasks = order.steps.find((s) => s.path.endsWith('/tasks.yaml'));
  const answers = tasks.dependsOn.find((d) => d.family === 'answers.yaml');
  assert.equal(answers.state, 'omitted');
  const prd = tasks.dependsOn.find((d) => d.family === 'docs/prd.md');
  assert.equal(prd.state, 'omitted');
});

test('a reused dependency is external — it never blocks', () => {
  const profile = buildPlanProfile(ladder, {
    intent: 'GREENFIELD-SYSTEM',
    signals: ['product-facing', 'production', 'existing-prd'],
    slug: 'demo',
  });
  const prd = profile.artifacts.find((a) => a.pattern === 'docs/prd.md');
  assert.equal(prd.decision, 'reuse');
  const order = buildWriteOrder(profile.artifacts, rules);
  const tasks = order.steps.find((s) => s.path.endsWith('/tasks.yaml'));
  const dep = tasks.dependsOn.find((d) => d.family === 'docs/prd.md');
  assert.equal(dep.state, 'host', 'a reused dependency is satisfied by the host document');
  assert.ok(!order.steps.some((s) => s.path.endsWith('/docs/prd.md')), 'a reused artifact is not written');
});

test('every step names the fact it must carry forward', () => {
  const profile = buildPlanProfile(ladder, {
    intent: 'GREENFIELD-SYSTEM',
    signals: ['product-facing', 'production', 'multi-module'],
    slug: 'demo',
  });
  const order = buildWriteOrder(profile.artifacts, rules);
  for (const step of order.steps) {
    for (const dep of step.dependsOn) {
      assert.ok(dep.carries && dep.carries.length > 10, `${step.path} -> ${dep.family} names no fact to carry forward`);
    }
  }
});

test('the order is deterministic', () => {
  const input = {
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'multi-module'],
    slug: 'demo',
  };
  const a = buildWriteOrder(buildPlanProfile(ladder, input).artifacts, rules);
  const b = buildWriteOrder(buildPlanProfile(ladder, input).artifacts, rules);
  assert.deepEqual(a.order, b.order);
});

test('a cycle in the declared edges is a typed CYCLE', () => {
  const cyclic = [
    { path: '.archgen/demo/a.yaml', pattern: 'a.yaml', decision: 'create', dependsOn: [{ family: 'b.yaml', hard: true }] },
    { path: '.archgen/demo/b.yaml', pattern: 'b.yaml', decision: 'create', dependsOn: [{ family: 'a.yaml', hard: true }] },
  ];
  const fakeRules = [
    { path: '.archgen/demo/a.yaml', pattern: 'a.yaml', dependsOn: [{ family: 'b.yaml', hard: true }] },
    { path: '.archgen/demo/b.yaml', pattern: 'b.yaml', dependsOn: [{ family: 'a.yaml', hard: true }] },
  ];
  assert.throws(() => buildWriteOrder(cyclic, fakeRules), (e) => e.code === 'CYCLE');
});

test('a dependency that names no rule is a typed INVALID_INPUT', () => {
  const broken = [{ path: '.archgen/demo/a.yaml', pattern: 'a.yaml', decision: 'create' }];
  const fakeRules = [{ path: '.archgen/demo/a.yaml', pattern: 'a.yaml', dependsOn: [{ family: 'nope.md', hard: true }] }];
  assert.throws(() => buildWriteOrder(broken, fakeRules), (e) => e.code === 'INVALID_INPUT');
});
