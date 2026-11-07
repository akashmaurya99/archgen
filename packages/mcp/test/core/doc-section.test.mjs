// doc-section.test.mjs — the `archgen_docs{action:'section'}` resolver.
//
// WHY THIS FILE EXISTS: the section action treated its whole argument as a
// FILE path. `archgen_docs{action:'digest'}` hands out `sections[].slug` —
// the GitHub-exact heading slug — so the obvious next call, fetching that
// slug, failed on EVERY plan:
//
//   cannot read section non-functional-requirements (missing or not a file)
//
// The agent had to re-join `path` + '#' + `slug` by hand, and nothing — not
// the digest, not the schema, not archgen_help — said so.
//
// The resolver now accepts a bare slug, a path, or a path#anchor, and a miss
// lists what IS available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docIndex } from '../../src/core/doc-navigator.mjs';
import { ArchgenError } from '../../src/core/errors.mjs';

const PRD = `# PRD — Demo platform

## Problem statement & goals
Ship a notes platform.

## Non-functional requirements
- Performance: renders without a network request.
- Accessibility: semantic landmarks, keyboard navigation.

## Success metrics
- p95 response under 200ms.
`;

const GUIDE = `# User guide

## Install
Run the installer.

## First run
Open the console.
`;

/** A `.archgen/demo/` tree with two documents. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-section-'));
  const dir = join(root, '.archgen', 'demo');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'prd.md'), PRD, 'utf8');
  writeFileSync(join(dir, 'docs', 'user-guide.md'), GUIDE, 'utf8');
  return { root, dir };
}

test('a bare section slug resolves — the digest → section round trip', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.dir, { mode: 'section', section: 'non-functional-requirements' });
    assert.equal(out.mode, 'section');
    assert.equal(out.data.anchor, 'non-functional-requirements');
    assert.equal(out.data.title, 'Non-functional requirements');
    assert.match(out.data.text, /Performance/);
    assert.equal(out.data.path, 'demo/docs/prd.md');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a slug also resolves by its title', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.dir, { mode: 'section', section: 'Success metrics' });
    assert.equal(out.data.anchor, 'success-metrics');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a path resolves to the whole file', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.dir, { mode: 'section', section: 'demo/docs/prd.md' });
    assert.match(out.data.text, /Non-functional requirements/);
    assert.ok(out.data.text.includes('Success metrics'));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a path#anchor resolves to exactly that section', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.dir, {
      mode: 'section',
      section: 'demo/docs/prd.md#non-functional-requirements',
    });
    assert.equal(out.data.anchor, 'non-functional-requirements');
    assert.doesNotMatch(out.data.text, /Success metrics/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a slug that matches several documents is reported, never guessed', () => {
  const s = sandbox();
  try {
    // The same heading in two documents.
    writeFileSync(join(s.dir, 'docs', 'other.md'), '# Other\n\n## Install\nDo it.\n', 'utf8');
    const out = docIndex(s.dir, { mode: 'section', section: 'install' });
    assert.equal(out.data.ambiguous, true);
    assert.equal(out.data.matches.length, 2);
    assert.match(out.data.hint, /path#anchor/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a miss lists the available sections — one call is enough to recover', () => {
  const s = sandbox();
  try {
    assert.throws(
      () => docIndex(s.dir, { mode: 'section', section: 'no-such-section' }),
      (e) => {
        assert.ok(e instanceof ArchgenError);
        assert.equal(e.code, 'NOT_FOUND');
        assert.ok(Array.isArray(e.details.available), 'the error must list the available sections');
        assert.ok(e.details.available.some((a) => a.includes('non-functional-requirements')));
        return true;
      },
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a bad anchor in a known file lists that file\'s sections', () => {
  const s = sandbox();
  try {
    assert.throws(
      () => docIndex(s.dir, { mode: 'section', section: 'demo/docs/prd.md#nope' }),
      (e) => {
        assert.equal(e.code, 'NOT_FOUND');
        assert.ok(e.details.available.includes('success-metrics'));
        return true;
      },
    );
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
