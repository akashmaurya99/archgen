// Integration tests for plan-graph.mjs — overview, neighborhood, Mermaid, module views.
// Run: node --test scripts/test/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, computeWaves, dedupeDependencies, computeQualityStats } from '../lib/graph.mjs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(SCRIPTS, '..', '..', 'fixtures', 'yaml-corpus');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plan-graph-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'plan-graph.mjs'), ...args], { encoding: 'utf8' });
}
// Fixtures MUST live under `<tmp>/.archgen/<slug>/` — that is the only input
// shape the scope guard accepts (see lib/scope.mjs).
const SLUG = 'demo';
function writeTasks(content) {
  const p = join(dir, '.archgen', SLUG, 'tasks.yaml');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

const LINEAR = `tasks:
  - {id: TASK-01, title: Scaffold project skeleton, depends_on: [], file_ownership: ["src/scaffold/**"], acceptance: ["ok"]}
  - {id: TASK-02, title: Core library modules, depends_on: [TASK-01], file_ownership: ["src/core/**"], acceptance: ["ok"]}
  - {id: TASK-03, title: CLI wire-up and exit codes, depends_on: [TASK-02], file_ownership: ["src/cli/**"], acceptance: ["ok"]}
`;

const DIAMOND = `tasks:
  - {id: BASE, title: Base kernel, status: pending, depends_on: [], file_ownership: ["base/**"], acceptance: ["x"]}
  - {id: LEFT, title: Left branch, status: pending, depends_on: [BASE], file_ownership: ["left/**"], acceptance: ["x"]}
  - {id: RIGHT, title: Right branch, status: pending, depends_on: [BASE], file_ownership: ["right/**"], acceptance: ["x"]}
  - {id: MERGE, title: Merge both branches, status: pending, depends_on: [LEFT, RIGHT], file_ownership: ["merge/**"], acceptance: ["x"]}
`;

test('overview: linear chain counts edges, waves, roots, leaves', () => {
  const p = writeTasks(LINEAR);
  const r = run([p]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.slug, SLUG);
  assert.equal(out.taskCount, 3);
  assert.equal(out.edgeCount, 2);
  assert.deepEqual(out.waves.map((w) => w.map((t) => t.id)), [['TASK-01'], ['TASK-02'], ['TASK-03']]);
  assert.deepEqual(out.roots, ['TASK-01']);
  assert.deepEqual(out.leaves, ['TASK-03']);
});

test('overview: diamond merges two paths into one wave', () => {
  const p = writeTasks(DIAMOND);
  const r = run([p]);
  assert.equal(r.status, 0, r.stderr);
  const waves = JSON.parse(r.stdout).waves.map((w) => w.map((t) => t.id));
  assert.deepEqual(waves, [['BASE'], ['LEFT', 'RIGHT'], ['MERGE']]);
});

test('overview: wave grouping matches lib computeWaves exactly (incl. done-task exclusion)', () => {
  const p = writeTasks(DIAMOND.replace(/BASE, title: Base kernel, status: pending/, 'BASE, title: Base kernel, status: done'));
  const r = run([p]);
  assert.equal(r.status, 0, r.stderr);
  const scriptWaveIds = JSON.parse(r.stdout).waves.map((w) => w.map((t) => t.id));
  // Cross-check against the shared engine directly — the script must not drift.
  const tasks = [{ id: 'BASE', status: 'done', depends_on: [] }, { id: 'LEFT', status: 'pending', depends_on: ['BASE'] }, { id: 'RIGHT', status: 'pending', depends_on: ['BASE'] }, { id: 'MERGE', status: 'pending', depends_on: ['LEFT', 'RIGHT'] }];
  const { byId, prerequisites } = buildGraph(tasks);
  const engineWaveIds = computeWaves(byId, prerequisites).waves.map((w) => w.map((t) => t.id));
  assert.deepEqual(scriptWaveIds, engineWaveIds);
  assert.deepEqual(scriptWaveIds, [['LEFT', 'RIGHT'], ['MERGE']]);
});

test('--node: linear chain reports transitive upstream/downstream with BFS distances', () => {
  const p = writeTasks(LINEAR);
  let r = run([p, '--node', 'TASK-03']);
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.deepEqual(out.upstream.map((u) => [u.id, u.distance]), [['TASK-02', 1], ['TASK-01', 2]]);
  assert.deepEqual(out.downstream, []);

  r = run([p, '--node', 'TASK-01']);
  out = JSON.parse(r.stdout);
  assert.deepEqual(out.downstream.map((d) => [d.id, d.distance]), [['TASK-02', 1], ['TASK-03', 2]]);
  assert.deepEqual(out.upstream, []);
});

test('--node: diamond distances are shortest-path through either branch', () => {
  const p = writeTasks(DIAMOND);
  let r = run([p, '--node', 'MERGE']);
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.deepEqual(out.upstream.map((u) => [u.id, u.distance]), [['LEFT', 1], ['RIGHT', 1], ['BASE', 2]]);

  r = run([p, '--node', 'BASE']);
  out = JSON.parse(r.stdout);
  assert.deepEqual(out.downstream.map((d) => [d.id, d.distance]), [['LEFT', 1], ['RIGHT', 1], ['MERGE', 2]]);
});

test('--node: carries ownedFiles, acceptanceCount, artifacts, sameWave peers', () => {
  const p = writeTasks(`tasks:
  - {id: A, title: Alpha, status: pending, depends_on: [], file_ownership: ["b/**", "a/**"], artifacts: ["docs/z.md", "docs/a.md"], acceptance: ["one", "two", "three"]}
  - {id: B, title: Beta, status: pending, depends_on: [A], file_ownership: ["b2/**"], acceptance: ["x"]}
`);
  const r = run([p, '--node', 'A']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.ownedFiles, ['a/**', 'b/**']); // sorted, not author order
  assert.deepEqual(out.artifacts, ['docs/a.md', 'docs/z.md']);
  assert.equal(out.acceptanceCount, 3);
  assert.deepEqual(out.sameWave, []); // peers only; A is alone in wave 1
});

test('--node: unknown task id exits 4 with clean stderr', () => {
  const p = writeTasks(LINEAR);
  const r = run([p, '--node', 'TASK-99']);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /no task 'TASK-99'/);
});

