import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server.mjs';
import { getToolSpec, runTool } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { buildWorkerContract } from '../../src/core/docs/worker-contract.mjs';

createServer();

const TASKS = 'tasks:\n  - id: C\n    title: Implement config\n    file_ownership: ["src/config/**"]\n    acceptance:\n      - "the config build exits 0"\n';

function project(slugs = ['demo']) {
  const root = mkdtempSync(join(tmpdir(), 'ag-worker-diagnostics-'));
  for (const slug of slugs) {
    const dir = join(root, '.archgen', slug);
    mkdirSync(join(dir, 'plans'), { recursive: true });
    writeFileSync(join(dir, 'tasks.yaml'), TASKS);
    writeFileSync(join(dir, 'plans', 'demo.md'), '# Plan\n\n## C — Implement config\n');
  }
  return root;
}

test('document-navigation failure is explicit and blocks dispatch', async () => {
  const root = project();
  try {
    const ctx = new Context({ projectRoot: root, home: root, env: { ARCHGEN_CODEGRAPH: '0' } });
    const result = await runTool(getToolSpec('archgen_tasks'), ctx, {
      action: 'contract', tasksYaml: join(root, '.archgen', 'demo', 'tasks.yaml'), taskId: 'C', slugDir: join(root, 'missing'),
    });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.data.dispatchable, false);
    assert.ok(result.data.warnings.some((warning) => warning.includes('document navigation failed')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ambiguous active-plan warning also blocks dispatch', async () => {
  const root = project(['alpha', 'beta']);
  try {
    const ctx = new Context({ projectRoot: root, home: root, env: { ARCHGEN_CODEGRAPH: '0' } });
    const result = await runTool(getToolSpec('archgen_tasks'), ctx, { action: 'contract', taskId: 'C' });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.data.dispatchable, false);
    assert.ok(result.data.warnings.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the core contract derives dispatchability from final diagnostics', () => {
  const root = project();
  try {
    const result = buildWorkerContract({
      tasksYaml: join(root, '.archgen', 'demo', 'tasks.yaml'), taskId: 'C', slugDir: join(root, '.archgen', 'demo'), diagnostics: ['resolution is ambiguous'],
    });
    assert.equal(result.dispatchable, false);
    assert.ok(result.warnings.includes('resolution is ambiguous'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
