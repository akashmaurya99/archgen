// error-paths.test.mjs — every ERROR path is a typed error, never a crash.
//
// WHY THIS FILE EXISTS.
//
// The audits found a class of defect the happy-path matrix cannot see: a
// module that references an identifier it never imported. `archgen_refs`
// called `invalidInput(...)` without importing it — so every "missing
// topic" call died with `ReferenceError: invalidInput is not defined`, which
// the envelope reported as `INTERNAL`: a bug dressed as data.
//
// The same class lived in the brief renderer, which read `ctx` from a frame
// that did not have it and threw `ReferenceError: ctx is not defined` every
// time the floor's finding list was truncated.
//
// A tool's ERROR path is the part nobody tests and everybody hits. So every
// action is driven with the arguments that make it fail, and the answer must
// be a TYPED error — `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, … — never
// `INTERNAL`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';
import { buildSandbox } from '../sandbox.mjs';

createServer();

let sandbox;
let home;
let ctx;
let emptyCtx;

const HERMETIC_ENV = { PATH: '/nonexistent-archgen-test-path' };

before(() => {
  sandbox = buildSandbox();
  home = join(sandbox.root, '.fake-home');
  mkdirSync(home, { recursive: true });
  ctx = new Context({
    projectRoot: sandbox.root,
    anchorRoot: sandbox.root,
    home,
    env: HERMETIC_ENV,
  });
  // A project with NO plan: the calls that need a task file fail here, and
  // they fail TYPED. A call that omits the path used to fail in EVERY
  // project; it resolves the active artifact space now, so the meaningful
  // failure is the one in a project that has no plan at all.
  const emptyRoot = join(sandbox.root, 'empty-project');
  mkdirSync(emptyRoot, { recursive: true });
  emptyCtx = new Context({
    projectRoot: emptyRoot,
    anchorRoot: emptyRoot,
    home,
    env: HERMETIC_ENV,
  });
});

after(() => {
  sandbox?.cleanup();
});

/**
 * The calls that MUST fail — each one missing or naming something that does
 * not exist. Every one must produce a typed error, and none may produce
 * INTERNAL.
 */
function failingCalls() {
  const t = sandbox.tasksYaml;
  const p = sandbox.plansDir;
  return [
    // ── archgen_plan ────────────────────────────────────────────────────────
    ['archgen_plan', 'verify', { tasksYaml: t }],
    ['archgen_plan', 'coverage', { tasksYaml: t }],
    ['archgen_plan', 'coverage', { tasksYaml: t, planDir: p, taskId: 'NO-SUCH-TASK' }],
    ['archgen_plan', 'graph', { tasksYaml: t, node: 'NO-SUCH-TASK' }],
    ['archgen_plan', 'graph', { tasksYaml: t, module: 'x', format: 'mermaid' }],
    ['archgen_plan', 'graph', { tasksYaml: t, status: true }],
    ['archgen_plan', 'impact', { tasksYaml: t }],
    ['archgen_plan', 'impact', { tasksYaml: t, target: 'NO-SUCH-TARGET' }],
    ['archgen_plan', 'profile', {}],
    ['archgen_plan', 'scaffold', {}],
    ['archgen_plan', 'scaffold', { scope: 'LARGE', file: 'no-such-file.md' }],
    ['archgen_plan', 'brief', {}],
    ['archgen_plan', 'brief', { kind: 'investigate', tasksYaml: t, planDir: p }],

    // ── archgen_tasks ───────────────────────────────────────────────────────
    ['archgen_tasks', 'next', { tasksYaml: t, taskId: 'NO-SUCH-TASK' }],
    ['archgen_tasks', 'list', { tasksYaml: t, taskId: 'NO-SUCH-TASK' }],
    ['archgen_tasks', 'set_status', { tasksYaml: t, taskId: 'API' }],
    ['archgen_tasks', 'set_status', { tasksYaml: t, status: 'running' }],
    ['archgen_tasks', 'contract', { tasksYaml: t }],
    ['archgen_tasks', 'contract', { tasksYaml: t, taskId: 'NO-SUCH-TASK' }],

    // ── archgen_docs ────────────────────────────────────────────────────────
    ['archgen_docs', 'section', {}],
    ['archgen_docs', 'section', { section: 'no-such-section-anywhere' }],
    ['archgen_docs', 'refs', {}],
    ['archgen_docs', 'map', {}],
    ['archgen_docs', 'index', { file: 'no-such-file.md' }],

    // ── archgen_registry ────────────────────────────────────────────────────
    ['archgen_registry', 'update', { slug: 'demo' }],
    ['archgen_registry', 'update', { status: 'planned' }],
    ['archgen_registry', 'update', { slug: 'demo', status: 'not-a-status' }],

    // ── archgen_codegraph ───────────────────────────────────────────────────
    ['archgen_codegraph', 'ensure', { location: 'nowhere' }],

    // ── archgen_setup ───────────────────────────────────────────────────────
    ['archgen_setup', 'harness_info', { harness: 'no-such-harness' }],
    ['archgen_setup', 'harnesses', { harness: 'no-such-harness' }],
    ['archgen_setup', 'bootstrap', { location: 'nowhere' }],

    // ── archgen_skills ──────────────────────────────────────────────────────
    ['archgen_skills', 'load', {}],
    ['archgen_skills', 'load', { skillId: 'no-such-skill' }],
    ['archgen_skills', 'digest', { skillId: 'no-such-skill' }],
    ['archgen_skills', 'install', { skillId: 'no-such-skill', approve: true }],
    ['archgen_skills', 'install', { skillId: 'ui-baseline', harness: 'no-such-harness', approve: true }],

    // ── archgen_refs ────────────────────────────────────────────────────────
    ['archgen_refs', 'index', {}],
    ['archgen_refs', 'read', {}],
    ['archgen_refs', 'read', { topic: 'orchestration', section: 'no-such-section' }],
    ['archgen_refs', 'search', { topic: 'orchestration' }],
  ];
}