test('--mermaid: whole graph lists every id, every edge, deterministic across runs', () => {
  const p = writeTasks(DIAMOND);
  const r1 = run([p, '--mermaid']);
  assert.equal(r1.status, 0, r1.stderr);
  const out = JSON.parse(JSON.stringify(r1.stdout)); // snapshot as plain string
  const r2 = run([p, '--mermaid']);
  assert.equal(r1.stdout, r2.stdout, 'output must be stable/deterministic');

  for (const id of ['BASE', 'LEFT', 'RIGHT', 'MERGE']) assert.ok(out.includes(`${id}["${id} `), `node label for ${id}`);
  for (const edge of ['BASE --> LEFT', 'BASE --> RIGHT', 'LEFT --> MERGE', 'RIGHT --> MERGE']) {
    assert.ok(out.includes(edge), `edge ${edge}`);
  }
  assert.match(out, /^flowchart LR\n/);
  assert.ok(!out.includes('classDef'), 'no class styling without --status');
});

test('--mermaid --status: valid classDef lines plus per-status class assignments', () => {
  const p = writeTasks(`tasks:
  - {id: D1, title: Done task, status: done, depends_on: [], file_ownership: ["d/**"], acceptance: ["x"]}
  - {id: R1, title: Running task, status: running, depends_on: [D1], file_ownership: ["r/**"], acceptance: ["x"]}
  - {id: F1, title: Failed task, status: failed, depends_on: [D1], file_ownership: ["f/**"], acceptance: ["x"]}
  - {id: P1, title: Pending task, status: pending, depends_on: [R1, F1], file_ownership: ["p/**"], acceptance: ["x"]}
`);
  const r = run([p, '--mermaid', '--status']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  for (const cls of ['done', 'running', 'failed']) {
    assert.ok(lines.some((l) => new RegExp(`^\\s*classDef ${cls} fill:#`).test(l)), `classDef ${cls}`);
  }
  assert.ok(lines.includes('  class D1 done;'));
  assert.ok(lines.includes('  class R1 running;'));
  assert.ok(lines.includes('  class F1 failed;'));
  assert.ok(!lines.some((l) => l.includes('P1') && l.startsWith('  class ')), 'pending stays default (unstyled)');
});

test('--node --mermaid: subgraph scoping keeps only the neighborhood', () => {
  const p = writeTasks(DIAMOND);
  const r = run([p, '--node', 'LEFT', '--mermaid']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  assert.match(out, /^flowchart LR\n/);
  assert.match(out, /subgraph upstream\n    BASE\[/);
  assert.match(out, /subgraph downstream\n    MERGE\[/);
  assert.ok(out.includes('LEFT["LEFT '), 'focus node present');
  assert.ok(!out.includes('RIGHT'), 'sibling outside neighborhood is absent');
  assert.ok(out.includes('BASE --> LEFT') && out.includes('LEFT --> MERGE'));
  assert.ok(out.includes('class LEFT focus;'), 'focus node highlighted');
});

test('--node --mermaid --status composes: neighbors styled, focus wins for center', () => {
  const p = writeTasks(`tasks:
  - {id: D1, title: Done root, status: done, depends_on: [], file_ownership: ["d/**"], acceptance: ["x"]}
  - {id: M1, title: Focus me, status: pending, depends_on: [D1], file_ownership: ["m/**"], acceptance: ["x"]}
  - {id: U1, title: Failed leaf, status: failed, depends_on: [M1], file_ownership: ["u/**"], acceptance: ["x"]}
`);
  const r = run([p, '--node', 'M1', '--mermaid', '--status']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.ok(lines.includes('  class D1 done;'));
  assert.ok(lines.includes('  class U1 failed;'));
  assert.ok(lines.includes('  class M1 focus;'));
});

test('--module: filters tasks whose ownership globs plausibly touch the module prefix', () => {
  const p = writeTasks(`tasks:
  - {id: CAT, title: Catalog, status: pending, depends_on: [], file_ownership: ["src/features/catalog/api.ts"], acceptance: ["x"]}
  - {id: CART, title: Cart, status: pending, depends_on: [], file_ownership: ["src/features/cart/**"], acceptance: ["x"]}
  - {id: WILD, title: Wildcard owner, status: pending, depends_on: [], file_ownership: ["src/features/cat*/**"], acceptance: ["x"]}
`);
  const r = run([p, '--module', 'src/features/catalog']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.module, 'src/features/catalog');
  assert.deepEqual(out.tasks.map((t) => t.id), ['CAT', 'WILD']); // literal overlap + uncertain wildcard
});

test('--module: zero matches is a valid empty view (exit 0)', () => {
  const p = writeTasks(`tasks:\n  - {id: X, title: x, depends_on: [], file_ownership: ["other/**"], acceptance: ["x"]}\n`);
  const r = run([p, '--module', 'nomatch']);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout).tasks, []);
});

test('exit codes: bad path -> 4, malformed yaml -> 4, cycle -> 2 reusing findCycle message', () => {
  let r = run([join(dir, 'does-not-exist.yaml')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /cannot read/);

  r = run([writeTasks('tasks: [unclosed\n')]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /unparseable YAML/);

  r = run([writeTasks(`tasks:
  - {id: X, title: x, depends_on: [Y], file_ownership: ["x/**"], acceptance: ["x"]}
  - {id: Y, title: y, depends_on: [X], file_ownership: ["y/**"], acceptance: ["x"]}
`), '--mermaid']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dependency cycle detected: X -> Y -> X/);
});

test('slug-directory input: finds tasks.yaml, reads architecture.yaml modules, derives slug', () => {
  const planDir = join(dir, '.archgen', 'demo-shop');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, 'tasks.yaml'), DIAMOND);
  writeFileSync(join(planDir, 'architecture.yaml'), `name: Demo Shop\nslug: demo-shop\nmodules:\n  - name: catalog\n    owns: ["catalog/**"]\n  - name: cart\n    owns: ["cart/**"]\n`);
  const r = run([planDir]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.slug, 'demo-shop');
  assert.deepEqual(out.modules, ['cart', 'catalog']); // sorted names
});

test('slug-directory input without architecture.yaml omits the modules key', () => {
  const planDir = join(dir, '.archgen', 'bare-plan');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, 'tasks.yaml'), LINEAR);
  const r = run([planDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!('modules' in JSON.parse(r.stdout)));
});

test('empty tasks sequence yields valid zeros (exit 0)', () => {
  const r = run([writeTasks('tasks: []\n')]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.taskCount, out.edgeCount], [0, 0]);
  assert.deepEqual(out.waves, []);
  assert.deepEqual(out.roots, []);
  assert.deepEqual(out.leaves, []);
});

