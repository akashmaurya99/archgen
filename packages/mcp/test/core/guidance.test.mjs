// guidance.test.mjs — every failure TEACHES the next call.
//
// WHY THIS FILE EXISTS.
//
// An agent reported three failures in a row, and two of them were loops:
// it passed `section:'plan-depth'` (the shorthand the skill teaches) and got
// "no section 'plan-depth'", then it assumed `scaffold` had written files
// and got "missing or not a directory" from every artifact tool.
//
// An error that only says WHAT FAILED leaves the agent to guess, and a guess
// that fails the same way is a loop. So every failure must carry the cause,
// the fix, and the exact next call — in ONE line.
//
// These tests pin that contract: the message a caller receives must name the
// next call, and the cases the skill taught must actually WORK.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';

createServer();

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

let root;
let ctx;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'archgen-guidance-'));
  const dir = join(root, '.archgen', 'demo');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'tasks.yaml'), 'tasks:\n  - id: API\n    title: API\n', 'utf8');
  writeFileSync(join(dir, 'docs', 'prd.md'), '# PRD\n\n## Non-functional requirements\n- fast\n', 'utf8');
  ctx = new Context({ projectRoot: root, anchorRoot: root, home: root, env: { PATH: '/nonexistent' } });
});

after(() => rmSync(root, { recursive: true, force: true }));

const call = (tool, args) => guard(getToolSpec(tool).handler, ctx, args);

test('the § SHORTHAND the skill teaches RESOLVES — the exact reported failure', async () => {
  // The skill says: §artifact-templates/plan-depth
  // The real slug is: plan-depth-by-scope-class
  const env = await call('archgen_refs', { action: 'read', topic: 'artifact-templates', section: 'plan-depth' });
  assert.ok(env.ok, `the skill's own shorthand must resolve: ${env.error?.message}`);
  assert.equal(env.data.section, 'plan-depth-by-scope-class');
});

test('every § shorthand in the SKILL resolves', async () => {
  const skill = readFileSync(join(REPO, 'skill', 'SKILL.md'), 'utf8');
  const marks = [...new Set([...skill.matchAll(/§([a-z-]+)\/([a-z0-9-]+)/g)].map((m) => `${m[1]}/${m[2]}`))];
  assert.ok(marks.length >= 10, `the skill should carry § markers, found ${marks.length}`);
  const broken = [];
  for (const mark of marks) {
    const [topic, section] = mark.split('/');
    const env = await call('archgen_refs', { action: 'read', topic, section });
    if (!env.ok) broken.push(`§${mark}: ${env.error.message}`);
  }
  assert.deepEqual(broken, [], `the skill teaches § marks that do not resolve:\n${broken.join('\n')}`);
});

test('a section also resolves by its title', async () => {
  const env = await call('archgen_refs', { action: 'read', topic: 'artifact-templates', section: 'Plan depth by scope class' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.section, 'plan-depth-by-scope-class');
});

test('a section that does not exist names the next call in ONE line', async () => {
  const env = await call('archgen_refs', { action: 'read', topic: 'artifact-templates', section: 'nope' });
  assert.ok(!env.ok);
  const message = env.error.message;
  assert.match(message, /Next: archgen_refs\{action:'index',topic:'artifact-templates'\}/);
  assert.ok(message.split('\n').length <= 2, `the message must be ONE line, got:\n${message}`);
  // The valid slugs ride along in the details, so a client can act without
  // parsing prose.
  assert.ok(Array.isArray(env.error.details.available));
  assert.ok(env.error.details.available.includes('plan-depth-by-scope-class'));
});

test('a missing artifact space says scaffold writes NOTHING', async () => {
  const env = await call('archgen_docs', { action: 'index', slugDir: join(root, '.archgen', 'not-created-yet') });
  assert.ok(!env.ok);
  const message = env.error.message;
  assert.match(message, /scaffold returns file CONTENT and writes nothing/);
  assert.match(message, /Next: archgen_plan\{action:'scaffold'/);
  assert.ok(message.split('\n').length <= 2, `the message must be ONE line, got:\n${message}`);
});

test('scaffold says what it returns and that it writes nothing', async () => {
  const env = await call('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: 'demo' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.writes, false);
  assert.ok(Array.isArray(env.data.writeThese) && env.data.writeThese.length > 0);
  assert.ok(env.data.writeThese.every((p) => p.startsWith('.archgen/demo/')));
});

test('a task id that does not exist lists the real ones', async () => {
  const env = await call('archgen_tasks', {
    action: 'contract',
    tasksYaml: join(root, '.archgen', 'demo', 'tasks.yaml'),
    taskId: 'NOPE',
  });
  assert.ok(!env.ok);
  assert.match(env.error.message, /Next: archgen_tasks\{action:'list'/);
  assert.ok(env.error.details.available.includes('API'));
});

test('an unknown skill names the install call', async () => {
  const env = await call('archgen_skills', { action: 'load', skillId: 'not-a-skill' });
  assert.ok(!env.ok);
  assert.match(env.error.message, /archgen_skills\{action:'list'\}/);
  assert.ok(env.error.message.split('\n').length <= 2, `the message must be ONE line, got:\n${env.error.message}`);
});
