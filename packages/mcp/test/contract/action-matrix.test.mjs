// action-matrix.test.mjs — EVERY action of EVERY tool, driven end to end.
//
// WHY THIS TEST EXISTS: two whole capabilities shipped DEAD and nobody
// noticed.
//
//   - `archgen_plan{action:'graph'}` threw `ReferenceError: opts is not
//     defined` on every call, for every project, forever. The cause was a
//     module-level function reading `opts` from its CALLER's frame. The
//     review brief has told the orchestrator to attach the graph since the
//     day it was written, so every plan review has been running without it.
//
//   - The worker contract shipped the literal text `<Domain> work: follow
//     …` — an unsubstituted placeholder — in every single worker prompt.
//
// Both are the same class of defect: a code path that is never exercised.
// The briefs have a `remainingPlaceholders` guard; the worker contract had
// none; the graph action had no test at all.
//
// So this is the gate: drive every action of every tool against a real
// project, and assert that
//
//   1. it SUCCEEDS (ok:true) — an action that errors is a dead action;
//   2. it never reports INTERNAL — an unexpected throw is a bug, not data;
//   3. the briefs and the worker contracts carry NO unsubstituted
//      placeholder — a worker told to read `<Domain>` reads nothing.
//
// The tools are driven through their real handlers (registered specs + the
// real `guard`), so the envelope, the error taxonomy and the payload are all
// the production ones. The context is hermetic: a temp project, a temp home,
// and a PATH with nothing on it, so no action can install software, write a
// user config or reach the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer, TOOL_NAMES } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';
import { remainingPlaceholders } from '../../src/core/docs/briefs.mjs';
import { buildSandbox } from '../sandbox.mjs';

// Registering the tools populates the spec registry the handlers live in.
createServer();

let sandbox;
let home;
let ctx;

/** A PATH with nothing on it: no action may find or run an external binary. */
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
});

after(() => {
  sandbox?.cleanup();
});

/**
 * The full action matrix.
 *
 * `expect` is the envelope state the action MUST reach. `ok` means the action
 * has to succeed — these are all valid calls against a valid project, so a
 * failure is a defect in the action, not a bad argument.
 */