test('corpus fixture (copied to tmp, canon untouched): overview over tasks-block.yaml', () => {
  const planDir = join(dir, '.archgen', 'demo-shop');
  mkdirSync(planDir, { recursive: true });
  copyFileSync(join(CORPUS, 'tasks-block.yaml'), join(planDir, 'tasks.yaml'));
  copyFileSync(join(CORPUS, 'architecture.yaml'), join(planDir, 'architecture.yaml'));
  const r = run([planDir]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.slug, 'demo-shop');
  assert.equal(out.taskCount, 3);
  assert.deepEqual(out.waves.map((w) => w.map((t) => t.id)), [['C'], ['B'], ['A']]);
  assert.deepEqual(out.modules, ['cart', 'catalog']);
});

test('flag validation: --status without --mermaid and --module combos exit 4', () => {
  const p = writeTasks(LINEAR);
  assert.equal(run([p, '--status']).status, 4);
  assert.equal(run([p, '--module', 'x', '--node', 'A']).status, 4);
  assert.equal(run([p, '--unknown-flag']).status, 4);
  assert.equal(run([]).status, 4);
});

// --- scope guard: ONLY `.archgen/<slug>/` inputs are ever accepted -----------
test('scope: bare tmp dir with a plausible tasks.yaml but no .archgen segment exits 4', () => {
  writeFileSync(join(dir, 'tasks.yaml'), LINEAR);
  const r = run([dir]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: sibling plans/ dir with a plausible tasks.yaml/docs tree exits 4', () => {
  const plans = join(dir, 'plans');
  mkdirSync(join(plans, 'docs'), { recursive: true });
  writeFileSync(join(plans, 'tasks.yaml'), LINEAR);
  writeFileSync(join(plans, 'docs', 'prd.md'), '# PRD\n');
  const r = run([plans]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: .archgenx segment (substring, not segment equality) exits 4', () => {
  const fake = join(dir, 'proj', '.archgenx', 'demo');
  mkdirSync(fake, { recursive: true });
  writeFileSync(join(fake, 'tasks.yaml'), LINEAR); // valid content must not matter
  const r = run([fake]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: symlink inside .archgen pointing outside is judged by its real target — exits 4', () => {
  const outside = join(dir, 'outside-target');
  mkdirSync(outside);
  writeFileSync(join(outside, 'tasks.yaml'), LINEAR);
  const link = join(dir, '.archgen', 'linked');
  mkdirSync(dirname(link));
  symlinkSync(outside, link);
  const r = run([link]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

test('scope: direct tasks.yaml under archgen/ (missing dot) exits 4', () => {
  const p = join(dir, 'proj', 'archgen', 'demo', 'tasks.yaml');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, LINEAR);
  const r = run([p]);
  assert.equal(r.status, 4);
  assert.match(r.stderr, /\.archgen scope/);
});

// --- A1: depends_on dedup / idempotency --------------------------------------
test('dedup: duplicate depends_on entries collapse — duplicatesCollapsed reported, edgeCount unique, mermaid never repeats an edge line', () => {
  // MERGE lists LEFT twice and RIGHT once → one duplicate collapsed.
  const p = writeTasks(`tasks:
  - {id: BASE, title: Base kernel, depends_on: [], file_ownership: ["base/**"], acceptance: ["x"]}
  - {id: LEFT, title: Left branch, depends_on: [BASE], file_ownership: ["left/**"], acceptance: ["x"]}
  - {id: RIGHT, title: Right branch, depends_on: [BASE], file_ownership: ["right/**"], acceptance: ["x"]}
  - {id: MERGE, title: Merge both branches, depends_on: [LEFT, RIGHT, LEFT], file_ownership: ["merge/**"], acceptance: ["x"]}
`);
  const r = run([p]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.duplicatesCollapsed, 1);
  assert.equal(out.edgeCount, 4); // unique edges, raw list had 5 entries
  const m = run([p, '--mermaid']);
  assert.equal(m.status, 0, m.stderr);
  const edgeLines = m.stdout.split('\n').filter((l) => l.includes('-->'));
  assert.equal(new Set(edgeLines).size, edgeLines.length, 'no duplicated X --> Y line');
  assert.equal(edgeLines.length, 4);
  // Idempotency: identical input ⇒ byte-identical output.
  const r2 = run([p]);
  assert.equal(r.stdout, r2.stdout, 'overview must be byte-stable across runs');
  assert.equal(m.stdout, run([p, '--mermaid']).stdout, 'mermaid must be byte-stable across runs');
});

test('dedup: lib-level dedupeDependencies keeps first occurrence, preserves order, counts collapses', () => {
  const tasks = [
    { id: 'A', depends_on: ['B', 'B', 'C', 'B'] },
    { id: 'X', depends_on: [] },
    { id: 'Y' }, // no depends_on key at all: untouched
  ];
  const { tasks: norm, duplicatesCollapsed } = dedupeDependencies(tasks);
  assert.equal(duplicatesCollapsed, 2);
  assert.deepEqual(norm[0].depends_on, ['B', 'C']);
  assert.deepEqual(norm[1].depends_on, []);
  assert.ok(!('depends_on' in norm[2]));
});

// --- A2: GraphError surfaces as clean exit 2 through the CLI ------------------
test('duplicate task ids exit 2 with a single stderr line naming the id', () => {
  const p = writeTasks(`tasks:
  - {id: DUPE, title: First, depends_on: [], file_ownership: ["a/**"], acceptance: ["x"]}
  - {id: DUPE, title: Second, depends_on: [], file_ownership: ["b/**"], acceptance: ["x"]}
`);
  const r = run([p]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /duplicate task id: DUPE/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'single stderr line');
});

test('dangling depends_on (GraphError class) also maps to exit 2', () => {
  const p = writeTasks(`tasks:
  - {id: LONELY, title: Ghost dep, depends_on: [NOPE], file_ownership: ["a/**"], acceptance: ["x"]}
`);
  const r = run([p]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dangling depends_on reference.*NOPE/);
  assert.equal(r.stderr.trim().split('\n').length, 1, 'single stderr line');
});

// --- C8: quality facts in overview --------------------------------------------
test('quality: emptyOwnership/blankAcceptance surfaced without failing (exit 0)', () => {
  const p = writeTasks(`tasks:
  - {id: OK1, title: Fine, depends_on: [], file_ownership: ["ok/**"], acceptance: ["done"]}
  - {id: BAD1, title: No ownership, depends_on: [], acceptance: ["x"]}
  - {id: BAD2, title: No acceptance, depends_on: [], file_ownership: ["b/**"]}
  - {id: BAD3, title: Empty both, depends_on: [], file_ownership: [], acceptance: []}
`);
  const r = run([p]);
  assert.equal(r.status, 0, r.stderr); // facts only — verifier owns pass/fail
  assert.deepEqual(JSON.parse(r.stdout).quality, { selfDeps: 0, emptyOwnership: 2, blankAcceptance: 2 });
});

test('quality: lib-level computeQualityStats counts selfDeps (CLI cycle gate preempts overview)', () => {
  assert.deepEqual(
    computeQualityStats([{ id: 'S', depends_on: ['S'], file_ownership: ['s/**'], acceptance: ['x'] }, { id: 'T', depends_on: [] }]),
    { selfDeps: 1, emptyOwnership: 1, blankAcceptance: 1 },
  );
});

// --- B6: whole-graph Mermaid scale guard ---------------------------------------
function chainTasks(n) {
  const lines = ['tasks:'];
  for (let i = 1; i <= n; i++) {
    const id = `T${String(i).padStart(3, '0')}`;
    const dep = i > 1 ? `, depends_on: [T${String(i - 1).padStart(3, '0')}]` : '';
    lines.push(`  - {id: ${id}, title: Task ${i}${dep}, file_ownership: ["t${i}/**"], acceptance: ["x"]}`);
  }
  return `${lines.join('\n')}\n`;
}

test('mermaid guard: whole graph over 250 nodes refuses with exact actionable stderr; scoped views exempt', () => {
  const p = writeTasks(chainTasks(251));
  let r = run([p, '--mermaid']);
  assert.equal(r.status, 4);
  assert.equal(r.stderr, 'graph too large to render whole (251 nodes) — scope it: --node <id> | --module <name> | --file <path>\n');

  r = run([p, '--node', 'T130', '--mermaid']); // neighborhood render: exempt
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^flowchart LR\n/);

  r = run([p, '--module', 't130']); // module view: exempt
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).module, 't130');
});

test('mermaid guard: exactly 250 nodes still renders whole (boundary)', () => {
  const p = writeTasks(chainTasks(250));
  const r = run([p, '--mermaid']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n').filter((l) => l.includes('-->')).length, 249);
});

// --- B5: iterative traversals at scale -----------------------------------------
/** 200 chained diamonds × 4 nodes = 800 tasks: BASE_i → L_i,R_i → MERGE_i → BASE_{i+1}. */
function hybridDiamondChain(nDiamonds) {
  const pad = (i) => String(i).padStart(3, '0');
  const lines = ['tasks:'];
  for (let i = 1; i <= nDiamonds; i++) {
    const prev = i > 1 ? `D${pad(i - 1)}-MERGE` : null;
    const deps = prev ? `[${prev}]` : '[]';
    lines.push(`  - {id: D${pad(i)}-BASE, title: Base ${i}, depends_on: ${deps}, file_ownership: ["m${i}/base/**"], acceptance: ["ok"]}`);
    lines.push(`  - {id: D${pad(i)}-LEFT, title: Left ${i}, depends_on: [D${pad(i)}-BASE], file_ownership: ["m${i}/left/**"], acceptance: ["ok"]}`);
    lines.push(`  - {id: D${pad(i)}-RIGHT, title: Right ${i}, depends_on: [D${pad(i)}-BASE], file_ownership: ["m${i}/right/**"], acceptance: ["ok"]}`);
    lines.push(`  - {id: D${pad(i)}-MERGE, title: Merge ${i}, depends_on: [D${pad(i)}-LEFT, D${pad(i)}-RIGHT], file_ownership: ["m${i}/merge/**"], acceptance: ["ok"]}`);
  }
  return `${lines.join('\n')}\n`;
}

test('stress: 800-task chain+diamond hybrid — overview correct, valid JSON, under 2s', () => {
  const p = writeTasks(hybridDiamondChain(200));
  const t0 = Date.now();
  const r = run([p]);
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout); // valid JSON by construction
  assert.equal(out.taskCount, 800);
  assert.equal(out.edgeCount, 5 * 200 - 1); // 4 intra-diamond edges + 1 chain link each; first BASE has none
  assert.equal(out.duplicatesCollapsed, 0);
  assert.equal(out.waves.length, 600); // 3 waves per diamond
  assert.deepEqual(out.roots, ['D001-BASE']);
  assert.deepEqual(out.leaves, ['D200-MERGE']);
  assert.deepEqual(out.quality, { selfDeps: 0, emptyOwnership: 0, blankAcceptance: 0 });
  assert.ok(elapsed < 2000, `overview took ${elapsed}ms, budget 2000ms`);
});

test('stress: mid-graph --node query completes correctly and under 2s on the 800-task fixture', () => {
  writeTasks(hybridDiamondChain(200));
  const p = join(dir, '.archgen', SLUG, 'tasks.yaml');
  const t0 = Date.now();
  const r = run([p, '--node', 'D100-MERGE']);
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.id, 'D100-MERGE');
  assert.equal(out.upstream.length, 399); // diamonds 1..100 minus itself
  assert.equal(out.downstream.length, 400); // diamonds 101..200
  assert.deepEqual(out.upstream.filter((u) => u.distance === 1).map((u) => u.id).sort(), ['D100-LEFT', 'D100-RIGHT']);
  assert.deepEqual(out.upstream.filter((u) => u.distance === 2).map((u) => u.id), ['D100-BASE']);
  assert.ok(elapsed < 2000, `node query took ${elapsed}ms, budget 2000ms`);
});
