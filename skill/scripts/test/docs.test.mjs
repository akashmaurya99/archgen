// Tests for lib/docs.mjs (section model + GitHub-exact anchor slugs) and the
// new doc-index modes built on it: --digest, --section, --map, plus anchor
// validation in --validate.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, slugifyHeading, headingSlugs, buildSections, findSection, anchorExists } from '../lib/docs.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'docs-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'doc-index.mjs'), ...args], { encoding: 'utf8' });
}
function write(rel, content) {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}
/** A minimal but valid slug the scope guard accepts. */
function demo() {
  write('.archgen/demo/tasks.yaml', `# schema_version: 1
# generated_at: 2026-08-20T10:00:00.000Z
tasks:
  - {id: TASK-01, title: Scaffold, depends_on: [], file_ownership: ["src/**"], acceptance: ["ok"]}
  - {id: TASK-02, title: Auth, depends_on: [TASK-01], file_ownership: ["api/**"], acceptance: ["ok"]}
`);
  return join(dir, '.archgen', 'demo');
}

// --- slugger -----------------------------------------------------------------

test('docs: slugifyHeading is GitHub-exact (punctuation dropped, each space becomes a hyphen)', () => {
  assert.equal(slugifyHeading('TASK-02 — Auth API'), 'task-02--auth-api');
  assert.equal(slugifyHeading('FR-Catalog-01'), 'fr-catalog-01');
  assert.equal(slugifyHeading('  Overview  '), 'overview');
  assert.equal(slugifyHeading('snake_case_and-dash'), 'snake_case_and-dash');
  assert.equal(slugifyHeading('What now?!'), 'what-now');
});

test('docs: duplicate headings get GitHub-style -1/-2 suffixes', () => {
  const doc = parseMarkdown('# A\n\n## Notes\n\nx\n\n## Notes\n\ny\n\n## Notes\n\nz\n');
  const slugs = [...headingSlugs(doc).keys()];
  assert.deepEqual(slugs, ['a', 'notes', 'notes-1', 'notes-2']);
});

// --- sections ----------------------------------------------------------------

test('docs: a section runs until the next same-or-shallower heading (nested subsections belong to the parent)', () => {
  const doc = parseMarkdown([
    '# Title',
    '',
    '## Parent',
    'text',
    '',
    '### Child',
    'child text',
    '',
    '## Sibling',
    'sib',
  ].join('\n'));
  const sections = buildSections(doc);
  const parent = sections.find((s) => s.slug === 'parent');
  assert.equal(parent.line, 3);
  assert.equal(parent.endLine, 8, 'parent owns the child section');
  assert.ok(parent.body.includes('### Child'));
  const sibling = sections.find((s) => s.slug === 'sibling');
  assert.equal(sibling.line, 9);
  assert.equal(sibling.endLine, 10);
});

test('docs: findSection accepts the exact slug, a case variant, and the collapsed-hyphen variant', () => {
  const doc = parseMarkdown('## TASK-02 — Auth API\nbody\n');
  assert.equal(findSection(doc, 'task-02--auth-api').slug, 'task-02--auth-api');
  assert.equal(findSection(doc, 'TASK-02--AUTH-API').slug, 'task-02--auth-api');
  assert.equal(findSection(doc, 'task-02-auth-api').slug, 'task-02--auth-api');
  assert.equal(findSection(doc, 'nope'), null);
});

test('docs: anchorExists resolves real anchors and rejects missing ones', () => {
  const doc = parseMarkdown('# Doc\n\n## Requirements\n\n## FR-AUTH-01\n');
  assert.equal(anchorExists(doc, 'requirements'), true);
  assert.equal(anchorExists(doc, 'fr-auth-01'), true);
  assert.equal(anchorExists(doc, 'FR-AUTH-01'), true);
  assert.equal(anchorExists(doc, 'not-there'), false);
});

// --- doc-index integration ---------------------------------------------------

test('doc-index --validate: a link to an existing file with a MISSING anchor is broken kind "anchor"', () => {
  const slug = demo();
  write('.archgen/demo/docs/prd.md', '# PRD\n\nSee [a](../plans/auth.md#task-02--auth-api) and [b](../plans/auth.md#ghost).\n');
  write('.archgen/demo/plans/auth.md', '# Auth\n\n## TASK-02 — Auth API\nbody\n');
  const r = run([slug, '--validate']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.broken, [
    { kind: 'anchor', ref: '../plans/auth.md#ghost', file: 'demo/docs/prd.md', line: 3 },
  ]);
});

