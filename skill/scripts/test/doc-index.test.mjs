// Integration tests for doc-index.mjs — overview tree, backlink queries,
// reference-integrity gate, freshness audit, Mermaid inventory.
// Run: node --test scripts/test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(SCRIPTS, '..', '..');
const REAL_DEMO = join(REPO_ROOT, 'fixtures', 'greenfield-demo', '.archgen', 'demo');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'doc-index-test-')); });
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

// Fully consistent synthetic slug mirroring fixtures/greenfield-demo/.archgen/demo
// (tasks.yaml + architecture.yaml + docs/ + decisions/ + plans/) with TASK ids,
// FR ids, artifact-relative links, one Mermaid diagram, and provenance stamps.
// Fixtures MUST live under `<tmp>/.archgen/<slug>/` — that is the only input
// shape the scope guard accepts (see lib/scope.mjs).
const OLD = new Date('2020-01-01T00:00:00Z'); // frozen mtime: generated_at governs staleness
function writeConsistentDemo() {
  write('.archgen/demo/tasks.yaml', `# schema_version: 1
# generated_at: 2026-08-20T10:00:00.000Z
tasks:
  - {id: TASK-01, title: Scaffold, depends_on: [], file_ownership: ["src/**"], acceptance: ["ok"]}
  - {id: TASK-02, title: Auth API, depends_on: [TASK-01], file_ownership: ["api/**"], acceptance: ["ok"]}
  - {id: TASK-03, title: Docs, depends_on: [TASK-01], file_ownership: ["docs/**"], acceptance: ["ok"]}
`);
  write('.archgen/demo/architecture.yaml', `# generated_at: 2026-08-19T09:00:00.000Z
name: Demo
slug: demo
modules: []
`);
  write('.archgen/demo/docs/prd.md', `# PRD — Demo Platform

## Requirements

### Authentication
- **FR-AUTH-01**: users log in with email and password.
- **FR-AUTH-02**: sessions expire after 24 hours.

## Flows
See [the container view](c4-container.md) and ../architecture.yaml for module ownership.
`);
  write('.archgen/demo/docs/c4-container.md', `# C4 containers — Demo Platform

\`\`\`mermaid
graph LR
  web[Admin Console]
  api[Notes API]
  db[(Postgres)]
  web --> api
  api --> db
\`\`\`

Session rules implement FR-AUTH-01; decision record: ../decisions/0001-auth-approach.md.
`);
  write('.archgen/demo/decisions/0001-auth-approach.md', `# 0001. Auth approach

Cookie sessions per FR-AUTH-02; no prior decision superseded.
`);
  write('.archgen/demo/plans/auth.md', `<!-- generated_at: 2026-08-21T08:00:00.000Z -->
# Auth delivery plan

Implements TASK-01 then TASK-02; requirement FR-AUTH-01 gates acceptance.
Details in ../docs/prd.md.
`);
  // Freeze every mtime so --stale is decided purely by generated_at comments.
  for (const f of ['tasks.yaml', 'architecture.yaml', 'docs/prd.md', 'docs/c4-container.md', 'decisions/0001-auth-approach.md', 'plans/auth.md']) {
    utimesSync(join(dir, '.archgen', 'demo', f), OLD, OLD);
  }
}