function matrix() {
  const t = sandbox.tasksYaml;
  const p = sandbox.plansDir;
  const rows = [];

  // ── archgen_plan ────────────────────────────────────────────────────────
  rows.push(['archgen_plan', 'validate', { tasksYaml: t }]);
  rows.push(['archgen_plan', 'verify', { tasksYaml: t, planDir: p }]);
  rows.push(['archgen_plan', 'graph', { tasksYaml: t }]);
  rows.push(['archgen_plan', 'graph', { tasksYaml: t, format: 'mermaid' }]);
  rows.push(['archgen_plan', 'graph', { tasksYaml: t, format: 'mermaid', status: true }]);
  rows.push(['archgen_plan', 'graph', { tasksYaml: t, node: 'API' }]);
  rows.push(['archgen_plan', 'graph', { tasksYaml: t, module: 'src/features/api' }]);
  rows.push(['archgen_plan', 'impact', { tasksYaml: t, target: 'API' }]);
  rows.push(['archgen_plan', 'coverage', { tasksYaml: t, planDir: p }]);
  rows.push(['archgen_plan', 'profile', { intent: 'BROWNFIELD-FEATURE', signals: ['multi-module'], slug: 'demo' }]);
  rows.push(['archgen_plan', 'scaffold', { scope: 'LARGE' }]);
  rows.push(['archgen_plan', 'scaffold', { scope: 'SMALL', slug: 'demo' }]);
  for (const kind of ['verifier', 'review', 'survey', 'investigate']) {
    rows.push(['archgen_plan', 'brief', { kind, tasksYaml: t, topic: 'auth', round: 1 }]);
  }

  // ── archgen_tasks ───────────────────────────────────────────────────────
  rows.push(['archgen_tasks', 'next', { tasksYaml: t }]);
  rows.push(['archgen_tasks', 'list', { tasksYaml: t }]);
  rows.push(['archgen_tasks', 'list', { tasksYaml: t, filterStatus: 'pending' }]);
  rows.push(['archgen_tasks', 'contract', { tasksYaml: t, taskId: 'API' }]);
  rows.push(['archgen_tasks', 'snapshot', { tasksYaml: t }]);
  rows.push(['archgen_tasks', 'set_status', { tasksYaml: t, taskId: 'API', status: 'running' }]);

  // ── archgen_docs ────────────────────────────────────────────────────────
  rows.push(['archgen_docs', 'index', {}]);
  rows.push(['archgen_docs', 'digest', {}]);
  rows.push(['archgen_docs', 'validate', {}]);
  rows.push(['archgen_docs', 'section', { section: 'non-functional-requirements' }]);
  rows.push(['archgen_docs', 'section', { section: 'demo/docs/prd.md#non-functional-requirements' }]);
  rows.push(['archgen_docs', 'section', { section: 'demo/docs/prd.md' }]);
  rows.push(['archgen_docs', 'refs', { token: 'FR-NOTES-01' }]);
  rows.push(['archgen_docs', 'map', { token: 'FR-NOTES-01' }]);

  // ── archgen_registry ────────────────────────────────────────────────────
  rows.push(['archgen_registry', 'show', {}]);
  rows.push(['archgen_registry', 'update', { slug: 'demo', status: 'planned' }]);

  // ── archgen_codegraph (unapproved: a PLAN, never a write) ───────────────
  rows.push(['archgen_codegraph', 'status', {}]);
  rows.push(['archgen_codegraph', 'ensure', { approve: false }]);
  rows.push(['archgen_codegraph', 'wire', { approve: false }]);

  // ── archgen_setup (unapproved: a PLAN, never a write) ───────────────────
  rows.push(['archgen_setup', 'doctor', {}]);
  rows.push(['archgen_setup', 'harness_info', {}]);
  rows.push(['archgen_setup', 'harnesses', {}]);
  rows.push(['archgen_setup', 'bootstrap', { approve: false }]);
  rows.push(['archgen_setup', 'install_mcp', { approve: false }]);
  rows.push(['archgen_setup', 'uninstall_mcp', { approve: false }]);

  // ── archgen_skills (unapproved: a PLAN, never a write) ──────────────────
  rows.push(['archgen_skills', 'list', {}]);
  rows.push(['archgen_skills', 'installed', {}]);
  rows.push(['archgen_skills', 'match', { title: 'Build the dashboard UI', fileOwnership: ['src/features/web/**'] }]);
  rows.push(['archgen_skills', 'load', { skillId: 'ui-baseline' }]);
  rows.push(['archgen_skills', 'digest', { skillId: 'ui-baseline' }]);
  rows.push(['archgen_skills', 'install', { skillId: 'ui-baseline', approve: false }]);

  // ── archgen_refs ────────────────────────────────────────────────────────
  rows.push(['archgen_refs', 'list', {}]);
  rows.push(['archgen_refs', 'index', { topic: 'orchestration' }]);
  rows.push(['archgen_refs', 'read', { topic: 'orchestration' }]);
  rows.push(['archgen_refs', 'search', { topic: 'orchestration', token: 'APPROVE' }]);

  return rows;
}

