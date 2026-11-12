// cli-fail-on.test.mjs — the floor as a BUILD GATE.
//
// WHY: the deterministic floor was reachable only from an agent session, so a
// CI job could not ask the same question the agent asks. `--fail-on` turns a
// tool result into an exit code:
//
//   archgen-mcp exec archgen_plan '{"action":"verify",…}' --fail-on verdict:ISSUES
//
// Exit 3 on a match, 0 otherwise. It reads artifacts, never code — so it is
// language-neutral by construction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { failOnMatches } from '../../src/cli.mjs';
import { REPO_ROOT } from '../support/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = REPO_ROOT;
const BIN = join(REPO, 'packages', 'mcp', 'bin', 'archgen-mcp.mjs');

test('the rule matches a dotted path inside the result', () => {
  assert.equal(failOnMatches({ verdict: 'ISSUES' }, 'verdict:ISSUES'), true);
  assert.equal(failOnMatches({ verdict: 'APPROVE' }, 'verdict:ISSUES'), false);
  assert.equal(failOnMatches({ data: { verdict: 'ISSUES' } }, 'data.verdict:ISSUES'), true);
  assert.equal(failOnMatches({ a: { b: 'x' } }, 'a.b:x'), true);
  assert.equal(failOnMatches({ a: { b: 'x' } }, 'a.b:y'), false);
  assert.equal(failOnMatches({ a: 1 }, 'a.b:x'), false);
  assert.equal(failOnMatches(null, 'verdict:ISSUES'), false);
  assert.equal(failOnMatches({ verdict: 'ISSUES' }, 'nonsense'), false);
});

/** A minimal plan whose verdict is ISSUES (a task with no acceptance). */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-failon-'));
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'plans', 'demo.md'), '# Plan\n\nT1 does the thing.\n', 'utf8');
  writeFileSync(
    join(dir, 'tasks.yaml'),
    'tasks:\n  - id: T1\n    title: x\n    depends_on: []\n    file_ownership: ["src/a/**"]\n    acceptance: []\n',
    'utf8',
  );
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('exec exits 3 when the floor says ISSUES', () => {
  const p = project();
  try {
    const args = [
      BIN,
      'exec',
      'archgen_plan',
      JSON.stringify({ action: 'verify', tasksYaml: join(p.dir, 'tasks.yaml'), planDir: join(p.dir, 'plans') }),
      '--fail-on',
      'verdict:ISSUES',
      '--project',
      p.root,
    ];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(r.status, 3, `expected the build gate to fail:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /--fail-on verdict:ISSUES matched/);
    const envelope = JSON.parse(r.stdout);
    assert.equal(envelope.data.verdict, 'ISSUES');
  } finally {
    p.cleanup();
  }
});

test('exec exits 0 when the verdict does not match', () => {
  const p = project();
  try {
    const args = [
      BIN,
      'exec',
      'archgen_plan',
      JSON.stringify({ action: 'verify', tasksYaml: join(p.dir, 'tasks.yaml'), planDir: join(p.dir, 'plans') }),
      '--fail-on',
      'verdict:APPROVE',
      '--project',
      p.root,
    ];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(r.status, 0, `a non-matching rule must not fail the build:\n${r.stdout}\n${r.stderr}`);
  } finally {
    p.cleanup();
  }
});
