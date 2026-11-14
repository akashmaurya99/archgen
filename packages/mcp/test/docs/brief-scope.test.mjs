// brief-scope.test.mjs — the paths a dispatch brief carries.
//
// WHY THIS FILE EXISTS: two defects, one cause — the brief's paths were
// hand-assembled instead of resolved.
//
//   1. The brief action demanded `slug` even when the caller had already
//      passed the absolute `tasks.yaml`. That path IS `.archgen/<slug>/
//      tasks.yaml`, so the slug was derivable — and a caller that omitted it
//      got "needs tasks.yaml, plans dir, slug dir — pass slug" for a brief
//      it had already given everything for.
//
//   2. The emitted brief mixed path vocabularies: `tasks.yaml` was ABSOLUTE
//      while `slug dir` and `plans dir` were PROJECT-RELATIVE. A brief is
//      read by a sub-agent whose working directory may be a worktree, so a
//      relative path in a brief resolves against the SERVER's root and
//      silently points at the wrong tree.
//
// Every path in a brief is now absolute, and every one of them comes from the
// single scope resolved here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBriefScope, briefVars } from '../../src/core/docs/brief-scope.mjs';
import { ArchgenError } from '../../src/core/protocol/errors.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-brief-'));
  const dir = join(root, '.archgen', 'demo');
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(join(dir, 'tasks.yaml'), 'tasks:\n  - id: A\n    title: A\n', 'utf8');
  // The brief carries REAL paths — the scope gate proves them by realpath, so
  // a symlinked temp dir (/var -> /private/var on macOS) must be compared
  // against the real root, not the spelled one.
  const realRoot = realpathSync(root);
  return {
    root,
    realRoot,
    dir: join(realRoot, '.archgen', 'demo'),
    tasks: join(dir, 'tasks.yaml'),
    plans: join(dir, 'plans'),
  };
}

test('the slug is DERIVED from the tasks.yaml — no second fact demanded', () => {
  const s = sandbox();
  try {
    const scope = resolveBriefScope({ tasksYaml: s.tasks, projectRoot: s.root });
    assert.equal(scope.slug, 'demo');
    assert.equal(scope.slugDir, s.dir);
    assert.equal(scope.source, 'tasksYaml');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the slug is derived from the plans dir too', () => {
  const s = sandbox();
  try {
    const scope = resolveBriefScope({ planDir: s.plans, projectRoot: s.root });
    assert.equal(scope.slug, 'demo');
    assert.equal(scope.slugDir, s.dir);
    assert.equal(scope.source, 'planDir');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('EVERY path in a brief is absolute — one vocabulary, no cwd dependence', () => {
  const s = sandbox();
  try {
    const scope = resolveBriefScope({ tasksYaml: s.tasks, projectRoot: s.root });
    const vars = briefVars(scope, {});
    for (const key of ['slug dir', 'plans dir', 'tasks.yaml']) {
      assert.ok(vars[key].startsWith('/'), `${key} is not absolute: ${vars[key]}`);
      assert.ok(vars[key].startsWith(s.realRoot), `${key} does not point into the project: ${vars[key]}`);
    }
    // And they all agree with each other.
    assert.ok(vars['tasks.yaml'].startsWith(vars['slug dir']));
    assert.ok(vars['plans dir'].startsWith(vars['slug dir']));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the three paths share ONE prefix — a symlinked tmp dir does not split them', () => {
  const s = sandbox();
  try {
    const scope = resolveBriefScope({ tasksYaml: s.tasks, projectRoot: s.root });
    const vars = briefVars(scope, {});
    const prefixes = new Set(
      [vars['slug dir'], vars['plans dir'], vars['tasks.yaml']].map((p) => p.split('/.archgen/')[0]),
    );
    assert.equal(prefixes.size, 1, `the paths carry ${prefixes.size} different prefixes`);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a slug alone still resolves', () => {
  const s = sandbox();
  try {
    const scope = resolveBriefScope({ slug: 'demo', projectRoot: s.root });
    assert.equal(scope.slug, 'demo');
    assert.equal(scope.slugDir, s.dir);
    assert.equal(scope.source, 'slug');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a slug that disagrees with the artifact space is refused', () => {
  const s = sandbox();
  try {
    assert.throws(
      () => resolveBriefScope({ tasksYaml: s.tasks, slug: 'other', projectRoot: s.root }),
      (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a slug cannot steer the paths out of the artifact space', () => {
  const s = sandbox();
  try {
    assert.throws(
      () => resolveBriefScope({ slug: '../../etc', projectRoot: s.root }),
      (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a tasks.yaml outside .archgen is refused', () => {
  const s = sandbox();
  try {
    const outside = join(s.root, 'tasks.yaml');
    writeFileSync(outside, 'tasks: []\n', 'utf8');
    assert.throws(
      () => resolveBriefScope({ tasksYaml: outside, projectRoot: s.root }),
      (e) => e instanceof ArchgenError && e.code === 'INVALID_INPUT',
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('with nothing to resolve from, the error says what is missing', () => {
  const s = sandbox();
  try {
    assert.throws(
      () => resolveBriefScope({ projectRoot: s.root }),
      (e) => {
        assert.equal(e.code, 'INVALID_INPUT');
        // The resolver is now the ONE owner of this refusal, so it names the
        // ARGUMENTS a caller can pass.
        assert.ok(e.details.missing.includes('tasksYaml'));
        assert.ok(e.details.missing.includes('planDir'));
        assert.ok(e.details.missing.includes('slug'));
        return true;
      },
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a tasks.yaml that does not exist yet still resolves by its shape', () => {
  const s = sandbox();
  try {
    const future = join(s.dir, 'tasks.yaml');
    rmSync(future, { force: true });
    const scope = resolveBriefScope({ tasksYaml: future, projectRoot: s.root });
    assert.equal(scope.slug, 'demo');
    // The prefix is the SAME one the existing-file branch produces — the
    // lexical fallback must not spell the same place differently.
    assert.equal(scope.slugDir, s.dir);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
