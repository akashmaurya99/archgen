import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docIndex } from '../../src/core/docs/doc-navigator.mjs';

test('same-document anchors are validated against the current document', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-local-anchor-'));
  try {
    const dir = join(root, '.archgen', 'demo', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, '.archgen', 'demo', 'tasks.yaml'), 'tasks: []\n');
    const file = join(dir, 'demo.md');
    writeFileSync(file, '# Plan\n\n## Real section\n\n[good](#real-section) [bad](#missing-section)\n');
    const result = docIndex(join(root, '.archgen', 'demo'), { mode: 'validate', projectRoot: root });
    assert.ok(result.data.broken.some((entry) => entry.kind === 'anchor' && entry.ref === '#missing-section'));
    assert.ok(!result.data.broken.some((entry) => entry.ref === '#real-section'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task reference validation accepts legal id shapes and skips technical constants', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-task-shapes-'));
  try {
    const dir = join(root, '.archgen', 'demo', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, '.archgen', 'demo', 'tasks.yaml'), 'tasks:\n  - id: RL1\n    title: rate limit\n');
    writeFileSync(join(dir, 'demo.md'), '# Plan\n\nRL1 is known; RL2 is unknown; SHA-256 is not a task.\n');
    const result = docIndex(join(root, '.archgen', 'demo'), { mode: 'validate', projectRoot: root });
    assert.ok(result.data.broken.some((entry) => entry.kind === 'task' && entry.ref === 'RL2'));
    assert.ok(!result.data.broken.some((entry) => entry.ref === 'SHA-256'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
