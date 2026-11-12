// skills-lens.test.mjs — the capability-skill LENS.
//
// WHY THIS FILE EXISTS: `archgen_skills` grew a lens in this release —
// `digest` (the section index of an installed skill) and `load` with a
// `section` (one section of it). They exist so the agent can pull exactly
// the part of a skill it needs, the same way `archgen_docs{action:'digest'}`
// works for the artifacts.
//
// They are the agent-facing half of the "the rules travel with the contract"
// change, so they are tested against the REAL tool handler, in a real project
// with a real installed skill.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';

createServer();

const SKILL = `---
name: baseline-ui
description: A demo capability skill.
---

# Baseline UI

Enforces an opinionated UI baseline.

## Stack

- MUST use Tailwind CSS defaults
- NEVER animate layout properties

## Animation

- MUST animate only compositor props
- SHOULD use ease-out on entrance
`;

let root;
let home;
let ctx;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'archgen-lens-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  // A real installed capability skill, at the canonical install path.
  const dir = join(root, '.agents', 'skills', 'baseline-ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), SKILL, 'utf8');
  ctx = new Context({ projectRoot: root, anchorRoot: root, home, env: { PATH: '/nonexistent' } });
});

after(() => rmSync(root, { recursive: true, force: true }));

const call = (args) => guard(getToolSpec('archgen_skills').handler, ctx, args);

test('digest returns the section index of an installed skill', async () => {
  const env = await call({ action: 'digest', skillId: 'ui-baseline' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.installed, true);
  assert.match(env.data.path, /baseline-ui[/\\]SKILL\.md$/);
  const slugs = env.data.sections.map((s) => s.slug);
  assert.ok(slugs.includes('stack'));
  assert.ok(slugs.includes('animation'));
  // The section that carries the MUST rules is marked normative — that is how
  // an agent knows which part of a skill it must actually read.
  assert.equal(env.data.sections.find((s) => s.slug === 'stack').normative, true);
  assert.equal(env.data.sections.find((s) => s.slug === 'animation').normative, true);
});

test('digest on a skill that is NOT installed says so, and says where it looked', async () => {
  const env = await call({ action: 'digest', skillId: 'ui-motion' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.installed, false);
  assert.deepEqual(env.data.sections, []);
  assert.ok(Array.isArray(env.data.searchedPaths) && env.data.searchedPaths.length > 0);
  assert.match(env.data.hint, /not installed/);
});

test('load returns the NORMATIVE RULES and the section index', async () => {
  const env = await call({ action: 'load', skillId: 'ui-baseline' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.loaded, true);
  assert.match(env.data.rules, /MUST use Tailwind CSS defaults/);
  assert.match(env.data.rules, /NEVER animate layout properties/);
  assert.equal(env.data.ruleCount, 4);
  assert.ok(env.data.sections.some((s) => s.slug === 'stack'));
  assert.match(env.data.followInstruction, /baseline-ui/);
});

test('load with a section returns exactly that section', async () => {
  const env = await call({ action: 'load', skillId: 'ui-baseline', section: 'animation' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.section, 'animation');
  assert.equal(env.data.sectionTitle, 'Animation');
  assert.match(env.data.sectionText, /MUST animate only compositor props/);
  // The section must NOT carry the other section's rules.
  assert.doesNotMatch(env.data.sectionText, /MUST use Tailwind CSS defaults/);
});

test('load accepts a section by its title, too', async () => {
  const env = await call({ action: 'load', skillId: 'ui-baseline', section: 'Stack' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.section, 'stack');
});

test('load with a section that does not exist is typed, and lists the real ones', async () => {
  const env = await call({ action: 'load', skillId: 'ui-baseline', section: 'nope' });
  assert.ok(!env.ok);
  assert.equal(env.error.code, 'INVALID_INPUT');
  assert.ok(env.error.details.available.includes('stack'));
});

test('load on a skill that is NOT installed reports the miss with the search paths', async () => {
  const env = await call({ action: 'load', skillId: 'ui-motion' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.loaded, false);
  assert.equal(env.data.rules, '');
  assert.equal(env.data.ruleCount, 0);
  assert.ok(env.data.searchedPaths.length > 0);
  assert.match(env.data.hint, /not installed/);
  assert.equal(env.data.followInstruction, null);
});

test('the routing entry resolves like any other skill', async () => {
  const env = await call({ action: 'digest', skillId: 'ui-router' });
  assert.ok(env.ok, env.error?.message);
  assert.equal(env.data.skill, 'ui-skills-root');
});

test('an unknown skill is a typed INVALID_INPUT that points at the registry', async () => {
  const env = await call({ action: 'load', skillId: 'not-a-skill' });
  assert.ok(!env.ok);
  assert.equal(env.error.code, 'INVALID_INPUT');
  assert.match(env.error.message, /archgen_skills/);
});

test('load and digest both require a skillId', async () => {
  for (const action of ['load', 'digest']) {
    const env = await call({ action });
    assert.ok(!env.ok, `${action} must reject a missing skillId`);
    assert.equal(env.error.code, 'INVALID_INPUT');
  }
});
