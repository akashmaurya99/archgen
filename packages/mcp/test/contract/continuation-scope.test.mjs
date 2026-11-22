import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server.mjs';
import { getToolSpec, runTool } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';

createServer();

test('filtered task continuations preserve every filter and the resolved project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-next-filter-'));
  try {
    const dir = join(root, '.archgen', 'demo');
    mkdirSync(dir, { recursive: true });
    const tasksYaml = join(dir, 'tasks.yaml');
    writeFileSync(tasksYaml, 'tasks:\n  - id: A\n    title: A\n    status: pending\n    file_ownership: ["src/a/**"]\n  - id: B\n    title: B\n    status: pending\n    file_ownership: ["src/b/**"]\n  - id: C\n    title: C\n    status: done\n    file_ownership: ["src/c/**"]\n');
    const ctx = new Context({ projectRoot: root });
    const first = await runTool(getToolSpec('archgen_tasks'), ctx, { action: 'list', tasksYaml, filterStatus: 'pending', module: 'src', limit: 1 });
    assert.equal(first.ok, true);
    assert.match(first.meta.next, /filterStatus:'pending'/);
    assert.match(first.meta.next, /module:'src'/);
    assert.match(first.meta.next, new RegExp(`projectRoot:'${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    const second = await runTool(getToolSpec('archgen_tasks'), ctx, { action: 'list', tasksYaml, filterStatus: 'pending', module: 'src', limit: 1, offset: 1, projectRoot: root });
    assert.deepEqual(second.data.tasks.map((task) => task.id), ['B']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reference index continuations never contain a placeholder section', async () => {
  const ctx = new Context({ projectRoot: process.cwd() });
  const first = await runTool(getToolSpec('archgen_refs'), ctx, { action: 'read', topic: 'orchestration', limit: 1 });
  assert.equal(first.ok, true);
  assert.ok(first.meta.next);
  assert.doesNotMatch(first.meta.next, /<the section you need>/);
  assert.match(first.meta.next, /action:'read'/);
  assert.doesNotMatch(first.meta.next, /section:/);
});
