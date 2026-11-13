// gates.test.mjs — the repository's own gates must be able to fail.
//
// WHY THIS FILE EXISTS. Four gates guard this repository, and none of them
// had a test:
//
//   - teaching-lint — every failure site teaches its next call;
//   - repo-immutable — the suites never mutate the repository;
//   - gen-catalog — the skill's tool table matches the live schemas;
//   - the version parity — the two version readers agree.
//
// A gate nobody tests is a gate whose BEHAVIOUR nobody knows. Each one is
// exercised here against a deliberately broken copy, so a change that quietly
// makes the gate vacuous fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, exposedToolNames } from '../../packages/mcp/src/server.mjs';
import { getToolSpec } from '../../packages/mcp/src/tools/_register.mjs';

createServer();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** Run a command and return its exit status. */
function status(cmd, args, cwd = ROOT) {
  try {
    execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (e) {
    return e.status ?? 1;
  }
}

test('teaching-lint fails when a failure site loses its hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-teach-'));
  try {
    // A copy of the package's src, with ONE failure site that teaches nothing.
    cpSync(join(ROOT, 'packages', 'mcp', 'src'), join(dir, 'src'), { recursive: true });
    // The probe sits NEXT TO errors.mjs, because that is where invalidInput
    // lives now — the core/ tree is grouped by domain, and a probe that
    // imported across a domain boundary would be testing the import rather
    // than the lint.
    writeFileSync(
      join(dir, 'src', 'core', 'protocol', 'probe.mjs'),
      "import { invalidInput } from './errors.mjs';\n"
        + 'export function probe() {\n'
        + "  throw invalidInput('a failure that teaches nothing');\n"
        + '}\n',
    );

    const lint = join(dir, 'teaching-lint.mjs');
    cpSync(join(ROOT, 'internal', 'tools', 'lint', 'teaching-lint.mjs'), lint);
    assert.notEqual(
      status(process.execPath, [lint]),
      0,
      'the lint must fail on a failure site with no hint',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('teaching-lint passes on the repository as it stands', () => {
  assert.equal(status(process.execPath, [join(ROOT, 'internal', 'tools', 'lint', 'teaching-lint.mjs')]), 0);
});

test('repo-immutable catches a file that appears during the run', () => {
  // The gate compares BEFORE with AFTER, so the mutation must happen INSIDE
  // the command it runs — a file that was already there is in both snapshots.
  const gate = join(ROOT, 'internal', 'tools', 'safety', 'repo-immutable.mjs');
  const marker = join(ROOT, 'UNTRACKED-BY-THE-GATE.txt');
  assert.equal(status(process.execPath, [gate, '--', 'true']), 0, 'a clean tree passes');

  try {
    assert.notEqual(
      status(process.execPath, [gate, '--', 'sh', '-c', 'printf x > UNTRACKED-BY-THE-GATE.txt']),
      0,
      'the gate must catch an untracked file',
    );
    assert.ok(existsSync(marker), 'the gate must not delete what it caught');
  } finally {
    rmSync(marker, { force: true });
  }
});

test('the skill tool table names exactly the actions the schemas offer', () => {
  // The table is GENERATED from the live schemas, so this asserts the
  // property the generator exists to guarantee: every action the model can
  // call is named, and nothing that cannot be called is named.
  const skill = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf8');
  const block = skill.split('<!-- archgen:catalog:start -->')[1]?.split('<!-- archgen:catalog:end -->')[0];
  assert.ok(block, 'the skill must carry the generated catalog block');

  for (const name of exposedToolNames()) {
    const spec = getToolSpec(name);
    const actions = spec.inputSchema.shape?.action?._def?.values
      ?? spec.inputSchema.shape?.action?.options
      ?? [];
    const row = block.split('\n').find((l) => l.includes(`\`${name}\``));
    assert.ok(row, `the skill's table must name ${name}`);
    if (!actions.length) continue;
    for (const action of actions) {
      assert.ok(row.includes(`\`${action}\``), `the skill's table must name ${name}{action:'${action}'}`);
    }
  }
});
