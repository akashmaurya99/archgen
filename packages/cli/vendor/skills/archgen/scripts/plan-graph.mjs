#!/usr/bin/env node
// plan-graph.mjs — dependency-graph lens over a plan: overview, task neighborhood,
// Mermaid rendering, module filtering.
// Usage:
//   node plan-graph.mjs <slug-dir-or-tasks.yaml>                     overview JSON
//   node plan-graph.mjs <...> --node TASK-03                         neighborhood JSON
//   node plan-graph.mjs <...> --node TASK-03 --mermaid [--status]    neighborhood Mermaid
//   node plan-graph.mjs <...> --mermaid [--status]                   whole-graph Mermaid
//   node plan-graph.mjs <...> --module <name>                        module filter JSON
// Input is either a `.archgen/<slug>/` directory (finds tasks.yaml inside; also
// reads architecture.yaml modules when present) or a direct path to tasks.yaml.
// Scope-hardened: refuses any input outside .archgen/<slug>/ (see lib/scope.mjs).
// Exit codes: 0 ok · 2 cycle / duplicate task id / dangling depends_on
// (GraphError class) · 4 invalid input/file/flags or oversized render request.
//
// DEDUP GUARANTEES (stateless idempotency): identical input yields byte-
// identical output AND zero duplicated entities inside one output. Duplicate
// depends_on entries (`[A, A]`) collapse to one edge before graph build —
// overview reports how many via `duplicatesCollapsed`, edgeCount counts unique
// edges, and Mermaid can never emit the same `X --> Y` line twice. Duplicate
// task ids are a hard GraphError → exit 2 naming the id.
//
// SCALE GUARDS: every traversal is iterative (explicit stack/queue — no
// recursion on graph depth); whole-graph `--mermaid` refuses graphs over 250
// nodes (exit 4 with a scope-it hint; --node neighborhood and --module views
// stay exempt); JSON emits each title once per node object, never per edge.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './lib/yaml.mjs';
import { buildGraph, findCycle, computeWaves, dedupeDependencies, computeQualityStats, GraphError } from './lib/graph.mjs';
import { resolveSlugInput, ScopeError } from './lib/scope.mjs';

const USAGE = 'usage: plan-graph.mjs <slug-dir-or-tasks.yaml> [--node <id>] [--mermaid] [--status] [--module <name>]';
// Whole-graph Mermaid above this node count is refused: the text would flood an
// LLM context without adding information. Scoped renders stay exempt.
const MERMAID_WHOLE_MAX_NODES = 250;
function die(msg, code = 4) { console.error(msg); process.exit(code); }

// --- argument parsing -------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { input: null, node: null, mermaid: false, status: false, module: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--node') opts.node = argv[++i];
  else if (a === '--mermaid') opts.mermaid = true;
  else if (a === '--status') opts.status = true;
  else if (a === '--module') opts.module = argv[++i];
  else if (a.startsWith('--')) die(`${USAGE} — unknown option '${a}'`);
  else if (opts.input === null) opts.input = a;
  else die(`${USAGE} — unexpected extra argument '${a}'`);
}
if (!opts.input) die(USAGE);
if (opts.node === undefined || opts.module === undefined) die(`${USAGE} — --node/--module require a value`);
if (opts.node === '' || opts.module === '') die(`${USAGE} — --node/--module require a non-empty value`);
if (opts.module !== null && (opts.node !== null || opts.mermaid)) die(`${USAGE} — --module cannot combine with --node/--mermaid`);
if (opts.status && !opts.mermaid) die(`${USAGE} — --status requires --mermaid`);

