// worker-contract.test.mjs — the assembled worker prompt.
//
// The contract is what a sub-agent actually receives. Every rule it used to
// carry as prose is now assembled from the same sources the rest of the system
// reads, so a worker can never be handed a bare filename, a paraphrased
// acceptance criterion, or a whole-plan dump.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildWorkerContract } from '../../src/core/worker-contract.mjs';

const TASKS = `# schema_version: 1
tasks:
  - id: C
    title: Scaffold project skeleton + config loading
    depends_on: []
    file_ownership:
      - src/config/**
      - package.json
    acceptance:
      - "npm run build exits 0"
      - "config loads from env with a typed schema"
  - id: B
    title: Catalog API endpoints
    depends_on: [C]
    file_ownership:
      - src/features/catalog/**
    acceptance:
      - "GET /products returns seeded list"
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-contract-'));
  const tasks = join(dir, 'tasks.yaml');
  writeFileSync(tasks, TASKS, 'utf8');
  return { dir, tasks };
}

test('the contract carries the acceptance criteria VERBATIM', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    assert.deepEqual(c.acceptance, ['npm run build exits 0', 'config loads from env with a typed schema']);
    for (const a of c.acceptance) assert.ok(c.prompt.includes(a), 'the acceptance bullet must appear verbatim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract carries the owned paths and the "edit nothing else" rule', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    assert.ok(c.prompt.includes('src/config/**'));
    assert.ok(c.prompt.includes('package.json'));
    assert.match(c.prompt, /edit NOTHING outside these/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract states the dependency neighbourhood in both directions', () => {
  const { dir, tasks } = sandbox();
  try {
    const b = buildWorkerContract({ tasksYaml: tasks, taskId: 'B', slugDir: dir });
    assert.deepEqual(b.upstream.map((u) => u.id), ['C']);
    assert.match(b.prompt, /Prerequisites/);
    assert.match(b.prompt, /C — Scaffold project skeleton/);

    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    assert.deepEqual(c.upstream, []);
    assert.deepEqual(c.downstream.map((d) => d.id), ['B']);
    assert.match(c.prompt, /wave-1 task/i);
    assert.match(c.prompt, /What depends on you/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract names the finish procedure', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    assert.match(c.prompt, /archgen_tasks/);
    assert.match(c.prompt, /set_status/);
    assert.match(c.prompt, /Skill compliance:/);
    assert.match(c.prompt, /Commit your work scoped to the owned files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract points at the working state location', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    assert.ok(c.prompt.includes('.agent/notes/C.md'));
    assert.match(c.prompt, /NEVER create ad-hoc/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a task with no acceptance criteria is reported as not dispatchable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-contract-'));
  try {
    const tasks = join(dir, 'tasks.yaml');
    writeFileSync(
      tasks,
      'tasks:\n  - id: X\n    title: No criteria\n    file_ownership: ["a/**"]\n',
      'utf8',
    );
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'X', slugDir: dir });
    assert.equal(c.dispatchable, false);
    assert.ok(c.warnings.some((w) => /acceptance/i.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a task with no file ownership is reported as not dispatchable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-contract-'));
  try {
    const tasks = join(dir, 'tasks.yaml');
    writeFileSync(tasks, 'tasks:\n  - id: X\n    title: No ownership\n    acceptance: ["ok"]\n', 'utf8');
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'X', slugDir: dir });
    assert.equal(c.dispatchable, false);
    assert.ok(c.warnings.some((w) => /file_ownership/i.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown task id is a typed NOT_FOUND', () => {
  const { dir, tasks } = sandbox();
  try {
    assert.throws(
      () => buildWorkerContract({ tasksYaml: tasks, taskId: 'NOPE', slugDir: dir }),
      (e) => e.code === 'NOT_FOUND',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the capability skill is injected when one is resolved', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({
      tasksYaml: tasks,
      taskId: 'C',
      slugDir: dir,
      capability: { slug: 'baseline-ui', path: '/p/.agents/skills/baseline-ui/SKILL.md' },
    });
    assert.match(c.prompt, /Capability skill \(REQUIRED\)/);
    assert.ok(c.prompt.includes('/p/.agents/skills/baseline-ui/SKILL.md'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pre-located doc sections are included — never the whole plan', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({
      tasksYaml: tasks,
      taskId: 'C',
      slugDir: dir,
      docSections: [{ file: 'plans/demo.md', section: 'C — Scaffold', title: 'Scaffold' }],
    });
    assert.match(c.prompt, /read ONLY these sections/i);
    assert.ok(c.prompt.includes('plans/demo.md § C — Scaffold'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