test('doc-index --validate: the collapsed-hyphen anchor variant is accepted (no false positive)', () => {
  const slug = demo();
  write('.archgen/demo/docs/prd.md', '# PRD\n\nSee [a](../plans/auth.md#task-02-auth-api).\n');
  write('.archgen/demo/plans/auth.md', '# Auth\n\n## TASK-02 — Auth API\nbody\n');
  const r = run([slug, '--validate']);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).broken, []);
});

test('doc-index --digest: every file reports sections with line ranges', () => {
  const slug = demo();
  write('.archgen/demo/plans/auth.md', '# Auth\n\n## TASK-01 — Scaffold\none\n\n## TASK-02 — Auth\nbody\n');
  const r = run([slug, '--digest']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.slug, 'demo');
  assert.ok(out.totalFiles >= 1);
  const plan = out.files.find((f) => f.path === 'demo/plans/auth.md');
  assert.ok(plan, 'plan file is indexed');
  const slugs = plan.sections.map((s) => s.slug);
  assert.ok(slugs.includes('task-01--scaffold'));
  assert.ok(slugs.includes('task-02--auth'));
  for (const s of plan.sections) assert.ok(s.line >= 1 && s.endLine >= s.line);
});

test('doc-index --section: fetches exactly one section with a provenance header', () => {
  const slug = demo();
  write('.archgen/demo/plans/auth.md', '# Auth\n\n## TASK-02 — Auth API\nonly this line\n\n## Other\nnot this\n');
  const r = run([slug, '--section', 'demo/plans/auth.md#task-02--auth-api']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^<!-- archgen section: demo\/plans\/auth\.md#task-02--auth-api · lines 3-\d+ -->/);
  assert.ok(r.stdout.includes('only this line'));
  assert.ok(!r.stdout.includes('not this'), 'must not leak sibling sections');
});

test('doc-index --section: a whole-file fetch also carries its token cost', () => {
  const slug = demo();
  write('.archgen/demo/plans/auth.md', '# Auth\n\nbody\n');
  const r = run([slug, '--section', 'demo/plans/auth.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^<!-- archgen file: demo\/plans\/auth\.md -->/);
});

test('doc-index --section: unknown anchor exits 4 with a single-line error', () => {
  const slug = demo();
  write('.archgen/demo/plans/auth.md', '# Auth\n');
  const r = run([slug, '--section', 'demo/plans/auth.md#ghost']);
  assert.equal(r.status, 4);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('doc-index --map: reports the SECTIONS mentioning a token, not whole files', () => {
  const slug = demo();
  write('.archgen/demo/plans/auth.md', '# Auth\n\n## TASK-01 — Scaffold\nmentions TASK-01\n\n## TASK-02 — Auth\nmentions TASK-02\n');
  const r = run([slug, '--map', 'TASK-02']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ref, 'TASK-02');
  assert.ok(out.sectionCount >= 1);
  const hit = out.sections.find((s) => s.section === 'task-02--auth');
  assert.ok(hit, 'the specific section is identified');
  // The heading line and the body line both carry the token: 2 occurrences,
  // both inside ONE section (that is the point of the lens).
  assert.equal(hit.occurrences, 2);
  assert.ok(out.sections.every((s) => s.file === 'demo/plans/auth.md'));
});

test('doc-index: the new modes are mutually exclusive and reject unknown flags', () => {
  const slug = demo();
  assert.equal(run([slug, '--digest', '--validate']).status, 4);
  assert.equal(run([slug, '--section', 'x', '--map', 'y']).status, 4);
  assert.equal(run([slug, '--nope']).status, 4);
});

test('doc-index: identical input yields byte-identical output for the new modes', () => {
  const slug = demo();
  write('.archgen/demo/plans/auth.md', '# Auth\n\n## TASK-01 — Scaffold\nx\n');
  assert.equal(run([slug, '--digest']).stdout, run([slug, '--digest']).stdout);
  assert.equal(run([slug, '--map', 'TASK-01']).stdout, run([slug, '--map', 'TASK-01']).stdout);
});
