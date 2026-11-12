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

test('the completion call in the contract is COMPLETE — it can be pasted as it stands', () => {
  // The contract taught workers to call
  // `archgen_tasks{action:'set_status', taskId, status}` — the call the tool
  // REFUSED, because it also needs the task file. A worker that obeyed the
  // contract exactly failed on the last step of every task. The call the
  // contract prints must name every argument the action requires.
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    const call = c.prompt.match(/archgen_tasks\{action:'set_status'[^}]*\}/);
    assert.ok(call, 'the contract prints the completion call');
    assert.match(call[0], /tasksYaml:/, 'the completion call names the task file');
    assert.match(call[0], /taskId:'C'/, 'the completion call names the task');
    assert.match(call[0], /status:'done'/, 'the completion call names the status');
    assert.ok(call[0].includes(tasks), 'the completion call carries the REAL task file path');
    const failed = c.prompt.match(/archgen_tasks\{action:'set_status'[^}]*status:'failed'[^}]*\}/);
    assert.ok(failed, 'the failed variant is printed too');
    assert.match(failed[0], /tasksYaml:/, 'the failed variant names the task file as well');
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
      capabilities: [
        {
          slug: 'baseline-ui',
          path: '/p/.agents/skills/baseline-ui/SKILL.md',
          domain: 'Design',
          installed: true,
          rules: '[Stack] MUST use Tailwind CSS defaults',
          sections: [{ slug: 'stack', title: 'Stack', normative: true }],
        },
      ],
    });
    assert.match(c.prompt, /Capability skills \(REQUIRED/);
    assert.ok(c.prompt.includes('/p/.agents/skills/baseline-ui/SKILL.md'));
    // The RULES travel with the contract — a path pointer is a file the
    // worker may never open, and a skill that is never opened is never used.
    assert.ok(c.prompt.includes('MUST use Tailwind CSS defaults'));
    // And the literal `<Domain>` placeholder must never ship again.
    assert.doesNotMatch(c.prompt, /<Domain>/);
    assert.doesNotMatch(c.prompt, /<skill>|<path>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('EVERY matched capability skill is injected, not just the first', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({
      tasksYaml: tasks,
      taskId: 'C',
      slugDir: dir,
      capabilities: [
        { slug: 'baseline-ui', path: '/p/a/SKILL.md', domain: 'Design', installed: true, rules: 'rule A' },
        { slug: 'fixing-accessibility', path: '/p/b/SKILL.md', domain: 'Accessibility', installed: true, rules: 'rule B' },
      ],
    });
    assert.ok(c.prompt.includes('baseline-ui'), 'the first skill is missing');
    assert.ok(c.prompt.includes('fixing-accessibility'), 'the second skill was silently dropped');
    assert.ok(c.prompt.includes('rule A'));
    assert.ok(c.prompt.includes('rule B'));
    assert.equal(c.capabilities.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a capability skill that is not installed makes the task undispatchable', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({
      tasksYaml: tasks,
      taskId: 'C',
      slugDir: dir,
      capabilities: [{ slug: 'baseline-ui', path: null, domain: 'Design', installed: false }],
    });
    assert.equal(c.dispatchable, false);
    assert.ok(c.warnings.some((w) => /baseline-ui/.test(w) && /not installed/i.test(w)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the contract lets the worker READ what it needs, and bounds only the WRITES', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    // The contract is a SNAPSHOT: the plan, the code and the capability
    // skill can change under the worker, so a question it cannot answer
    // must be answerable by reading — not by guessing, and not by stalling.
    assert.match(c.prompt, /MAY read anything else you need/i);
    assert.match(c.prompt, /archgen skill and its references/i);
    assert.match(c.prompt, /read the cheapest source/i);
    // The bound is the WORK: reading is free, changing is not.
    assert.match(c.prompt, /read-only archgen actions are yours for facts/i);
    assert.match(c.prompt, /archgen_docs/);
    assert.match(c.prompt, /archgen_refs/);
    assert.match(c.prompt, /ONLY archgen write you make is the set_status/i);
    assert.match(c.prompt, /do not open the gates/i);
    // The one archgen call the worker DOES make.
    assert.match(c.prompt, /set_status/);
    // The old absolute bans are gone.
    assert.doesNotMatch(c.prompt, /Do NOT read the archgen skill/i);
    assert.doesNotMatch(c.prompt, /Do NOT run the archgen tool suite/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CodeGraph directive is emitted when the project is indexed', () => {
  const { dir, tasks } = sandbox();
  try {
    const without = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir });
    assert.doesNotMatch(without.prompt, /CodeGraph/);
    const withIt = buildWorkerContract({ tasksYaml: tasks, taskId: 'C', slugDir: dir, codegraph: true });
    assert.match(withIt.prompt, /CodeGraph/);
    assert.match(withIt.prompt, /Never re-index/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pre-located doc sections are included — the plan itself is not dumped', () => {
  const { dir, tasks } = sandbox();
  try {
    const c = buildWorkerContract({
      tasksYaml: tasks,
      taskId: 'C',
      slugDir: dir,
      docSections: [{ file: 'plans/demo.md', section: 'C — Scaffold', title: 'Scaffold' }],
    });
    // The sections are NAMED, so the worker opens one section instead of the
    // whole plan — a cost rule, not a ban: the worker may still read more.
    assert.match(c.prompt, /start with these sections/i);
    assert.match(c.prompt, /The whole plan is not required/i);
    assert.ok(c.prompt.includes('plans/demo.md § C — Scaffold'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
