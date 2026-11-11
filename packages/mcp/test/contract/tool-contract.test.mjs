// tool-contract.test.mjs — the promises the tool CATALOG makes, checked.
//
// WHY THIS FILE EXISTS.
//
// The final verification pass found seven defects that all had the same
// shape: the tool's answer and its `meta` disagreed, or the published
// continuation pointed at the wrong thing.
//
//   - coverage's `meta.next` always named the DEFAULT collection, so an
//     agent that followed it while asking for the uncovered list got the
//     task list instead;
//   - coverage's `meta.total`/`meta.returned` described the whole set while
//     the answer carried one collection — `returned` could exceed `total`;
//   - impact's `meta.total` excluded the artifacts its payload carried;
//   - scaffold{file} served an OMIT-decided artifact as "write this" with
//     `skeleton: null`;
//   - bootstrap's outer payload had a key on one path and not the other.
//
// Every one of these is a promise the catalog makes to the agent. This file
// checks them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';
import { buildSandbox } from '../helpers/sandbox.mjs';

createServer();

let sandbox;
let ctx;

before(() => {
  sandbox = buildSandbox();
  const home = join(sandbox.root, '.fake-home');
  mkdirSync(home, { recursive: true });
  ctx = new Context({
    projectRoot: sandbox.root,
    anchorRoot: sandbox.root,
    home,
    env: { PATH: '/nonexistent-archgen-test-path' },
  });
});

after(() => {
  sandbox?.cleanup();
});

/** Call a tool and return the envelope. */
async function call(tool, args) {
  return guard(getToolSpec(tool).handler, ctx, args);
}