// --- input resolution -------------------------------------------------------
// The scope gate is the ONLY way in: directory input must be an immediate child
// of a `.archgen` segment, direct-file input must be that slug dir's own
// tasks.yaml; symlinks are judged by their real target. Everything inside runs
// off the resolved absolute root.
let scoped;
try {
  scoped = resolveSlugInput(opts.input);
} catch (e) {
  if (e instanceof ScopeError) die(`plan-graph: ${e.message}`);
  die(`cannot read ${opts.input} (missing or unreadable)`);
}
const planDir = scoped.root; // absolute slug dir for BOTH kinds (tasks.yaml sits directly inside it)
const tasksFile = join(planDir, 'tasks.yaml');
const slug = scoped.slug;

let raw;
try {
  raw = readFileSync(tasksFile, 'utf8');
} catch {
  die(`cannot read ${tasksFile} (missing or unreadable)`);
}
let data;
try {
  ({ data } = parseYaml(raw, { filename: tasksFile }));
} catch (e) {
  die(`${tasksFile}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`);
}
const tasks = data?.tasks;
if (!Array.isArray(tasks)) die(`${tasksFile}: missing 'tasks:' sequence`);

// --- dedup normalization (A1) -----------------------------------------------
// Collapse duplicate depends_on entries BEFORE graph build so every downstream
// view (adjacency, waves, Mermaid, counts) sees each edge exactly once.
const { tasks: uniqueTasks, duplicatesCollapsed } = dedupeDependencies(tasks);
const quality = computeQualityStats(uniqueTasks); // facts only — never fails

// --- shared engine ----------------------------------------------------------
let byId, prerequisites, dependents;
try {
  ({ byId, prerequisites, dependents } = buildGraph(uniqueTasks));
} catch (e) {
  // GraphError class = structurally invalid graph (duplicate task id, dangling
  // depends_on): exit 2 like cycles — the plan is unexecutable, not merely a
  // bad flag. The message names the offending id.
  if (e instanceof GraphError) die(e.message, 2);
  throw e;
}
const cycle = findCycle(prerequisites);
if (cycle.length) die(`dependency cycle detected: ${cycle.join(' -> ')}`, 2);
const { waves } = computeWaves(byId, prerequisites);

// --- helpers ----------------------------------------------------------------
const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** BFS hop-distances from start across an adjacency map (start itself at 0). */
function bfsDistances(start, adjacency) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) ?? []) {
      if (!dist.has(next)) { dist.set(next, dist.get(cur) + 1); queue.push(next); }
    }
  }
  return dist;
}

/** Transitive neighborhood at distance >= 1, sorted by distance then id. */
function neighborhood(start, adjacency) {
  return [...bfsDistances(start, adjacency)]
    .filter(([id]) => id !== start)
    .map(([id, distance]) => ({ id, title: byId.get(id).title, status: byId.get(id).status, distance }))
    .sort((a, b) => a.distance - b.distance || byIdAsc(a, b));
}

// Local copy of lib/graph.mjs's internal glob-overlap heuristic: it is not
// exported upstream and existing files must not be modified, so --module keeps
// the exact conservative rules here rather than inventing divergent ones.
function globsMayOverlap(a, b) {
  if (a === b) return true;
  // Deepen the check only when a recursive '**' is involved; plain literal
  // globs keep the cheap equality rule above.
  if (!a.includes('**') && !b.includes('**')) return false;
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === y) continue;
    if (x === '**' || y === '**') return true; // '**' swallows any divergence below it
    if (x.includes('*') || y.includes('*') || x.includes('?') || y.includes('?')) return true; // uncertain -> flag
    return false; // both segments literal and different: paths diverge here
  }
  return true; // one pattern is a segment-prefix of the other
}

// architecture.yaml is optional enrichment; a PRESENT-but-unparseable one is
// refused loudly — silent data loss is the corruption class this repo guards
// against everywhere else (see lib/yaml.mjs).
function readModuleNames(dir) {
  if (!dir) return null;
  const p = join(dir, 'architecture.yaml');
  let archRaw;
  try {
    archRaw = readFileSync(p, 'utf8');
  } catch {
    return null; // absent: fine, overview simply omits modules
  }
  let parsed;
  try {
    parsed = parseYaml(archRaw, { filename: p }).data;
  } catch (e) {
    die(`${p}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`);
  }
  const mods = parsed?.modules;
  if (!Array.isArray(mods)) return null;
  return mods.map((m) => m?.name).filter((n) => typeof n === 'string' && n !== '').sort();
}

