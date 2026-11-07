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
import { remainingPlaceholders } from '../../src/core/briefs.mjs';
import { buildSandbox } from '../helpers/sandbox.mjs';

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

  // ── archgen_ui (best-effort: unavailable is not an error) ───────────────
  rows.push(['archgen_ui', 'status', {}]);
  rows.push(['archgen_ui', 'select_feature', { slug: 'demo', timeoutMs: 1 }]);
  rows.push(['archgen_ui', 'reveal_task', { taskId: 'API', timeoutMs: 1 }]);
  rows.push(['archgen_ui', 'open_doc', { path: 'demo/docs/prd.md', timeoutMs: 1 }]);
  rows.push(['archgen_ui', 'focus', { view: 'board', timeoutMs: 1 }]);
  rows.push(['archgen_ui', 'refresh', { timeoutMs: 1 }]);

  // ── archgen_skills (unapproved: a PLAN, never a write) ──────────────────
  rows.push(['archgen_skills', 'list', {}]);
  rows.push(['archgen_skills', 'installed', {}]);
  rows.push(['archgen_skills', 'match', { title: 'Build the dashboard UI', fileOwnership: ['src/features/web/**'] }]);
  rows.push(['archgen_skills', 'load', { skillId: 'ui-baseline' }]);
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
  assert.ok(seen.size >= 40, `the matrix only covered ${seen.size} actions`);
});
