// skill-manager.test.mjs — capability-skill matching, resolution, install and load.
//
// The matching rules are the FETCH-SKILL gate: a wrong match installs the
// wrong skill (or misses a required one), and an install that PROMPTS hangs
// the agent. Both are pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  matchSkills,
  findInstalledSkill,
  skillInstallPaths,
  loadSkill,
  listInstalled,
  followInstruction,
  wholeWordSource,
  HARNESS_AGENT_IDS,
} from '../../src/core/skill-manager.mjs';
import { loadAsset } from '../../src/context.mjs';

const registry = loadAsset('skill-registry.json');

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-skills-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

// ── matching ────────────────────────────────────────────────────────────────

test('a task matching a capability domain matches exactly ONE skill', () => {
  const matched = matchSkills(registry, { title: 'Polish the animation on the landing page' });
  const ids = matched.map((m) => m.id);
  assert.ok(ids.includes('ui-motion'), `expected the motion skill, got ${ids.join(', ')}`);
  assert.ok(!ids.includes('ui-baseline'), 'the baseline skill must not be dragged in by a cluster');
});

test('a task matching two domains matches both, separately', () => {
  const matched = matchSkills(registry, { title: 'Fix the animation and accessibility of the hero' });
  const ids = matched.map((m) => m.id);
  assert.ok(ids.includes('ui-motion'));
  assert.ok(ids.includes('ui-interaction'));
});

test('a task matching nothing matches nothing', () => {
  assert.deepEqual(matchSkills(registry, { title: 'Rotate the database connection pool' }), []);
});

test('matching is WHOLE-WORD, not substring', () => {
  // "ui" must not fire on "guide" / "build" / "sequence" — the substring
  // semantics that made the required gate meaningless.
  for (const word of ['guide', 'build', 'sequence', 'building', 'quick']) {
    const matched = matchSkills(registry, { title: `Refactor the ${word} helper` });
    assert.deepEqual(matched.map((m) => m.id), [], `"${word}" must not match a capability domain`);
  }
});

test('matching reads the summary and the file ownership, not just the title', () => {
  const bySummary = matchSkills(registry, { title: 'x', summary: 'add a motion transition' });
  assert.ok(bySummary.map((m) => m.id).includes('ui-motion'));
  // A path segment counts as a whole word: "motion" is bounded by "/" on both
  // sides. ("animations" would NOT match "animation" — the whole-word rule.)
  const byOwnership = matchSkills(registry, { title: 'x', fileOwnership: ['src/motion/**'] });
  assert.ok(byOwnership.map((m) => m.id).includes('ui-motion'));
});

test('the whole-word matcher does not fire inside a longer token', () => {
  const re = new RegExp(wholeWordSource('TASK-05'));
  assert.ok(re.test('see TASK-05 now'));
  assert.ok(!re.test('TASK-055'));
  assert.ok(!re.test('XTASK-05'));
});

// ── resolution ──────────────────────────────────────────────────────────────

test('a skill resolves to <project>/.agents/skills/<slug>/SKILL.md', () => {
  const { root } = sandbox();
  const paths = skillInstallPaths(root, 'baseline-ui');
  assert.equal(paths.skillFile, join(root, '.agents', 'skills', 'baseline-ui', 'SKILL.md'));
});

test('an installed skill is found; an absent one is not', () => {
  const { root, home } = sandbox();
  assert.equal(findInstalledSkill(root, 'baseline-ui', { home }).installed, false);

  const dir = join(root, '.agents', 'skills', 'baseline-ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# baseline-ui\n');
  const found = findInstalledSkill(root, 'baseline-ui', { home });
  assert.equal(found.installed, true);
  assert.equal(found.scope, 'project');
  assert.equal(found.path, join(dir, 'SKILL.md'));
});

test('a globally installed skill is found too', () => {
  const { root, home } = sandbox();
  const dir = join(home, '.agents', 'skills', 'baseline-ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# baseline-ui\n');
  const found = findInstalledSkill(root, 'baseline-ui', { home });
  assert.equal(found.installed, true);
  assert.equal(found.scope, 'global');
});

// ── load ────────────────────────────────────────────────────────────────────

test('loading an installed skill returns its content', () => {
  const { root, home } = sandbox();
  const dir = join(root, '.agents', 'skills', 'baseline-ui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# baseline-ui\n\nDo the thing.\n');
  const loaded = loadSkill({ projectRoot: root, slug: 'baseline-ui', home });
  assert.equal(loaded.loaded, true);
  assert.match(loaded.content, /Do the thing/);
  assert.ok(loaded.bytes > 0);
});

test('loading an absent skill reports "not installed" instead of throwing', () => {
  const { root, home } = sandbox();
  const loaded = loadSkill({ projectRoot: root, slug: 'nope', home });
  assert.equal(loaded.loaded, false);
  assert.equal(loaded.content, null);
});

test('listInstalled reports only what is present', () => {
  const { root, home } = sandbox();
  assert.deepEqual(listInstalled({ projectRoot: root, registry, home }), []);
  const dir = join(root, '.agents', 'skills', 'fixing-motion-performance');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# motion\n');
  const listed = listInstalled({ projectRoot: root, registry, home });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].slug, 'fixing-motion-performance');
});

// ── the follow-instruction ──────────────────────────────────────────────────

test('the follow-instruction points at the installed file', () => {
  const line = followInstruction({ slug: 'baseline-ui', path: '/p/.agents/skills/baseline-ui/SKILL.md' });
  assert.match(line, /\/p\/\.agents\/skills\/baseline-ui\/SKILL\.md/);
  assert.match(line, /apply its standards/i);
});

test('the follow-instruction falls back to the canonical path', () => {
  const line = followInstruction({ slug: 'baseline-ui', path: null });
  assert.match(line, /\.agents\/skills\/baseline-ui\/SKILL\.md/);
});

// ── the registry contract ───────────────────────────────────────────────────

test('every registry entry has the canonical shape and a unique id/slug', () => {
  const ids = new Set();
  const slugs = new Set();
  for (const entry of registry.skills) {
    for (const key of ['id', 'slug', 'family', 'repo', 'purpose', 'matches', 'policy']) {
      assert.ok(entry[key] !== undefined, `entry ${entry.id ?? '?'} is missing '${key}'`);
    }
    assert.ok(['required', 'on-demand'].includes(entry.policy), `bad policy on ${entry.id}`);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    assert.ok(!slugs.has(entry.slug), `duplicate slug ${entry.slug}`);
    ids.add(entry.id);
    slugs.add(entry.slug);
  }
});

test('the registry points at ONE repo per family (no clustering across sources)', () => {
  const byFamily = new Map();
  for (const entry of registry.skills) {
    const repos = byFamily.get(entry.family) ?? new Set();
    repos.add(entry.repo);
    byFamily.set(entry.family, repos);
  }
  for (const [family, repos] of byFamily) {
    assert.equal(repos.size, 1, `family ${family} spans ${repos.size} repos — skills must not be clustered across sources`);
  }
});

test('every harness id maps to a skills-CLI agent id', () => {
  for (const [harness, agent] of Object.entries(HARNESS_AGENT_IDS)) {
    assert.match(agent, /^[a-z0-9-]+$/, `agent id for ${harness} is not CLI-safe`);
  }
  assert.equal(HARNESS_AGENT_IDS.claude, 'claude-code');
  assert.equal(HARNESS_AGENT_IDS.universal, 'universal');
});