// --- overview ---------------------------------------------------------------
test('overview: sorted tree with H1-H3 headings, levels, 1-based lines, titles, wordCounts', () => {
  writeConsistentDemo();
  const r = run([join(dir, '.archgen', 'demo')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.slug, 'demo');
  assert.equal(out.totalFiles, 4);
  assert.deepEqual(out.files.map((f) => f.path), [
    'demo/decisions/0001-auth-approach.md',
    'demo/docs/c4-container.md',
    'demo/docs/prd.md',
    'demo/plans/auth.md',
  ]);
  const prd = out.files.find((f) => f.path === 'demo/docs/prd.md');
  assert.equal(prd.title, 'PRD — Demo Platform'); // first H1 wins
  assert.deepEqual(prd.headings, [
    { level: 1, text: 'PRD — Demo Platform', line: 1 },
    { level: 2, text: 'Requirements', line: 3 },
    { level: 3, text: 'Authentication', line: 5 },
    { level: 2, text: 'Flows', line: 9 },
  ]);
  assert.equal(prd.wordCount, 36); // whitespace tokens across the whole document
  const adr = out.files.find((f) => f.path === 'demo/decisions/0001-auth-approach.md');
  assert.equal(adr.title, '0001. Auth approach');
});

test('overview: title falls back to filename without an H1; fenced "#" lines are not headings', () => {
  write('.archgen/solo/notes.md', '## Only section\n\n```bash\n# not a heading\n```\n');
  const r = run([join(dir, '.archgen', 'solo')]);
  assert.equal(r.status, 0, r.stderr);
  const f = JSON.parse(r.stdout).files[0];
  assert.equal(f.title, 'notes.md'); // filename fallback
  assert.deepEqual(f.headings, [{ level: 2, text: 'Only section', line: 1 }]); // fence content skipped
});

test('overview: BOM + CRLF input parses identically to plain LF (byte-equal stdout)', () => {
  const body = '# Title\n\n## Sub\nsome words here\n';
  write('.archgen/crlf/doc.md', '\uFEFF' + body.replace(/\n/g, '\r\n'));
  write('.archgen/lf/doc.md', body);
  const a = run([join(dir, '.archgen', 'crlf')]);
  const b = run([join(dir, '.archgen', 'lf')]);
  assert.equal(a.status, 0, a.stderr);
  // Slug/dir names differ by design; every content-derived field must match.
  const norm = (s) => { const o = JSON.parse(s); o.slug = 'X'; o.files[0].path = 'X/doc.md'; return o; };
  assert.deepEqual(norm(a.stdout), norm(b.stdout), 'BOM/CRLF normalization must yield identical content');
  const h = JSON.parse(a.stdout).files[0].headings;
  assert.deepEqual(h.map((x) => x.line), [1, 3]); // 1-based lines survive normalization
});

test('determinism: identical input produces byte-identical stdout across runs and modes', () => {
  writeConsistentDemo();
  const slug = join(dir, '.archgen', 'demo');
  for (const args of [[], ['--validate'], ['--diagrams'], ['--refs-to', 'FR-AUTH-01']]) {
    const r1 = run([slug, ...args]);
    const r2 = run([slug, ...args]);
    assert.equal(r1.stdout, r2.stdout, `stdout unstable for: ${args.join(' ')}`);
  }
});

// --- refs-to ----------------------------------------------------------------
test('refs-to: finds TASK id mentions in markdown with exact file/line/text', () => {
  writeConsistentDemo();
  const r = run([join(dir, '.archgen', 'demo'), '--refs-to', 'TASK-01']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ref, 'TASK-01');
  assert.deepEqual(out.matches, [{
    file: 'demo/plans/auth.md',
    line: 4,
    text: 'Implements TASK-01 then TASK-02; requirement FR-AUTH-01 gates acceptance.',
  }]);
});

test('refs-to: FR ids match definition and reference sites, sorted by file then line', () => {
  writeConsistentDemo();
  const r = run([join(dir, '.archgen', 'demo'), '--refs-to', 'FR-AUTH-01']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => [m.file, m.line]), [
    ['demo/docs/c4-container.md', 12],
    ['demo/docs/prd.md', 6],
    ['demo/plans/auth.md', 4],
  ]);
});

test('refs-to: ADR numbers match prose and path forms; artifact paths match through ../ prefixes', () => {
  writeConsistentDemo();
  let r = run([join(dir, '.archgen', 'demo'), '--refs-to', '0001']);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => [m.file, m.line]), [
    ['demo/decisions/0001-auth-approach.md', 1],
    ['demo/docs/c4-container.md', 12],
  ]);
  r = run([join(dir, '.archgen', 'demo'), '--refs-to', '../architecture.yaml']);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => [m.file, m.line]), [['demo/docs/prd.md', 10]]);
  r = run([join(dir, '.archgen', 'demo'), '--refs-to', 'docs/prd.md']);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => [m.file, m.line]), [['demo/plans/auth.md', 5]]);
});

test('refs-to: whole-word rule rejects TASK-055 when querying TASK-05; zero hits exit 0', () => {
  write('.archgen/solo/p.md', 'Mentions TASK-055 and XTASK-05 but never the real one.\nTASK-05 alone here.\n');
  let r = run([join(dir, '.archgen', 'solo'), '--refs-to', 'TASK-05']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => m.line), [2]);
  r = run([join(dir, '.archgen', 'solo'), '--refs-to', 'NOTHING-MATCHES']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).matches, []);
});

