// containment-symlink-spelling.test.mjs — a valid path is not an escape.
//
// WHY THIS FILE EXISTS: the containment guard compared the LEXICAL path
// against the REAL root. Those two are spelled differently in the NORMAL
// case: `process.cwd()` returns the REAL path, while the caller passes the
// LOGICAL one. On macOS `/tmp` and `/var` are symlinks into `/private`, and
// a symlinked project or home directory does the same everywhere.
//
// So the guard refused perfectly valid paths inside the project with
// "refusing a path outside the project" — the two names the SAME place.
//
// It was found by installing the PUBLISHED package into a temp project and
// driving it: the very first call with a project-relative path failed.
//
// The fix lets the REAL comparison answer the question, and allows the path
// if EITHER comparison says it is inside. Both the MCP server's guard and
// the CLI's copy are pinned here, because they are two implementations of
// one rule.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertWithinRoot as mcpAssertWithinRoot } from '../../src/core/fs/fs-safety.mjs';
import { assertWithinRoot as cliAssertWithinRoot } from '../../../cli/lib/store.js';

const GUARDS = [
  ['the MCP server', mcpAssertWithinRoot],
  ['the CLI', cliAssertWithinRoot],
];

let base;
let realProject;
let linkedProject;

test('setup: a project reached through a symlink', () => {
  base = mkdtempSync(join(tmpdir(), 'archgen-spelling-'));
  const project = join(base, 'real-project');
  mkdirSync(join(project, '.archgen', 'demo'), { recursive: true });
  writeFileSync(join(project, '.archgen', 'demo', 'tasks.yaml'), 'tasks: []\n', 'utf8');

  realProject = realpathSync(project);
  linkedProject = join(base, 'linked-project');
  symlinkSync(project, linkedProject);
});

// AFTER, not a test: a `test()` that deletes the fixture runs in declaration
// order, which would remove it before the assertions that need it.
after(() => {
  rmSync(base, { recursive: true, force: true });
});

for (const [name, guard] of GUARDS) {
  // Each guard gets its OWN fixture names — they run against the same base,
  // and a second `symlinkSync` to the same target would fail with EEXIST.
  const tag = name.replace(/\W+/g, '-');

  test(`${name}: a path inside a symlinked project is NOT an escape`, () => {
    // The root is spelled REAL (as process.cwd() would) and the path is
    // spelled LOGICAL (as the caller would). They name the same place.
    const target = join(linkedProject, '.archgen', 'demo', 'tasks.yaml');
    assert.doesNotThrow(
      () => guard(realProject, target),
      'a valid path inside the project was refused because the two spellings differ',
    );
  });

  test(`${name}: a path inside a symlinked project is allowed either way round`, () => {
    const target = join(realProject, '.archgen', 'demo', 'tasks.yaml');
    assert.doesNotThrow(() => guard(linkedProject, target));
    assert.doesNotThrow(() => guard(realProject, target));
    assert.doesNotThrow(() => guard(linkedProject, join(linkedProject, '.archgen', 'demo', 'tasks.yaml')));
  });

  test(`${name}: a path inside a symlinked project may not exist yet`, () => {
    // The write path case: the file is created AFTER the check.
    const target = join(linkedProject, '.archgen', 'demo', 'not-created-yet.yaml');
    assert.doesNotThrow(() => guard(realProject, target));
  });

  test(`${name}: a genuine escape is still refused`, () => {
    const outside = join(base, `outside-${tag}`);
    mkdirSync(outside, { recursive: true });
    assert.throws(() => guard(realProject, join(outside, 'secret.txt')));
    assert.throws(() => guard(realProject, join(base, '..', 'escape', 'file')));
  });

  test(`${name}: a symlinked parent that redirects outside is still refused`, () => {
    // The whole point of the REAL comparison: lexically inside, but it lands
    // somewhere else.
    const outside = join(base, `elsewhere-${tag}`);
    mkdirSync(outside, { recursive: true });
    const project = join(base, `redirect-project-${tag}`);
    mkdirSync(project, { recursive: true });
    symlinkSync(outside, join(project, 'link'));
    assert.throws(
      () => guard(project, join(project, 'link', 'secret.txt')),
      'a symlinked parent must not redirect a write out of the tree',
    );
  });
}