// --- Mermaid rendering ------------------------------------------------------
// Tasteful, professional palette; only done/running/failed get classes — every
// other status (pending, ready, blocked) renders with Mermaid's default look.
const MERMAID_CLASSES = {
  done: 'fill:#e8f5e9,stroke:#2e7d32,stroke-width:1.5px',
  running: 'fill:#e3f2fd,stroke:#1565c0,stroke-width:1.5px',
  failed: 'fill:#ffebee,stroke:#c62828,stroke-width:1.5px',
};
const FOCUS_CLASS = 'fill:#fff8e1,stroke:#b45309,stroke-width:2px';

const esc = (s) => String(s).replace(/"/g, "'");
const shortTitle = (t) => {
  const s = String(t.title ?? '');
  return s.length > 36 ? `${s.slice(0, 35).trimEnd()}…` : s;
};
const nodeDecl = (t) => `${t.id}["${esc(t.id)} ${esc(shortTitle(t))}"]`;

/** classDef lines for the given class names, in fixed order (focus first). */
function classDefLines(classNames) {
  const lines = [];
  if (classNames.includes('focus')) lines.push(`  classDef focus ${FOCUS_CLASS};`);
  for (const cls of Object.keys(MERMAID_CLASSES)) {
    if (classNames.includes(cls)) lines.push(`  classDef ${cls} ${MERMAID_CLASSES[cls]};`);
  }
  return lines;
}

/** One `class` statement per styled status over `ids`, sorted — deterministic. */
function statusClassLines(ids) {
  const lines = [];
  for (const cls of Object.keys(MERMAID_CLASSES)) {
    const members = ids.filter((id) => byId.get(id)?.status === cls);
    if (members.length) lines.push(`  class ${members.join(',')} ${cls};`);
  }
  return lines;
}

/** Deduped [prerequisite, dependent] pairs, sorted lexicographically. */
function allEdges() {
  const seen = new Set();
  const edges = [];
  for (const [prereq, deps] of dependents) {
    for (const dep of deps) {
      const key = `${prereq}\u0000${dep}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([prereq, dep]);
    }
  }
  return edges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
}

function wholeMermaid() {
  const ids = uniqueTasks.map((t) => t.id).sort();
  const lines = [
    'flowchart LR',
    ...(opts.status ? classDefLines(Object.keys(MERMAID_CLASSES)) : []),
    ...ids.map((id) => `  ${nodeDecl(byId.get(id))}`),
    // allEdges() is deduped by construction (and normalized upstream), so no
    // `X --> Y` line can ever repeat here.
    ...allEdges().map(([a, b]) => `  ${a} --> ${b}`),
  ];
  if (opts.status) lines.push(...statusClassLines(ids));
  return lines.join('\n');
}

function neighborhoodMermaid(focus) {
  const up = [...bfsDistances(focus.id, prerequisites)].filter(([id]) => id !== focus.id).map(([id]) => id).sort();
  const down = [...bfsDistances(focus.id, dependents)].filter(([id]) => id !== focus.id).map(([id]) => id).sort();
  const lines = ['flowchart LR', ...classDefLines(opts.status ? ['focus', ...Object.keys(MERMAID_CLASSES)] : ['focus'])];
  if (up.length) lines.push('  subgraph upstream', ...up.map((id) => `    ${nodeDecl(byId.get(id))}`), '  end');
  lines.push(`  ${nodeDecl(focus)}`);
  if (down.length) lines.push('  subgraph downstream', ...down.map((id) => `    ${nodeDecl(byId.get(id))}`), '  end');
  const visible = new Set([focus.id, ...up, ...down]);
  lines.push(...allEdges()
    .filter(([a, b]) => visible.has(a) && visible.has(b))
    .map(([a, b]) => `  ${a} --> ${b}`));
  lines.push(`  class ${focus.id} focus;`);
  if (opts.status) lines.push(...statusClassLines([...up, ...down]));
  return lines.join('\n');
}

// --- modes ------------------------------------------------------------------
if (opts.node !== null) {
  const t = byId.get(opts.node);
  if (!t) die(`no task '${opts.node}' in ${tasksFile}`);
  if (opts.mermaid) {
    console.log(neighborhoodMermaid(t));
  } else {
    console.log(JSON.stringify({
      id: t.id,
      title: t.title,
      status: t.status,
      upstream: neighborhood(t.id, prerequisites),
      downstream: neighborhood(t.id, dependents),
      // Peers only — the node itself is already the subject of the report.
      sameWave: (waves.find((w) => w.some((n) => n.id === t.id)) ?? [])
        .filter((n) => n.id !== t.id).map((n) => n.id).sort(),
      ownedFiles: [...(t.file_ownership ?? [])].sort(),
      acceptanceCount: Array.isArray(t.acceptance) ? t.acceptance.length : 0,
      artifacts: [...(t.artifacts ?? [])].sort(),
    }, null, 2));
  }
} else if (opts.mermaid) {
  // Scale guard (B6): whole-graph renders above the node ceiling are refused
  // with an actionable hint; --node neighborhood and --module views below stay
  // exempt because their output is bounded by the scope, not the graph.
  const nodeCount = uniqueTasks.length;
  if (nodeCount > MERMAID_WHOLE_MAX_NODES) {
    die(`graph too large to render whole (${nodeCount} nodes) — scope it: --node <id> | --module <name> | --file <path>`);
  }
  console.log(wholeMermaid());
} else if (opts.module !== null) {
  // Module filter: a task plausibly touches module <name> when any ownership
  // glob may overlap "<name>/**" — conservative, same rules as the same-wave
  // clash detector in lib/graph.mjs.
  const pattern = `${opts.module}/**`;
  const matched = uniqueTasks
    .filter((t) => (t.file_ownership ?? []).some((g) => globsMayOverlap(g, pattern)))
    .sort(byIdAsc);
  console.log(JSON.stringify({
    module: opts.module,
    tasks: matched.map((t) => ({ id: t.id, title: t.title, status: t.status, file_ownership: t.file_ownership })),
  }, null, 2));
} else {
  const out = {
    slug,
    taskCount: uniqueTasks.length,
    // Unique edges post-dedup (raw depends_on entries that collapsed are
    // reported separately as duplicatesCollapsed).
    edgeCount: uniqueTasks.reduce((n, t) => n + (Array.isArray(t.depends_on) ? t.depends_on.length : 0), 0),
    duplicatesCollapsed,
    // Facts, not verdicts — verify-plan.mjs owns pass/fail.
    quality,
    waves: waves.map((w) => w.map((t) => ({ id: t.id, status: t.status }))),
    roots: uniqueTasks.filter((t) => prerequisites.get(t.id).length === 0).map((t) => t.id).sort(),
    leaves: uniqueTasks.filter((t) => (dependents.get(t.id) ?? []).length === 0).map((t) => t.id).sort(),
  };
  const modules = readModuleNames(planDir);
  if (modules) out.modules = modules;
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------
// WHY plan-graph.mjs EXISTS: generic code indexers (GitHub code nav, Sourcegraph,
// CodeGraph-style SQLite MCP servers) model source symbols, not YAML task-DAG edges
// (ast-grep parses YAML ASTs but stays stateless search), so every YAML-DAG system —
// GitLab needs, Buildkite depends_on, Concourse passed, Argo dependencies — ships its
// own schema-specific extractor. This script is archgen's; its Mermaid text renders
// natively on GitHub/GitLab markdown with zero dependencies.
// ---------------------------------------------------------------------------
