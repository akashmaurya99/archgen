// briefs.test.mjs — the dispatch briefs.
//
// A brief is handed to a WORKER. A placeholder left in it is a worker told
// to look for a directory literally named "<slug dir>", and the paths in one
// brief must agree with each other: the slug dir, the plans dir and the
// tasks file all live under the same `.archgen/<slug>/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { BRIEFS_DIR } from '../../src/context.mjs';
import { loadBrief, remainingPlaceholders, BRIEF_KINDS } from '../../src/core/docs/briefs.mjs';

const SLUG = 'checkout';

/** The variables the brief tool derives from one slug. */
function vars(extra = {}) {
  return {
    slug: SLUG,
    'slug dir': `.archgen/${SLUG}`,
    'plans dir': `.archgen/${SLUG}/plans`,
    'tasks.yaml': `.archgen/${SLUG}/tasks.yaml`,
    'feature request': 'a checkout flow',
    topic: 'auth',
    round: '2',
    ...extra,
  };
}

test('every brief kind resolves every placeholder', () => {
  for (const kind of BRIEF_KINDS) {
    const { brief } = loadBrief(BRIEFS_DIR, kind, vars());
    assert.deepEqual(remainingPlaceholders(brief), [], `${kind} still has placeholders`);
  }
});

test('the derived paths agree with each other', () => {
  const { brief } = loadBrief(BRIEFS_DIR, 'review', vars());
  assert.ok(brief.includes(`.archgen/${SLUG}`), 'the slug dir is missing');
  assert.doesNotMatch(brief, /\.archgen\/<slug>/, 'a literal placeholder survived');
});

test('the plans dir and the tasks file sit under the slug dir', () => {
  const { brief } = loadBrief(BRIEFS_DIR, 'verifier', vars());
  assert.ok(brief.includes(`.archgen/${SLUG}/plans`));
  assert.ok(brief.includes(`.archgen/${SLUG}/tasks.yaml`));
});

test('remainingPlaceholders finds what is left', () => {
  assert.deepEqual(remainingPlaceholders('a <slug dir> and a <topic>'), ['slug dir', 'topic']);
  assert.deepEqual(remainingPlaceholders('nothing here'), []);
  assert.deepEqual(remainingPlaceholders('a <slug dir> and a <slug dir>'), ['slug dir']);
});

test('an unknown brief kind is a typed error', () => {
  assert.throws(() => loadBrief(BRIEFS_DIR, 'nope', vars()), (e) => e.code === 'INVALID_INPUT');
});
