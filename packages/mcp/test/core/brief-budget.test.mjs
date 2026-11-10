// brief-budget.test.mjs — the brief is a MAP, and the map is bounded.
//
// WHY.
//
// A 30-task plan with 60 edge rows rendered every map in full: 6,034 tokens
// in one message — a fifth of a 32k window before the agent reads a single
// section. The maps exist to PAIR a row with its acceptance, not to reproduce
// the plan.
//
// BUT a hard cap is the wrong answer on its own: a SMALL plan that is dense
// (few tasks, many cases) must never lose rows, and a plan that fits must
// never be truncated "to be safe". So the budget is a CEILING, allocated by
// share, with the surplus flowing to the next map, and every omission named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBriefContext } from '../../src/core/brief-context.mjs';
import { renderBriefContext } from '../../src/core/briefs.mjs';
import { Context } from '../../src/context.mjs';
import { estimateTokens } from '../../../../internal/tools/tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A plan with `tasks` tasks and `rows` edge rows, all links consistent. */
function plan(tasks, rows) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-brief-budget-'));
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'plans'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  const taskYaml = Array.from({ length: tasks }, (_, i) =>
    `  - id: T${i + 1}
    title: module ${i + 1}
    depends_on: [${i ? `T${i}` : ''}]
    file_ownership: ["src/m${i + 1}/**", "tests/unit/m${i + 1}/**"]
    acceptance:
      - "the module ${i + 1} behaviour holds (covers E${i + 1})"
      - "the module ${i + 1} returns the list (covers FR-M${i + 1}-01)"`,
  ).join('\n');
  writeFileSync(join(dir, 'tasks.yaml'), `tasks:\n${taskYaml}\n`, 'utf8');
  const matrix = Array.from({ length: rows }, (_, i) => {
    const t = (i % tasks) + 1;
    return `| E${t} | case ${t} | expected behaviour ${t} | T${t}#1 |`;
  }).join('\n');
  writeFileSync(
    join(dir, 'plans', 'demo.md'),
    `# Plan\n\nT1 module one.\n\n| Case | Input/state | Expected behavior | Covered by |\n| --- | --- | --- | --- |\n${matrix}\n`,
    'utf8',
  );
  writeFileSync(
    join(dir, 'docs', 'prd.md'),
    `# PRD\n\n${Array.from({ length: tasks }, (_, i) => `- FR-M${i + 1}-01: module ${i + 1} does the thing`).join('\n')}\n`,
    'utf8',
  );
  writeFileSync(join(dir, 'architecture.yaml'), 'toolchain:\n  source_root: src\n  test_root: tests/unit\n', 'utf8');
  writeFileSync(
    join(dir, 'answers.yaml'),
    'plan_profile:\n  artifacts:\n    - path: .archgen/demo/tasks.yaml\n      decision: create\n      reason: the task contract\n    - path: .archgen/demo/plans/demo.md\n      decision: create\n      reason: the plan of record\n',
    'utf8',
  );
  const ctx = new Context({ projectRoot: root, anchorRoot: root, home: root, env: { PATH: '/nonexistent' } });
  const scope = { slug: 'demo', slugDir: dir, plansDir: join(dir, 'plans'), tasksYaml: join(dir, 'tasks.yaml') };
  const brief = renderBriefContext(buildBriefContext('verifier', scope, ctx));
  return { brief, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('a SMALL plan is never truncated', () => {
  const p = plan(3, 9);
  try {
    assert.doesNotMatch(p.brief, /more row\(s\) in/, 'a small plan must not be truncated');
    assert.match(p.brief, /#### Edge-case matrix map/, 'the maps are still there');
  } finally {
    p.cleanup();
  }
});

test('a LARGE plan is bounded, and says what it left out and where', () => {
  const p = plan(30, 90);
  try {
    assert.match(p.brief, /more row\(s\) in/, 'a large plan must be bounded');
    assert.match(p.brief, /read that section and check every row there/, 'the omission names the rule');
    assert.match(
      p.brief,
      /The floor already checked EVERY row it did not show you/,
      'the brief must say the mechanical checks were complete',
    );
  } finally {
    p.cleanup();
  }
});

test('the bounded brief costs a fraction of the unbounded one', () => {
  const p = plan(30, 90);
  try {
    const tokens = estimateTokens(p.brief);
    assert.ok(tokens < 4000, `a 30-task brief must stay under 4,000 tokens, got ${tokens}`);
  } finally {
    p.cleanup();
  }
});

test('the brief carries the snapshot the agent checks for staleness', () => {
  const p = plan(5, 15);
  try {
    assert.match(p.brief, /### PLAN SNAPSHOT/);
    assert.match(p.brief, /fingerprint: sha256:/);
    assert.match(p.brief, /plan CHANGED after this brief was rendered/);
  } finally {
    p.cleanup();
  }
});