// --- validate ---------------------------------------------------------------
test('validate: fully consistent fixture passes with exact checked counts (exit 0)', () => {
  writeConsistentDemo();
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.checked, { taskRefs: 2, frRefs: 2, links: 4, mermaidFences: 2 });
  assert.deepEqual(out.broken, []);
});

test('validate: catches all four broken classes — unknown TASK, unknown FR, dangling link, odd fences', () => {
  writeConsistentDemo();
  write('.archgen/demo/plans/auth.md', `<!-- generated_at: 2026-08-21T08:00:00.000Z -->
# Auth delivery plan

Implements TASK-01 then TASK-02; requirement FR-AUTH-01 gates acceptance.
Details in ../docs/missing.md.
Blocked by TASK-99.
Covers FR-PAY-01.
`);
  write('.archgen/demo/docs/c4-container.md', `# C4 containers — Demo Platform

\`\`\`mermaid
graph LR
  web[Admin Console]
\`\`\`

stray fence below breaks parity

\`\`\`
never closed
`);
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.broken, [
    { kind: 'mermaid', ref: 'unbalanced fences (3)', file: 'demo/docs/c4-container.md', line: 10 },
    { kind: 'link', ref: '../docs/missing.md', file: 'demo/plans/auth.md', line: 5 },
    { kind: 'task', ref: 'TASK-99', file: 'demo/plans/auth.md', line: 6 },
    { kind: 'fr', ref: 'FR-PAY-01', file: 'demo/plans/auth.md', line: 7 },
  ]);
  assert.deepEqual(out.checked, { taskRefs: 3, frRefs: 3, links: 3, mermaidFences: 3 });
});

test('validate: FR ids defined anywhere in prd.md resolve references from other docs', () => {
  writeConsistentDemo();
  // FR-AUTH-02 is referenced from decisions/ and defined mid-prd as a plain
  // list item — the pragmatic "defined where it appears in prd.md" rule.
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(JSON.parse(r.stdout).broken.length, 0);
});

test('validate: real greenfield-demo fixture is reference-consistent (exit 0)', () => {
  // The shipped fixture currently contains only tasks.yaml (no markdown
  // artifacts), so it is trivially consistent: zero task/fr/link/fence
  // surface. If docs are ever added to it, re-inspect before trusting this
  // assertion — hardcode nothing blindly.
  const r = run([REAL_DEMO, '--validate']);
  assert.equal(r.status, 0, r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.broken, []);
});

// --- stale ------------------------------------------------------------------
test('stale: flags artifacts older than max(tasks.yaml generated_at, mtime), newest first source', () => {
  writeConsistentDemo();
  const r = run([join(dir, '.archgen', 'demo'), '--stale']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.newestSource, 'tasks.yaml'); // threshold author (2026-08-20T10:00Z)
  assert.deepEqual(out.stale, [
    { file: 'demo/architecture.yaml', generatedAt: '2026-08-19T09:00:00.000Z' }, // older stamp
    { file: 'demo/decisions/0001-auth-approach.md', generatedAt: OLD.toISOString() }, // mtime fallback
    { file: 'demo/docs/c4-container.md', generatedAt: OLD.toISOString() },
    { file: 'demo/docs/prd.md', generatedAt: OLD.toISOString() },
  ]); // plans/auth.md (2026-08-21 stamp) stays fresh despite its frozen old mtime
});

// --- diagrams ---------------------------------------------------------------
test('diagrams: inventory with heading title, node heuristic count, balanced fences', () => {
  writeConsistentDemo();
  const r = run([join(dir, '.archgen', 'demo'), '--diagrams']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagrams, [{
    file: 'demo/docs/c4-container.md',
    startLine: 3,
    title: 'C4 containers — Demo Platform',
    nodeCount: 3, // web[...] api[...] db[(...)] — edge lines do not self-declare nodes
    balanced: true,
  }]);
});

test('diagrams: unclosed fence reports balanced:false; %% comment supplies title absent a heading', () => {
  write('.archgen/solo/d.md', '```mermaid\n%% sourced from answers.yaml\ngraph TB\n  a[Node]\n');
  write('.archgen/solo/e.md', '# Titled\n\n```mermaid\ngraph TB\n  b{Other}\n```\n');
  const r = run([join(dir, '.archgen', 'solo'), '--diagrams']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagrams, [
    { file: 'solo/d.md', startLine: 1, title: 'sourced from answers.yaml', nodeCount: 1, balanced: false },
    { file: 'solo/e.md', startLine: 3, title: 'Titled', nodeCount: 1, balanced: true },
  ]);
});