test('coverage\'s continuation names the collection the caller ASKED for', async () => {
  // A plan whose text mentions only ONE of its tasks: the uncovered list is
  // real and truncated, so the continuation has something to continue.
  const root = mkdtempSync(join(tmpdir(), 'archgen-cov-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'plans'), { recursive: true });
    const tasks = Array.from(
      { length: 10 },
      (_, i) =>
        `  - id: T${i + 1}\n    title: module ${i + 1}\n    depends_on: []\n    file_ownership: ["src/m${i + 1}/**"]\n    acceptance:\n      - "the module ${i + 1} behaviour holds"`,
    ).join('\n');
    writeFileSync(join(slugDir, 'tasks.yaml'), `tasks:\n${tasks}\n`, 'utf8');
    writeFileSync(join(slugDir, 'plans', 'demo.md'), '# Plan\n\nT1 does it.\n', 'utf8');
    const local = new Context({
      projectRoot: root,
      anchorRoot: root,
      home: join(root, '.home'),
      env: { PATH: '/nonexistent-archgen-test-path' },
    });

    const envelope = await guard(getToolSpec('archgen_plan').handler, local, {
      action: 'coverage',
      tasksYaml: join(slugDir, 'tasks.yaml'),
      planDir: join(slugDir, 'plans'),
      collection: 'uncovered',
      limit: 1,
    });
    assert.ok(envelope.ok, envelope.error?.message);
    assert.ok(envelope.meta?.next, 'the answer must name a continuation');
    assert.match(
      envelope.meta.next,
      /collection:'uncovered'/,
      `the continuation must continue the collection that was asked for: ${envelope.meta.next}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('coverage\'s meta.total and meta.returned describe the SELECTED collection', async () => {
  const envelope = await call('archgen_plan', {
    action: 'coverage',
    tasksYaml: sandbox.tasksYaml,
    planDir: sandbox.plansDir,
    collection: 'uncovered',
    limit: 1,
  });
  assert.ok(envelope.ok, envelope.error?.message);
  const meta = envelope.meta;
  assert.equal(meta.total, envelope.data.uncovered.total, 'the total must be the selected collection\'s');
  assert.equal(meta.returned, envelope.data.uncovered.items.length, 'the returned count must match the answer');
  assert.ok(
    meta.returned <= meta.total,
    `returned (${meta.returned}) must never exceed total (${meta.total})`,
  );
});

test('impact\'s meta.total covers every list its payload carries', async () => {
  const envelope = await call('archgen_plan', {
    action: 'impact',
    tasksYaml: sandbox.tasksYaml,
    target: 'API',
  });
  assert.ok(envelope.ok, envelope.error?.message);
  const d = envelope.data;
  assert.equal(
    envelope.meta.total,
    d.directTotal + d.transitiveTotal + d.artifactsTotal,
    'the total must cover every list the payload carries',
  );
  assert.ok(
    envelope.meta.returned <= envelope.meta.total,
    `returned (${envelope.meta.returned}) must never exceed total (${envelope.meta.total})`,
  );
});

test('scaffold{file} refuses an artifact the profile marks omit', async () => {
  // `codebase-map.md` is a BROWNFIELD-only artifact: a LARGE greenfield
  // profile marks it omit. Serving it as "write this" (with no skeleton)
  // would have the agent create a file the profile forbids.
  const envelope = await call('archgen_plan', {
    action: 'scaffold',
    scope: 'LARGE',
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'product-facing'],
    slug: 'demo',
    file: '.archgen/demo/codebase-map.md',
  });
  assert.ok(!envelope.ok, 'an omit-decided artifact must not be served');
  assert.equal(envelope.error?.code, 'INVALID_INPUT');
  assert.match(envelope.error?.message ?? '', /omit/, 'the error must say why');
});

test('scaffold{file} serves a create-decided artifact, and only that file', async () => {
  const envelope = await call('archgen_plan', {
    action: 'scaffold',
    scope: 'LARGE',
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'product-facing'],
    slug: 'demo',
    file: '.archgen/demo/tasks.yaml',
  });
  assert.ok(envelope.ok, envelope.error?.message);
  assert.equal(envelope.data.one.path, '.archgen/demo/tasks.yaml');
  assert.ok(envelope.data.skeleton, 'the skeleton must be present');
  assert.equal(envelope.data.one.skeletonKey, 'tasks.yaml');
  assert.deepEqual(envelope.data.writeThese, ['.archgen/demo/tasks.yaml']);
});

test('bootstrap and archgen_codegraph answer with the SAME codegraph key set', async () => {
  const setup = await call('archgen_setup', { action: 'bootstrap', location: 'project', approve: false });
  const cg = await call('archgen_codegraph', { action: 'status' });
  assert.ok(setup.ok, setup.error?.message);
  assert.ok(cg.ok, cg.error?.message);
  const setupKeys = Object.keys(setup.data.codegraph ?? {}).sort();
  const cgKeys = Object.keys(cg.data ?? {}).sort();
  // The bootstrap's report is SHAPED by the same function, so the keys are
  // the same set — one shape per fact.
  assert.deepEqual(
    setupKeys,
    cgKeys,
    `the codegraph report must have ONE shape:\n  setup: ${setupKeys.join(',')}\n  codegraph: ${cgKeys.join(',')}`,
  );
});

test('coverage{taskId} returns findings about THAT task only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-tid-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'plans'), { recursive: true });
    const tasks = Array.from(
      { length: 10 },
      (_, i) =>
        `  - id: T${i + 1}\n    title: module ${i + 1}\n    depends_on: []\n    file_ownership: ["src/m${i + 1}/**"]\n    acceptance:\n      - "the module ${i + 1} behaviour holds"`,
    ).join('\n');
    writeFileSync(join(slugDir, 'tasks.yaml'), `tasks:\n${tasks}\n`, 'utf8');
    // The plan mentions only T1 — so every other task is uncovered, and the
    // findings name them one by one.
    writeFileSync(join(slugDir, 'plans', 'demo.md'), '# Plan\n\nT1 does it.\n', 'utf8');
    const local = new Context({
      projectRoot: root,
      anchorRoot: root,
      home: join(root, '.home'),
      env: { PATH: '/nonexistent-archgen-test-path' },
    });
    const envelope = await guard(getToolSpec('archgen_plan').handler, local, {
      action: 'coverage',
      tasksYaml: join(slugDir, 'tasks.yaml'),
      planDir: join(slugDir, 'plans'),
      taskId: 'T1',
    });
    assert.ok(envelope.ok, envelope.error?.message);
    for (const finding of envelope.data.findings ?? []) {
      // A substring test matched T10's finding when the caller asked about
      // T1 — the answer was about a task nobody asked about.
      assert.ok(
        /(?<![A-Za-z0-9_.-])T1(?![A-Za-z0-9_.-])/.test(finding),
        `the finding must be about T1 only: ${finding}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tasks{next, taskId} does not claim a DONE task does not exist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-done-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      join(slugDir, 'tasks.yaml'),
      [
        'tasks:',
        '  - id: A',
        '    title: already finished',
        '    depends_on: []',
        '    status: done',
        '    file_ownership: ["src/a/**"]',
        '    acceptance:',
        '      - "it works"',
        '  - id: B',
        '    title: still to do',
        '    depends_on: []',
        '    file_ownership: ["src/b/**"]',
        '    acceptance:',
        '      - "it works"',
        '',
      ].join('\n'),
      'utf8',
    );
    const local = new Context({
      projectRoot: root,
      anchorRoot: root,
      home: join(root, '.home'),
      env: { PATH: '/nonexistent-archgen-test-path' },
    });
    const envelope = await guard(getToolSpec('archgen_tasks').handler, local, {
      action: 'next',
      tasksYaml: join(slugDir, 'tasks.yaml'),
      taskId: 'A',
    });
    assert.ok(envelope.ok, 'a done task exists — the tool must not claim otherwise');
    assert.equal(envelope.data.taskId, 'A');
    assert.match(envelope.data.note ?? '', /done/, 'the answer must say the task is done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('harness_info answers with ONE shape, named or not', async () => {
  const withHarness = await call('archgen_setup', { action: 'harness_info', harness: 'claude' });
  const without = await call('archgen_setup', { action: 'harness_info' });
  assert.ok(withHarness.ok, withHarness.error?.message);
  assert.ok(without.ok, without.error?.message);
  const a = Object.keys(withHarness.data).sort();
  const b = Object.keys(without.data).sort();
  assert.deepEqual(a, b, `harness_info must have ONE shape:\n  named: ${a.join(',')}\n  detected: ${b.join(',')}`);
  // The named harness's capabilities ride INSIDE the envelope.
  assert.ok(withHarness.data.capabilities, 'the named harness must carry its capabilities');
  assert.equal(withHarness.data.harness, 'claude');
});

test('a collection the action does not have is a typed error — in docs too', async () => {
  const envelope = await call('archgen_docs', { action: 'validate', collection: 'issues' });
  assert.ok(!envelope.ok, 'a mismatched collection must be refused');
  assert.equal(envelope.error?.code, 'INVALID_INPUT');
  assert.match(envelope.error?.message ?? '', /not a collection of 'validate'/);
});

test('profile accepts a COUNT or the LIST itself', async () => {
  // The argument is named `modules`/`tasks`; an agent that has already
  // enumerated them should not have to reduce them to a number first.
  const withNumbers = await call('archgen_plan', {
    action: 'profile',
    intent: 'GREENFIELD-SYSTEM',
    signals: ['multi-module'],
    modules: 4,
    tasks: 15,
    slug: 'demo',
  });
  const withLists = await call('archgen_plan', {
    action: 'profile',
    intent: 'GREENFIELD-SYSTEM',
    signals: ['multi-module'],
    modules: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    tasks: ['one', 'two', 'three'],
    slug: 'demo',
  });
  assert.ok(withNumbers.ok, withNumbers.error?.message);
  assert.ok(withLists.ok, withLists.error?.message);
  assert.equal(
    withLists.data.scopeClass,
    withNumbers.data.scopeClass,
    'the same evidence must score the same way',
  );
  // The LIST form scores from its LENGTH: 4 modules and 3 tasks.
  const listScore = withLists.data.score;
  const numberScore = (
    await call('archgen_plan', {
      action: 'profile',
      intent: 'GREENFIELD-SYSTEM',
      signals: ['multi-module'],
      modules: 4,
      tasks: 3,
      slug: 'demo',
    })
  ).data.score;
  assert.equal(listScore, numberScore, 'the list length must be the count');
});

test('the doctor reports the actions the RUNNING server offers', async () => {
  const envelope = await call('archgen_setup', { action: 'doctor' });
  assert.ok(envelope.ok, envelope.error?.message);
  const inventory = envelope.data.serverActions;
  assert.ok(inventory && typeof inventory === 'object', 'the doctor must report the action inventory');
  assert.ok(
    inventory.archgen_plan?.includes('profile'),
    `the running server offers profile: ${JSON.stringify(inventory.archgen_plan)}`,
  );
  assert.ok(
    inventory.archgen_plan?.includes('scaffold'),
    'the running server offers scaffold',
  );
  assert.ok(envelope.data.serverActionsHint, 'the inventory must say what to do with it');
});

test('a continuation keeps the scope it was called with', async () => {
  // The harnesses cursor dropped `location`, so the next page listed the
  // global config path the caller had excluded — the very bug the filter
  // exists to prevent.
  const envelope = await call('archgen_setup', { action: 'harnesses', location: 'project', limit: 1 });
  assert.ok(envelope.ok, envelope.error?.message);
  if (envelope.meta?.next) {
    assert.match(
      envelope.meta.next,
      /location:'project'/,
      `the continuation must keep the location scope: ${envelope.meta.next}`,
    );
  }
});

test('the codegraph answer reports the WHOLE detected list, not the page', async () => {
  const envelope = await call('archgen_codegraph', { action: 'status', limit: 1 });
  assert.ok(envelope.ok, envelope.error?.message);
  const meta = envelope.meta ?? {};
  // The total describes the whole list, and the continuation reaches it.
  assert.ok(
    meta.total >= (envelope.data.detected?.length ?? 0),
    'the total must describe the whole list',
  );
  if ((envelope.data.detected?.length ?? 0) < meta.total) {
    assert.ok(meta.next, 'a truncated list must name its continuation');
  }
});

test('verify\'s meta describes the collection that was ASKED for', async () => {
  const warnings = await call('archgen_plan', {
    action: 'verify',
    tasksYaml: sandbox.tasksYaml,
    planDir: sandbox.plansDir,
    collection: 'warnings',
  });
  assert.ok(warnings.ok, warnings.error?.message);
  assert.equal(
    warnings.meta.total,
    warnings.data.warningsTotal,
    'the total must be the warnings total',
  );
  assert.equal(
    warnings.meta.returned,
    warnings.data.warnings.length,
    'the returned count must be the warnings shown',
  );
});

test('a collection an action does not have is a typed error', async () => {
  for (const [tool, args] of [
    ['archgen_plan', { action: 'graph', tasksYaml: sandbox.tasksYaml, collection: 'issues' }],
    ['archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', collection: 'issues' }],
    ['archgen_docs', { action: 'index', collection: 'broken' }],
    ['archgen_docs', { action: 'section', section: 'x', collection: 'broken' }],
  ]) {
    const envelope = await call(tool, args);
    assert.ok(!envelope.ok, `${tool}{${JSON.stringify(args)}} must be refused`);
    assert.equal(envelope.error?.code, 'INVALID_INPUT');
  }
});

test('the scaffold\'s one-file cursor keeps the profile inputs', async () => {
  const envelope = await call('archgen_plan', {
    action: 'scaffold',
    scope: 'MEDIUM',
    intent: 'GREENFIELD-SYSTEM',
    signals: ['production', 'product-facing', 'multi-module'],
    slug: 'demo',
  });
  assert.ok(envelope.ok, envelope.error?.message);
  assert.ok(envelope.meta?.more, 'the scaffold must name its one-file cursor');
  // The cursor must re-enter PROFILE mode with the same inputs — otherwise it
  // serves the class candidate set and refuses the profile's own artifacts.
  assert.match(envelope.meta.more, /intent:'GREENFIELD-SYSTEM'/);
  assert.match(envelope.meta.more, /signals:\[/);
  assert.match(
    envelope.meta.more,
    new RegExp(`scope:'${envelope.data.scopeClass}'`),
    `the cursor must name the class the scaffold SERVED: ${envelope.meta.more}`,
  );
});

test('the outer bootstrap payload has the same keys on both paths', async () => {
  const setup = await call('archgen_setup', { action: 'bootstrap', location: 'project', approve: false });
  assert.ok(setup.ok, setup.error?.message);
  // `alreadyConfigured` must exist whether or not the fast path was taken.
  assert.ok(
    Object.prototype.hasOwnProperty.call(setup.data, 'alreadyConfigured'),
    'the outer payload must always carry alreadyConfigured',
  );
});