test('every action of every tool succeeds against a real project', async () => {
  const failures = [];
  for (const [tool, action, args] of matrix()) {
    const spec = getToolSpec(tool);
    assert.ok(spec, `${tool} is not registered`);
    const envelope = await guard(spec.handler, ctx, { action, ...args });
    const label = `${tool}{action:'${action}'}`;
    if (!envelope.ok) {
      failures.push(`${label} -> ${envelope.error.code}: ${envelope.error.message}`);
      continue;
    }
    if (!envelope.meta || typeof envelope.meta.serverVersion !== 'string') {
      failures.push(`${label} -> the envelope carries no meta block`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);
});

test('no action ever reports INTERNAL', async () => {
  const internals = [];
  for (const [tool, action, args] of matrix()) {
    const spec = getToolSpec(tool);
    const envelope = await guard(spec.handler, ctx, { action, ...args });
    if (envelope.ok) continue;
    if (envelope.error.code === 'INTERNAL') {
      internals.push(`${tool}{action:'${action}'} -> ${envelope.error.message}`);
    }
  }
  assert.deepEqual(internals, [], `INTERNAL means an unexpected throw:\n${internals.join('\n')}`);
});

test('a brief carries no unsubstituted placeholder', async () => {
  for (const kind of ['verifier', 'review', 'survey', 'investigate']) {
    const spec = getToolSpec('archgen_plan');
    const envelope = await guard(
      spec.handler,
      ctx,
      { action: 'brief', kind, tasksYaml: sandbox.tasksYaml, topic: 'auth', round: 1 },
    );
    assert.ok(envelope.ok, `${kind}: ${envelope.error?.message}`);
    const left = remainingPlaceholders(envelope.data.brief);
    assert.deepEqual(left, [], `the ${kind} brief still has placeholders: ${left.join(', ')}`);
  }
});

test('a worker contract carries no unsubstituted placeholder', async () => {
  const spec = getToolSpec('archgen_tasks');
  const envelope = await guard(spec.handler, ctx, {
    action: 'contract',
    tasksYaml: sandbox.tasksYaml,
    taskId: 'API',
  });
  assert.ok(envelope.ok, envelope.error?.message);
  const left = remainingPlaceholders(envelope.data.prompt);
  assert.deepEqual(left, [], `the worker contract still has placeholders: ${left.join(', ')}`);
});

test('every tool in the catalog is reachable from the matrix', () => {
  const covered = new Set(matrix().map(([tool]) => tool));
  // archgen_help is keyed by `topic`, not `action` — it is checked separately.
  for (const name of TOOL_NAMES) {
    if (name === 'archgen_help') continue;
    assert.ok(covered.has(name), `${name} has no action in the matrix`);
  }
});

// ── fetching, not dumping ──────────────────────────────────────────────────
//
// The defect this pins: NO collection-shaped action had an item-level
// selector, so "I need one section" cost "the whole topic" — and the agent
// paid for it in context. The tool surface made dumping the cheaper option
// for the server and the more expensive one for the agent.
//
// The contract, in four parts:
//   1. every tool accepts `limit`/`offset` — the bound is the CALLER's;
//   2. a bounded answer says how many items exist and how to get the rest;
//   3. the expensive default is gone (a whole topic, a whole skill file);
//   4. every collection narrows to ONE item.

test('every tool accepts limit and offset', () => {
  const missing = [];
  for (const tool of TOOL_NAMES) {
    // archgen_help returns ONE fixed briefing per topic. Its payload does not
    // grow with the project, so there is nothing to bound — and truncating a
    // briefing would corrupt it.
    if (tool === 'archgen_help') continue;
    const shape = getToolSpec(tool).inputSchema.shape ?? {};
    for (const arg of ['limit', 'offset']) {
      if (!shape[arg]) missing.push(`${tool} has no ${arg}`);
    }
  }
  assert.deepEqual(missing, [], `a tool that cannot be bounded:\n  ${missing.join('\n  ')}`);
});

test('a bounded answer reports the count and the way to get the rest', async () => {
  const cases = [
    ['archgen_tasks', { action: 'list', tasksYaml: sandbox.tasksYaml }],
    ['archgen_refs', { action: 'index', topic: 'orchestration' }],
    ['archgen_skills', { action: 'list' }],
    ['archgen_setup', { action: 'harnesses' }],
    ['archgen_registry', { action: 'show' }],
  ];
  const failures = [];
  for (const [tool, args] of cases) {
    const envelope = await guard(getToolSpec(tool).handler, ctx, args);
    if (!envelope.ok) {
      failures.push(`${tool}{action:'${args.action}'} -> ${envelope.error.message}`);
      continue;
    }
    const meta = envelope.meta ?? {};
    if (typeof meta.total !== 'number') failures.push(`${tool}{action:'${args.action}'} -> meta.total missing`);
    if (typeof meta.returned !== 'number') failures.push(`${tool}{action:'${args.action}'} -> meta.returned missing`);
    if (!meta.available || typeof meta.available !== 'object') {
      failures.push(`${tool}{action:'${args.action}'} -> meta.available missing`);
    }
  }
  assert.deepEqual(failures, [], `a bounded answer that does not say what else exists:\n  ${failures.join('\n  ')}`);
});

test('the limit is the CALLER\'s: a smaller limit returns fewer items and names the next call', async () => {
  const envelope = await guard(getToolSpec('archgen_refs').handler, ctx, {
    action: 'index',
    topic: 'orchestration',
    limit: 2,
  });
  assert.ok(envelope.ok, envelope.error?.message);
  assert.equal(envelope.data.sections.length, 2, 'the limit must bound the answer');
  assert.equal(envelope.meta.total > 2, true, 'the total must report what exists');
  assert.match(envelope.meta.next, /archgen_refs/, 'meta.next must be the exact next call');
  assert.match(envelope.meta.next, /offset:2/, 'meta.next must carry the offset');
});

test('a whole reference topic is no longer the DEFAULT answer', async () => {
  const envelope = await guard(getToolSpec('archgen_refs').handler, ctx, { action: 'read', topic: 'orchestration' });
  assert.ok(envelope.ok, envelope.error?.message);
  assert.equal(envelope.data.text, undefined, 'no section named must not return the topic text');
  assert.ok(Array.isArray(envelope.data.sections), 'it must return the section index');
  // …and the whole topic is still reachable, deliberately.
  const whole = await guard(getToolSpec('archgen_refs').handler, ctx, {
    action: 'read',
    topic: 'orchestration',
    section: '*',
  });
  assert.ok(whole.ok, whole.error?.message);
  assert.ok(typeof whole.data.text === 'string' && whole.data.text.length > 0, "section:'*' must return the topic");
});

test('loading a skill never returns the whole file', async () => {
  const envelope = await guard(getToolSpec('archgen_skills').handler, ctx, {
    action: 'load',
    skillId: 'ui-baseline',
  });
  assert.ok(envelope.ok, envelope.error?.message);
  assert.equal(envelope.data.content, undefined, 'the raw file must not ride along with its own rules and index');
});

test('every collection narrows to ONE item', async () => {
  const cases = [
    ['archgen_tasks', { action: 'list', tasksYaml: sandbox.tasksYaml, taskId: 'API' }, (d) => d.tasks.length === 1],
    ['archgen_tasks', { action: 'next', tasksYaml: sandbox.tasksYaml, taskId: 'API' }, (d) => Array.isArray(d.wave) && d.waveIndex >= 1],
    ['archgen_plan', { action: 'coverage', tasksYaml: sandbox.tasksYaml, planDir: sandbox.plansDir, taskId: 'API' }, (d) => d.taskId === 'API'],
    ['archgen_skills', { action: 'list', skillId: 'ui-baseline' }, (d) => d.skills.length === 1],
  ];
  const failures = [];
  for (const [tool, args, check] of cases) {
    const envelope = await guard(getToolSpec(tool).handler, ctx, args);
    if (!envelope.ok) {
      failures.push(`${tool}{action:'${args.action}'} -> ${envelope.error.message}`);
      continue;
    }
    if (!check(envelope.data)) {
      failures.push(`${tool}{action:'${args.action}'} -> the selector did not narrow the answer`);
    }
  }
  // The harness selector narrows to one DETECTED harness — which one exists
  // depends on the project, so the test takes the first it finds.
  const harnesses = await guard(getToolSpec('archgen_setup').handler, ctx, { action: 'harnesses' });
  if (harnesses.ok && (harnesses.data.detected ?? []).length) {
    const id = harnesses.data.detected[0].id;
    const one = await guard(getToolSpec('archgen_setup').handler, ctx, { action: 'harnesses', harness: id });
    if (!one.ok) failures.push(`archgen_setup{action:'harnesses',harness:'${id}'} -> ${one.error.message}`);
    else if (one.data.detected.length !== 1) failures.push(`archgen_setup{action:'harnesses'} -> the harness selector did not narrow`);
  }
  assert.deepEqual(failures, [], `a collection that cannot be narrowed to one item:\n  ${failures.join('\n  ')}`);
});

test('every action in the matrix belongs to a real action enum', async () => {
  // A typo in the matrix would silently stop testing an action.
  const seen = new Set();
  for (const [tool, action] of matrix()) {
    const spec = getToolSpec(tool);
    const shape = spec.inputSchema.shape ?? spec.inputSchema?._def?.shape?.();
    const actionSchema = shape?.action;
    const enumValues = actionSchema?.options ?? actionSchema?._def?.entries;
    if (!enumValues) continue;
    const values = Array.isArray(enumValues) ? enumValues : Object.keys(enumValues);
    assert.ok(values.includes(action), `${tool} has no action '${action}'`);
    seen.add(`${tool}.${action}`);
  }
  assert.ok(seen.size > 0, 'the matrix must not be empty');
});

test('the matrix covers EVERY action the catalog exposes', () => {
  // THE SELF-MAINTAINING GATE. A floor ("at least N actions") only proves the
  // matrix is big; it does not prove it is COMPLETE — and a missing action is
  // exactly the defect this file exists to catch. The catalog is the source
  // of truth: every action a tool declares must appear in the matrix, so a
  // NEW action cannot ship without a test that drives it, and a REMOVED
  // action cannot leave a stale row behind.
  //
  // (This replaces a hard-coded floor of 40, which silently stopped
  // discriminating once the catalog changed — it let `archgen_skills{digest}`
  // go untested for the whole life of the matrix.)
  const covered = new Set(matrix().map(([tool, action]) => `${tool}.${action}`));
  const missing = [];
  for (const name of TOOL_NAMES) {
    const spec = getToolSpec(name);
    if (!spec) continue;
    const shape = spec.inputSchema.shape ?? spec.inputSchema?._def?.shape?.();
    const actionSchema = shape?.action;
    const enumValues = actionSchema?.options ?? actionSchema?._def?.entries;
    // archgen_help is keyed by `topic`, not `action` — it is checked separately.
    if (!enumValues) continue;
    const values = Array.isArray(enumValues) ? enumValues : Object.keys(enumValues);
    for (const action of values) {
      if (!covered.has(`${name}.${action}`)) missing.push(`${name}.${action}`);
    }
  }
  assert.deepEqual(missing, [], `these actions are not driven by the matrix: ${missing.join(', ')}`);
});