// --- --file scoping ---------------------------------------------------------
test('--file scopes any mode to one document (repo-root-relative or slug-relative)', () => {
  writeConsistentDemo();
  const slug = join(dir, '.archgen', 'demo');
  let r = run([slug, '--file', 'demo/docs/prd.md']); // repo-root-relative
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.equal(out.totalFiles, 1);
  assert.equal(out.files[0].path, 'demo/docs/prd.md');

  r = run([slug, '--file', 'docs/prd.md']); // slug-relative equivalent
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), out);

  r = run([slug, '--refs-to', 'FR-AUTH-01', '--file', 'demo/plans/auth.md']);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => m.line), [4]); // scoped away prd/c4 hits
});

// --- exit codes & clean errors ----------------------------------------------
test('exit codes: missing dir / bad flag / missing value / mode clash / escaping --file all exit 4', () => {
  writeConsistentDemo();
  const slug = join(dir, '.archgen', 'demo');

  let r = run([join(dir, 'does-not-exist')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /cannot read .*does-not-exist/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'single stderr line');

  assert.equal(run([slug, '--bogus']).status, 4);
  assert.equal(run([slug, '--refs-to']).status, 4);
  assert.equal(run([slug, '--validate', '--stale']).status, 4);
  assert.equal(run([]).status, 4);

  write('.archgen/escape.md', 'outside the slug\n');
  r = run([slug, '--file', '../escape.md']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /outside/);
});

// --- scope guard: ONLY `.archgen/<slug>/` inputs are ever accepted -----------
test('scope: bare tmp dir with a plausible docs tree but no .archgen segment exits 4', () => {
  write('tasks.yaml', 'tasks: []\n');
  write('docs/prd.md', '# PRD\n');
  const r = run([dir]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: sibling plans/ dir with a plausible tasks.yaml/docs tree exits 4', () => {
  write('plans/tasks.yaml', 'tasks: []\n');
  write('plans/docs/prd.md', '# PRD\n');
  const r = run([join(dir, 'plans')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: .archgenx segment (substring, not segment equality) exits 4', () => {
  write('.archgenx/demo/tasks.yaml', 'tasks: []\n');
  const r = run([join(dir, '.archgenx', 'demo')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: symlink inside .archgen pointing outside is judged by its real target — exits 4', () => {
  mkdirSync(join(dir, 'outside-target'));
  writeFileSync(join(dir, 'outside-target', 'tasks.yaml'), 'tasks: []\n');
  mkdirSync(join(dir, '.archgen'));
  symlinkSync(join(dir, 'outside-target'), join(dir, '.archgen', 'linked'));
  const r = run([join(dir, '.archgen', 'linked')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: tasks.yaml under archgen/ (missing dot) exits 4 even as a direct file path', () => {
  write('proj/archgen/demo/tasks.yaml', 'tasks: []\n');
  const r = run([join(dir, 'proj', 'archgen', 'demo', 'tasks.yaml')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

// --- A3: file-inventory dedup by realpath --------------------------------------
test('dedup: symlinked doc aliasing a tracked doc collapses to ONE entry; canonical real spelling kept; duplicatesSkipped reported', () => {
  writeConsistentDemo();
  // Alias sorts lexicographically BEFORE the real file — the non-symlink
  // spelling must still win as canonical.
  symlinkSync(join(dir, '.archgen', 'demo', 'docs', 'prd.md'), join(dir, '.archgen', 'demo', 'docs', 'aaa-alias.md'));
  const slug = join(dir, '.archgen', 'demo');
  let r = run([slug]);
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.equal(out.totalFiles, 4); // not 5
  assert.equal(out.duplicatesSkipped, 1);
  assert.ok(out.files.some((f) => f.path === 'demo/docs/prd.md'), 'canonical real spelling kept');
  assert.ok(!out.files.some((f) => f.path.includes('aaa-alias')), 'alias absent from inventory');

  // Dedup applies to every mode sharing the walker: --refs-to must not double-report.
  r = run([slug, '--refs-to', 'FR-AUTH-01']);
  assert.equal(JSON.parse(r.stdout).matches.filter((m) => m.file === 'demo/docs/prd.md').length, 1);

  // Idempotency: identical input ⇒ byte-identical stdout.
  const again = run([slug]);
  assert.equal(again.stdout, run([slug]).stdout);
});

test('dedup: `/./` noise in the input path yields byte-identical output to the clean spelling', () => {
  writeConsistentDemo();
  const clean = run([join(dir, '.archgen', 'demo')]);
  const noisy = run([join(dir, '.archgen', '.', 'demo')]);
  assert.equal(noisy.status, 0, noisy.stderr);
  assert.equal(noisy.stdout, clean.stdout, 'realpath resolution erases /./ noise');
});

// --- A2: duplicate task ids surface through doc-index --validate too -----------
test('validate: duplicate task ids in tasks.yaml exit 2 with single-line stderr naming the id', () => {
  writeConsistentDemo();
  write('.archgen/demo/tasks.yaml', `tasks:
  - {id: TASK-01, title: First, depends_on: [], file_ownership: ["src/**"], acceptance: ["ok"]}
  - {id: TASK-01, title: Second, depends_on: [], file_ownership: ["api/**"], acceptance: ["ok"]}
`);
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /duplicate task id: TASK-01/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'single stderr line');
});

// --- A4: validate counting semantics -------------------------------------------
test('validate: repeated identical link counts ONCE in checked.links and breaks ONCE at first occurrence', () => {
  writeConsistentDemo();
  write('.archgen/demo/plans/auth.md', `<!-- generated_at: 2026-08-21T08:00:00.000Z -->
# Auth delivery plan

Details in ../docs/missing.md.
Again: [x](../docs/missing.md) and prose ../docs/missing.md path form.
`);
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  const linkBroken = out.broken.filter((b) => b.kind === 'link');
  assert.equal(linkBroken.length, 1, 'each unique broken ref listed once');
  assert.equal(linkBroken[0].line, 4, 'first occurrence line wins');
  // Unique (file,target) pairs across the whole slug: the rewritten auth.md
  // contributes 1, prd.md 2, c4-container.md 1 — occurrences within a file
  // collapse to one ref.
  assert.equal(out.checked.links, 4);
});

test('validate: FR id defined on two prd.md lines is broken kind dup-definition; refs still resolve (no double-flag)', () => {
  writeConsistentDemo();
  write('.archgen/demo/docs/prd.md', `# PRD — Demo Platform

## Requirements

### Authentication
- **FR-AUTH-01**: users log in with email and password.
- **FR-AUTH-01**: duplicated definition of the same id.
- **FR-AUTH-02**: admins manage users.

## Flows
See [the container view](c4-container.md) and ../architecture.yaml for module ownership.
`);
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.broken, [
    { kind: 'dup-definition', ref: 'FR-AUTH-01', file: 'demo/docs/prd.md', line: 6 },
  ]);
  // The decision doc's FR-AUTH-02 reference is unaffected; c4's FR-AUTH-01
  // reference resolves (definition exists) — ambiguity flagged exactly once.
  assert.equal(out.checked.frRefs, 2);
});

test('validate: backlinks (--refs-to) intentionally list EVERY occurrence line while validate lists each broken ref once', () => {
  writeConsistentDemo();
  write('.archgen/demo/plans/auth.md', `<!-- generated_at: 2026-08-21T08:00:00.000Z -->
# Auth delivery plan

Blocked by TASK-99 on this line.
And TASK-99 again on this line.
`);
  let r = run([join(dir, '.archgen', 'demo'), '--refs-to', 'TASK-99']);
  assert.deepEqual(JSON.parse(r.stdout).matches.map((m) => m.line), [4, 5], 'lens mode: every occurrence');

  r = run([join(dir, '.archgen', 'demo'), '--validate']);
  const taskBroken = JSON.parse(r.stdout).broken.filter((b) => b.kind === 'task' && b.ref === 'TASK-99');
  assert.equal(taskBroken.length, 1, 'gate mode: once');
  assert.equal(taskBroken[0].line, 4, 'gate mode: first occurrence line');
});

test('validate: run-twice byte-equality on a fixture WITH duplicates present (overview + validate)', () => {
  writeConsistentDemo();
  symlinkSync(join(dir, '.archgen', 'demo', 'docs', 'prd.md'), join(dir, '.archgen', 'demo', 'docs', 'dup-alias.md'));
  write('.archgen/demo/docs/prd.md', `# PRD — Demo Platform

## Requirements

### Authentication
- **FR-AUTH-01**: users log in with email and password.
- **FR-AUTH-01**: duplicated definition line.
`);
  const slug = join(dir, '.archgen', 'demo');
  for (const args of [[], ['--validate']]) {
    const r1 = run([slug, ...args]);
    const r2 = run([slug, ...args]);
    assert.equal(r1.stdout, r2.stdout, `byte-identical stdout for: ${args.join(' ') || 'overview'}`);
  }
});

// --- C9: warnings + nested-fence guard ------------------------------------------
test('validate: H3 without preceding H2 yields heading-skip warning; exit code unaffected', () => {
  writeConsistentDemo();
  write('.archgen/demo/docs/skippy.md', '# Top\n\n### Jumps straight to H3\n\n## Then an H2\n\n### This one is fine\n');
  const r = run([join(dir, '.archgen', 'demo'), '--validate']);
  assert.equal(r.status, 0, 'warnings are non-fatal');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.warnings, [{ kind: 'heading-skip', file: 'demo/docs/skippy.md', line: 3 }]);
  assert.equal(out.ok, true);
});

test('diagrams: ```mermaid inside an open ```text fence is content — no phantom diagram entry', () => {
  // The ```mermaid line sits INSIDE the still-open text block (CommonMark:
  // info-carrying fences never close a block), so only the real diagram at
  // the bottom may be inventoried.
  write('.archgen/nest/guide.md', [
    '# Guide',
    '',
    '```text',
    'Diagram syntax looks like:',
    '```mermaid',
    'graph TB',
    '  ghost[Phantom Must Not Appear]',
    '(block still open — the fence line above was content)',
    '```',
    '',
    'Real diagram below:',
    '',
    '```mermaid',
    'graph LR',
    '  real[Visible]',
    '```',
    '',
  ].join('\n'));
  const r = run([join(dir, '.archgen', 'nest'), '--diagrams']);
  assert.equal(r.status, 0, r.stderr);
  const diagrams = JSON.parse(r.stdout).diagrams;
  assert.equal(diagrams.length, 1, 'nested fence produced no phantom entry');
  assert.equal(diagrams[0].startLine, 13);
  assert.equal(diagrams[0].title, 'Guide'); // preceding heading of the real block
  assert.equal(diagrams[0].nodeCount, 1);
  assert.equal(diagrams[0].balanced, true);
});

// --- B6: overview truncation guard ------------------------------------------------
test('overview: >100 files truncates deterministically — first 100 sorted, truncated:true, true totalFiles', () => {
  // 101 generated docs + 3 hand-written ones = 104 > 100 triggers the guard.
  for (let i = 1; i <= 101; i++) {
    write(`.archgen/big/gen/f${String(i).padStart(3, '0')}.md`, `# Generated ${i}\nbody text\n`);
  }
  write('.archgen/big/tasks.yaml', 'tasks: []\n'); // non-md: never inventoried
  write('.archgen/big/docs/prd.md', '# PRD\n\n## Section\n');
  write('.archgen/big/docs/arch.md', '# Architecture\n');
  write('.archgen/big/plans/p.md', '# Plan\n');
  const r = run([join(dir, '.archgen', 'big')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.totalFiles, 104); // true post-dedup count
  assert.equal(out.duplicatesSkipped, 0);
  assert.equal(out.truncated, true);
  assert.equal(out.files.length, 100);
  const paths = out.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort(), 'emitted files stay sorted');
  assert.equal(paths[0], 'big/docs/arch.md'); // deterministic head of the sorted list
});

test('overview: exactly 100 files is NOT truncated (boundary)', () => {
  for (let i = 1; i <= 100; i++) {
    write(`.archgen/exact/f${String(i).padStart(3, '0')}.md`, `# F ${i}\n`);
  }
  const r = run([join(dir, '.archgen', 'exact')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.totalFiles, 100);
  assert.equal(out.truncated, false);
  assert.equal(out.files.length, 100);
});

// --- C10: single-line stderr sweep -------------------------------------------------
test('error paths: usage violations emit ONE stderr line each (joined, not multi-line)', () => {
  writeConsistentDemo();
  const slug = join(dir, '.archgen', 'demo');
  // Explicit single-line assertions per path:
  let r = run([slug, '--bogus']);
  assert.equal(r.status, 4);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  r = run([slug, '--validate', '--stale']);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  r = run([]);
  assert.equal(r.stderr.trim().split('\n').length, 1);
  r = run([slug, '--refs-to', '']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /non-empty token/);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});
