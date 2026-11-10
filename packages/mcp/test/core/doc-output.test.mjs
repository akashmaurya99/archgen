// doc-output.test.mjs — the tools must not pay for what the caller did not ask
// for.
//
// WHY THIS FILE EXISTS.
//
// Three real defects, all found by measuring every tool's output:
//
//   1. `archgen_docs{action:'section', file: <path>, section: <name>}` — the
//      natural call shape — returned the WHOLE FILE. A file hit with no
//      `#anchor` meant "no section was named", and the separate `section`
//      argument was ignored. An agent asked for one section and paid for the
//      document.
//   2. A section owned its nested subsections, so pulling `## Per-task
//      sections` returned all twenty task sections with it — and the agent
//      then pulled each task AGAIN. The same plan was paid for twice.
//   3. `archgen_docs{action:'index'}` returned every heading's raw TEXT, which
//      the caller cannot act on (fetching needs a slug) — so it paid for an
//      outline and then called `digest` for the same outline with slugs.
//
// The section response now carries the section's OWN content, names its
// children, and reports its size; the overview is a file map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { docIndex } from '../../src/core/doc-navigator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const PLAN = `# Demo plan

## Context

Why now: the system needs it.
What exists: a skeleton.

## Per-task sections

### T1 — module one

Approach:
- build it

### T2 — module two

Approach:
- build it too

## Verification steps

1. the build command
`;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-docout-'));
  const slugDir = join(root, '.archgen', 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  writeFileSync(join(slugDir, 'plans', 'demo.md'), PLAN, 'utf8');
  return { root, slugDir };
}

test('file + section extracts THAT section — it never returns the whole file', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.slugDir, {
      mode: 'section',
      file: 'demo/plans/demo.md',
      section: 'context',
      projectRoot: s.root,
    });
    assert.equal(out.data.anchor, 'context');
    assert.match(out.data.text, /Why now/);
    assert.doesNotMatch(out.data.text, /Per-task sections/, 'the whole file came back');
    assert.doesNotMatch(out.data.text, /Verification steps/);
    assert.ok(out.data.lines < 10, 'the section must be small');
    assert.ok(out.data.bytes > 0);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a section names its nested children instead of dragging them along', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.slugDir, { mode: 'section', section: 'per-task-sections', projectRoot: s.root });
    assert.equal(out.data.anchor, 'per-task-sections');
    assert.doesNotMatch(out.data.text, /build it/, 'the children were included by default');
    assert.equal(out.data.children.length, 2);
    assert.deepEqual(out.data.children.map((c) => c.slug), ['t1--module-one', 't2--module-two']);
    assert.match(out.data.next, /include:'all'/);
    assert.ok(out.data.sectionEndLine > out.data.endLine, 'the full range is still reported');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test("include:'all' returns the whole subtree when the caller really wants it", () => {
  const s = sandbox();
  try {
    const out = docIndex(s.slugDir, {
      mode: 'section',
      section: 'per-task-sections',
      include: 'all',
      projectRoot: s.root,
    });
    assert.match(out.data.text, /build it/);
    assert.equal(out.data.children.length, 2, 'the children are still named');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the overview is a FILE map — the outline lives in the digest', () => {
  const s = sandbox();
  try {
    const out = docIndex(s.slugDir, { mode: 'overview', projectRoot: s.root });
    const file = out.data.files[0];
    assert.equal(file.headings, undefined, 'raw headings are unusable without slugs');
    assert.equal(typeof file.sections, 'number');
    assert.equal(typeof file.words, 'number');
    const digest = docIndex(s.slugDir, { mode: 'digest', projectRoot: s.root });
    assert.ok(digest.data.files[0].sections.length > 0, 'the digest carries the outline');
    assert.ok(digest.data.files[0].sections[0].slug, 'with the slugs the caller can fetch');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the token map carries five short excerpts per section, not the document', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-map-'));
  try {
    const slugDir = join(root, '.archgen', 'demo');
    mkdirSync(join(slugDir, 'docs'), { recursive: true });
    const lines = Array.from({ length: 20 }, (_, i) => `- the module mentions needle ${i} here`);
    writeFileSync(join(slugDir, 'docs', 'prd.md'), `# PRD\n\n## Requirements\n${lines.join('\n')}\n`, 'utf8');
    const out = docIndex(slugDir, { mode: 'map', token: 'needle', projectRoot: root });
    const hits = out.data.sections;
    assert.ok(hits.length >= 1);
    assert.ok(hits[0].matches.length <= 5, 'at most five excerpts per section');
    for (const m of hits[0].matches) assert.ok(m.text.length <= 120, 'the excerpt is short');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
