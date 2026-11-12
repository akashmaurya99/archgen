// tasks-file.test.mjs — THE task file is resolved, not demanded.
//
// WHY THIS FILE EXISTS.
//
// `archgen_tasks{action:'set_status'}` required `tasksYaml` — a path that is
// always `.archgen/<slug>/tasks.yaml` inside the project the call is about.
// The worker contract taught workers to call it WITHOUT that path, so a
// worker that obeyed the contract exactly was refused on the last step of
// every task ("tasksYaml is required for set_status"). The tool also
// published continuations carrying the caller's own argument — undefined
// when the caller had not passed one — so its own "next call" was a call
// that could not work.
//
// These tests pin the resolution: the explicit path wins, the project
// resolves the active artifact space, an ambiguous project is REPORTED, and
// a project with no plan fails with a typed error that teaches the next call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeSlugDir,
  resolutionWarning,
  resolveTasksFile,
  taskFileCandidates,
} from '../../src/core/fs/tasks-file.mjs';

const TASKS = `tasks:
  - id: T1
    title: api
    depends_on: []
    file_ownership: ["src/**"]
    acceptance: ["ok"]
`;

/**
 * A project with one or more artifact spaces.
 *
 * @param {string[]} slugs the slugs to create
 * @returns {string} the project root
 */
function project(slugs) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-taskfile-'));
  for (const slug of slugs) {
    const dir = join(root, '.archgen', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tasks.yaml'), TASKS, 'utf8');
  }
  return root;
}

test('the explicit path wins — the resolver never second-guesses the caller', () => {
  const root = project(['one']);
  try {
    const explicit = join(root, '.archgen', 'one', 'tasks.yaml');
    const resolved = resolveTasksFile({ tasksYaml: explicit, projectRoot: root });
    assert.equal(resolved.file, explicit);
    assert.equal(resolved.source, 'tasksYaml');
    assert.equal(resolved.ambiguous, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a slug directory names the same file one level down', () => {
  const root = project(['one']);
  try {
    const dir = join(root, '.archgen', 'one');
    const resolved = resolveTasksFile({ tasksYaml: dir, projectRoot: root });
    assert.equal(resolved.file, join(dir, 'tasks.yaml'));
    assert.equal(resolved.source, 'slugDir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a slug name resolves to its artifact space', () => {
  const root = project(['one']);
  try {
    const resolved = resolveTasksFile({ slug: 'one', projectRoot: root });
    assert.equal(resolved.file, join(root, '.archgen', 'one', 'tasks.yaml'));
    assert.equal(resolved.source, 'slug');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the plans directory resolves to the artifact space that owns it', () => {
  const root = project(['one']);
  try {
    const plans = join(root, '.archgen', 'one', 'plans');
    mkdirSync(plans, { recursive: true });
    const resolved = resolveTasksFile({ planDir: plans, projectRoot: root });
    assert.equal(resolved.file, join(root, '.archgen', 'one', 'tasks.yaml'));
    assert.equal(resolved.source, 'planDir');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a project with no path resolves the ACTIVE artifact space', () => {
  const root = project(['one']);
  try {
    const resolved = resolveTasksFile({ projectRoot: root });
    assert.equal(resolved.file, join(root, '.archgen', 'one', 'tasks.yaml'));
    assert.equal(resolved.source, 'active');
    assert.equal(resolved.ambiguous, false);
    assert.equal(resolutionWarning(resolved), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the active artifact space is the most recently modified one', () => {
  const root = project(['older', 'newer']);
  try {
    const older = join(root, '.archgen', 'older', 'tasks.yaml');
    const newer = join(root, '.archgen', 'newer', 'tasks.yaml');
    const past = Date.now() / 1000 - 3600;
    utimesSync(older, past, past);
    utimesSync(newer, new Date(), new Date());
    const resolved = resolveTasksFile({ projectRoot: root });
    assert.equal(resolved.file, newer, 'the active plan is the one that changed last');
    assert.equal(activeSlugDir(root), join(root, '.archgen', 'newer'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an ambiguous project is REPORTED, never resolved silently', () => {
  const root = project(['one', 'two']);
  try {
    const resolved = resolveTasksFile({ projectRoot: root });
    assert.equal(resolved.ambiguous, true, 'two artifact spaces are ambiguous');
    assert.equal(resolved.candidates.length, 2);
    const warning = resolutionWarning(resolved);
    assert.ok(warning, 'the ambiguity is reported');
    assert.match(warning, /tasksYaml/, 'the warning names the argument that resolves it');
    assert.ok(warning.includes(resolved.file), 'the warning names the file that was chosen');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a project with no plan fails TYPED and teaches the next call', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-taskfile-empty-'));
  try {
    assert.throws(
      () => resolveTasksFile({ projectRoot: root, action: 'validate' }),
      (e) => {
        assert.equal(e.code, 'INVALID_INPUT');
        assert.match(e.message, /no \.archgen/, 'the message says what is missing');
        assert.ok(e.details?.nextAction, 'the error names the next call');
        assert.match(e.details.nextAction, /scaffold/, 'the next call creates the plan');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid slug is refused with the rule, not a filesystem error', () => {
  const root = project(['one']);
  try {
    assert.throws(
      () => resolveTasksFile({ slug: '../../etc', projectRoot: root }),
      (e) => {
        assert.equal(e.code, 'INVALID_INPUT');
        assert.match(e.message, /not a valid slug/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the candidates are the artifact spaces that HAVE a task file', () => {
  const root = project(['one']);
  try {
    mkdirSync(join(root, '.archgen', 'empty-space'), { recursive: true });
    const found = taskFileCandidates(root);
    assert.equal(found.length, 1, 'a slug directory without a task file is not a candidate');
    assert.equal(found[0].slug, 'one');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
