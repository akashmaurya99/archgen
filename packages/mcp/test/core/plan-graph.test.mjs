// plan-graph.test.mjs — the dependency-graph lens.
//
// WHY THIS FILE EXISTS: `archgen_plan{action:'graph'}` was DEAD. Every
// call threw `ReferenceError: opts is not defined` — a module-level function
// reading a variable from its CALLER's frame — and the error surfaced as
// `INTERNAL: opts is not defined`. It failed for every project, in every
// format, with or without status, and nobody noticed because there was no
// test for it at all.
//
// The review brief has told the orchestrator to attach the graph since the
// day it was written, so every plan review had been running without it.
//
// This file is the regression gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planGraph, resolvePlanScope } from '../../src/core/plan/plan-grapher.mjs';
import { ArchgenError } from '../../src/core/protocol/errors.mjs';

const TASKS = `tasks:
  - id: SCAFFOLD
    title: Scaffold the app
    depends_on: []
    file_ownership: ["src/config/**"]
    acceptance: ["build passes"]
  - id: API
    title: Build the API
    depends_on: [SCAFFOLD]
    file_ownership: ["src/api/**"]
    acceptance: ["GET /notes works"]
  - id: WEB
    title: Build the web app
    depends_on: [SCAFFOLD]
    file_ownership: ["src/web/**"]
    acceptance: ["the list renders"]
  - id: VERIFY
    title: Verify end to end
    depends_on: [API, WEB]
    file_ownership: ["tests/**"]
    acceptance: ["the suite exits 0"]
`;

/** A real `.archgen/<slug>/` tree — the scope gate rejects anything else. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-graph-'));
  const dir = join(root, '.archgen', 'demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.yaml'), TASKS, 'utf8');
  return { root, dir, tasks: join(dir, 'tasks.yaml') };
}

test('the whole-graph view resolves — this action used to throw INTERNAL', () => {
  const s = sandbox();
  try {
    const out = planGraph(s.tasks);
    assert.equal(out.format, 'json');
    assert.equal(out.data.taskCount, 4);
    assert.deepEqual(out.data.roots, ['SCAFFOLD']);
    assert.deepEqual(out.data.leaves, ['VERIFY']);
    assert.equal(out.data.waves.length, 3);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the mermaid render resolves, with and without status', () => {
  const s = sandbox();
  try {
    const plain = planGraph(s.tasks, { mermaid: true });
    assert.equal(plain.format, 'mermaid');
    assert.match(plain.data, /^flowchart LR/);
    assert.match(plain.data, /SCAFFOLD --> API/);

    // The exact call the review brief used to tell the orchestrator to make.
    const withStatus = planGraph(s.tasks, { mermaid: true, status: true });
    assert.match(withStatus.data, /classDef done/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the scoped views resolve', () => {
  const s = sandbox();
  try {
    const node = planGraph(s.tasks, { node: 'API' });
    assert.equal(node.data.id, 'API');
    assert.deepEqual(node.data.upstream.map((u) => u.id), ['SCAFFOLD']);
    assert.deepEqual(node.data.downstream.map((u) => u.id), ['VERIFY']);

    const module = planGraph(s.tasks, { module: 'src/api' });
    assert.deepEqual(module.data.tasks.map((t) => t.id), ['API']);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a broken plan is a typed error, never INTERNAL', () => {
  const s = sandbox();
  try {
    writeFileSync(
      join(s.dir, 'tasks.yaml'),
      'tasks:\n  - id: A\n    depends_on: [B]\n  - id: B\n    depends_on: [A]\n',
      'utf8',
    );
    assert.throws(
      () => planGraph(s.tasks),
      (e) => e instanceof ArchgenError && e.code === 'CYCLE',
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a missing plan is a typed error, never INTERNAL', () => {
  assert.throws(
    () => planGraph(join(tmpdir(), 'no-such-plan', 'tasks.yaml')),
    (e) => e instanceof ArchgenError && ['INVALID_INPUT', 'NOT_FOUND'].includes(e.code),
  );
});

test('the scope gate rejects a path outside .archgen', () => {
  const s = sandbox();
  try {
    const outside = join(s.root, 'tasks.yaml');
    writeFileSync(outside, TASKS, 'utf8');
    assert.throws(
      () => resolvePlanScope(outside),
      (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