test('every failing call returns a TYPED error, never INTERNAL', async () => {
  const failures = [];
  for (const [tool, action, args] of failingCalls()) {
    const spec = getToolSpec(tool);
    if (!spec) {
      failures.push(`${tool} is not registered`);
      continue;
    }
    const envelope = await guard(spec.handler, ctx, { action, ...args });
    if (envelope.ok) {
      failures.push(`${tool}{action:'${action}'} with ${JSON.stringify(args)} unexpectedly SUCCEEDED`);
      continue;
    }
    const code = envelope.error?.code;
    if (!code || code === 'INTERNAL') {
      failures.push(`${tool}{action:'${action}'} with ${JSON.stringify(args)} -> ${code}: ${envelope.error?.message}`);
      continue;
    }
    // A typed error carries a message the agent can act on.
    if (!envelope.error?.message) {
      failures.push(`${tool}{action:'${action}'} -> ${code} with no message`);
    }
  }
  assert.deepEqual(failures, [], `calls that failed badly:\n  ${failures.join('\n  ')}`);
});

/**
 * The calls that need a task file and were given no path.
 *
 * They RESOLVE the active artifact space now, so in a project that HAS a
 * plan they succeed. In a project that has none they must fail — and fail
 * TYPED, never as a crash.
 */
const RESOLVING_CALLS = [
  ['archgen_plan', 'validate'],
  ['archgen_plan', 'graph'],
  ['archgen_tasks', 'next'],
  ['archgen_tasks', 'list'],
  ['archgen_tasks', 'snapshot'],
];

test('a call that omits the task file resolves the ACTIVE artifact space', async () => {
  // The task file is always `.archgen/<slug>/tasks.yaml` inside the project.
  // Demanding the path as an argument made the tool unreachable for a caller
  // that knew the project — and the worker contract's own completion call
  // failed on it.
  const spec = getToolSpec('archgen_tasks');
  const envelope = await guard(spec.handler, ctx, { action: 'list' });
  assert.ok(envelope.ok, `the list must resolve the plan: ${envelope.error?.message}`);
  assert.equal(envelope.data.file, sandbox.tasksYaml, 'the resolved file is reported');
  assert.ok(envelope.data.tasks.length > 0, 'the resolved plan carries its tasks');
});

test('a project with NO plan fails TYPED, never as a crash', async () => {
  const failures = [];
  for (const [tool, action] of RESOLVING_CALLS) {
    const spec = getToolSpec(tool);
    const envelope = await guard(spec.handler, emptyCtx, { action });
    if (envelope.ok) {
      failures.push(`${tool}{action:'${action}'} unexpectedly SUCCEEDED in a project with no plan`);
      continue;
    }
    if (!envelope.error?.code || envelope.error.code === 'INTERNAL') {
      failures.push(`${tool}{action:'${action}'} -> ${envelope.error?.code}: ${envelope.error?.message}`);
      continue;
    }
    if (!envelope.error?.message) {
      failures.push(`${tool}{action:'${action}'} -> ${envelope.error.code} with no message`);
    }
  }
  assert.deepEqual(failures, [], `calls that failed badly:\n  ${failures.join('\n  ')}`);
});

test('a rejected argument is rejected by the HANDLER, not only by the schema', async () => {
  // The schema is one layer; the CLI facade drives the handlers directly. A
  // contract enforced by only one of them is enforced half the time — and a
  // typo that silently returns an empty list is the worst possible answer.
  const spec = getToolSpec('archgen_tasks');
  const envelope = await guard(spec.handler, ctx, {
    action: 'list',
    tasksYaml: sandbox.tasksYaml,
    filterStatus: 'not-a-status',
  });
  assert.ok(!envelope.ok, 'a typo must be rejected, not answered with zero tasks');
  assert.notEqual(envelope.error?.code, 'INTERNAL', 'a rejected argument is a typed error');
});

test('a pagination offset past the end is an EMPTY WINDOW, not an error', async () => {
  const spec = getToolSpec('archgen_plan');
  const envelope = await guard(spec.handler, ctx, {
    action: 'verify',
    tasksYaml: sandbox.tasksYaml,
    planDir: sandbox.plansDir,
    offset: 999999,
  });
  assert.ok(envelope.ok, 'an offset past the end is not a failure');
  assert.equal(envelope.data.issues.length, 0, 'the window is empty');
  assert.equal(typeof envelope.data.issuesTotal, 'number', 'the total is still reported');
});
