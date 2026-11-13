// plan-grapher.mjs — dependency-graph lens over a plan: overview, task
// neighborhood, Mermaid rendering, module filtering.
//
// Extracted verbatim from skill/scripts/plan-graph.mjs (deleted in the
// MCP-first cutover).
//
// DEDUP GUARANTEES (stateless idempotency): identical input yields
// byte-identical output AND zero duplicated entities inside one output.
// Duplicate depends_on entries ([A, A]) collapse to one edge before graph
// build. Duplicate task ids are a hard GraphError.
//
// SCALE GUARDS: every traversal is iterative (explicit stack/queue — no
// recursion on graph depth); whole-graph Mermaid refuses graphs over 250 nodes
// (the text would flood an LLM context without adding information). Scoped
// renders stay exempt.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '../fs/yaml.mjs';
import { buildGraph, findCycle, computeWaves, dedupeDependencies, computeQualityStats, globsMayOverlap, GraphError, ownedPaths } from './graph.mjs';
import { readParsedPlanFile } from './plan-file.mjs';
import { resolveSlugInput, ScopeError } from './scope.mjs';
import { cycle, invalidInput, notFound } from '../protocol/errors.mjs';
import { noSuchTask, hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

// Whole-graph Mermaid above this node count is refused.
const MERMAID_WHOLE_MAX_NODES = 250;

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

/** BFS hop-distances from start across an adjacency map (start itself at 0). */
function bfsDistances(start, adjacency) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) ?? []) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cur) + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

/**
 * Resolve the input to a scoped plan directory + slug.
 * The scope gate is the ONLY way in: a directory input must be an immediate
 * child of a `.archgen` segment, a direct-file input must be that slug dir's
 * own tasks.yaml; symlinks are judged by their real target.
 * @param {string} input
 * @returns {{root: string, slug: string, tasksFile: string}}
 */
export function resolvePlanScope(input, projectRoot = null) {
  let scoped;
  try {
    scoped = resolveSlugInput(input, projectRoot);
  } catch (e) {
    if (e instanceof ScopeError) throw invalidInput(
      `plan-graph: ${e.message}`,
      { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }), reason: "the artifact space names the task file." }), input },
    );
    throw invalidInput(
      `cannot read ${input} (missing or unreadable)`,
      { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), input },
    );
  }
  return { root: scoped.root, slug: scoped.slug, tasksFile: join(scoped.root, 'tasks.yaml') };
}

/**
 * Load + normalize the plan graph.
 *
 * The project root is an EXPLICIT parameter. It used to be read from `opts` —
 * a name that exists only in the CALLER's scope — so every call to this
 * function threw `ReferenceError: opts is not defined` and the whole
 * `archgen_plan{action:'graph'}` action was dead on arrival. A module-level
 * function must never read a variable from its caller's frame.
 *
 * @param {string} input slug dir or tasks.yaml path
 * @param {string|null} projectRoot the project root the artifact space must be inside
 */
function loadPlan(input, projectRoot = null) {
  const { root, slug, tasksFile } = resolvePlanScope(input, projectRoot);

  const { data } = readParsedPlanFile(tasksFile);
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) throw invalidInput(
    `${tasksFile}: missing 'tasks:' sequence`,
    { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file: tasksFile },
  );

  // Collapse duplicate depends_on entries BEFORE graph build so every downstream
  // view (adjacency, waves, Mermaid, counts) sees each edge exactly once.
  const { tasks: uniqueTasks, duplicatesCollapsed } = dedupeDependencies(tasks);
  const quality = computeQualityStats(uniqueTasks); // facts only — never fails

  let byId;
  let prerequisites;
  let dependents;
  try {
    ({ byId, prerequisites, dependents } = buildGraph(uniqueTasks));
  } catch (e) {
    // GraphError = structurally invalid graph (duplicate task id, dangling
    // depends_on): the plan is unexecutable, not merely a bad flag.
    if (e instanceof GraphError) {
      throw cycle(e.message, {
        ...hint({
          action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }),
          reason: 'the validator names every structural defect with the ids that cause it.',
        }),
        file: tasksFile,
      });
    }
    throw e;
  }
  const cyclePath = findCycle(prerequisites);
  if (cyclePath.length) {
    throw cycle(`dependency cycle detected: ${cyclePath.join(' -> ')}`, {
      ...hint({
        action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }),
        reason: 'the validator names every cycle with the ids that form it.',
      }),
      file: tasksFile,
      cycle: cyclePath,
    });
  }
  const { waves } = computeWaves(byId, prerequisites);

  return { root, slug, tasksFile, uniqueTasks, duplicatesCollapsed, quality, byId, prerequisites, dependents, waves };
}

/** architecture.yaml is optional enrichment; a PRESENT-but-unparseable one is
 *  refused loudly — silent data loss is the corruption class this repo guards
 *  against everywhere else. */
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
    throw invalidInput(
      `${p}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`,
      {
        ...hint({
          action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }),
          reason: 'the architecture file must parse before the graph can name its modules.',
        }),
        file: p,
      },
    );
  }
  const mods = parsed?.modules;
  if (!Array.isArray(mods)) return null;
  return mods.map((m) => m?.name).filter((n) => typeof n === 'string' && n !== '').sort();
}

/** classDef lines for the given class names, in fixed order (focus first). */
/**
 * Whether an ownership glob touches a module.
 *
 * A module is a NAME ("catalog"), and a glob is a path ("src/catalog/**").
 * The two meet when the glob carries a segment equal to the module — and the
 * module may also be given as a path ("src/catalog"), which the conservative
 * overlap rule already answers.
 *
 * @param {string} module
 * @param {string} glob
 * @returns {boolean}
 */
function moduleMatches(module, glob) {
  const name = String(module ?? '');
  if (!name) return false;
  if (globsMayOverlap(glob, `${name}/**`)) return true;
  const segments = String(glob).split('/').filter(Boolean);
  return segments.some((s) => s === name || s === `${name}.*` || s === `${name}.md`);
}

function classDefLines(classNames) {
  const lines = [];
  if (classNames.includes('focus')) lines.push(`  classDef focus ${FOCUS_CLASS};`);
  for (const cls of Object.keys(MERMAID_CLASSES)) {
    if (classNames.includes(cls)) lines.push(`  classDef ${cls} ${MERMAID_CLASSES[cls]};`);
  }
  return lines;
}

/** One `class` statement per styled status over `ids`, sorted — deterministic. */
function statusClassLines(ids, byId) {
  const lines = [];
  for (const cls of Object.keys(MERMAID_CLASSES)) {
    const members = ids.filter((id) => byId.get(id)?.status === cls);
    if (members.length) lines.push(`  class ${members.join(',')} ${cls};`);
  }
  return lines;
}

/** Deduped [prerequisite, dependent] pairs, sorted lexicographically. */
function allEdges(dependents) {
  const seen = new Set();
  const edges = [];
  for (const [prereq, deps] of dependents) {
    for (const dep of deps) {
      // NUL separator: plain concatenation would collide ("A"+"BC" vs "AB"+"C").
      const key = `${prereq}\u0000${dep}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([prereq, dep]);
    }
  }
  return edges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
}

/**
 * Render the dependency graph of a plan.
 *
 * @param {string} input slug dir or tasks.yaml path
 * @param {{node?: string|null, mermaid?: boolean, status?: boolean, module?: string|null}} [opts]
 * @returns {{format: 'json'|'mermaid', data: unknown}}
 */
export function planGraph(input, opts = {}) {
  const node = opts.node ?? null;
  const mermaid = opts.mermaid === true;
  const status = opts.status === true;
  const module = opts.module ?? null;

  if (module !== null && (node !== null || mermaid)) {
    throw invalidInput(
      'module cannot combine with node/mermaid',
      {
        ...hint({
          action: toolCall('archgen_plan', { action: 'graph', tasksYaml: '<tasks.yaml>', node: '<task id>' }),
          reason: 'scope the graph to one task.',
        }),
      },
    );
  }
  if (status && !mermaid) {
    throw invalidInput(
      'status requires mermaid',
      {
        ...hint({
          action: toolCall('archgen_plan', { action: 'graph', tasksYaml: '<tasks.yaml>', format: 'mermaid' }),
          reason: 'status styling applies to the mermaid rendering only.',
        }),
      },
    );
  }

  const plan = loadPlan(input, opts.projectRoot ?? null);
  const { uniqueTasks, duplicatesCollapsed, quality, byId, prerequisites, dependents, waves, root, slug, tasksFile } = plan;
  const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  if (node !== null) {
    const t = byId.get(node);
    if (!t) throw noSuchTask(node, uniqueTasks.map((x) => x.id));
    if (mermaid) {
      const up = [...bfsDistances(t.id, prerequisites)].filter(([id]) => id !== t.id).map(([id]) => id).sort();
      const down = [...bfsDistances(t.id, dependents)].filter(([id]) => id !== t.id).map(([id]) => id).sort();
      const lines = [
        'flowchart LR',
        ...classDefLines(status ? ['focus', ...Object.keys(MERMAID_CLASSES)] : ['focus']),
      ];
      if (up.length) lines.push('  subgraph upstream', ...up.map((id) => `    ${nodeDecl(byId.get(id))}`), '  end');
      lines.push(`  ${nodeDecl(t)}`);
      if (down.length) lines.push('  subgraph downstream', ...down.map((id) => `    ${nodeDecl(byId.get(id))}`), '  end');
      const visible = new Set([t.id, ...up, ...down]);
      lines.push(
        ...allEdges(dependents)
          .filter(([a, b]) => visible.has(a) && visible.has(b))
          .map(([a, b]) => `  ${a} --> ${b}`),
      );
      lines.push(`  class ${t.id} focus;`);
      if (status) lines.push(...statusClassLines([...up, ...down], byId));
      return { format: 'mermaid', data: lines.join('\n') };
    }

    /** Transitive neighborhood at distance >= 1, sorted by distance then id. */
    const neighborhood = (start, adjacency) =>
      [...bfsDistances(start, adjacency)]
        .filter(([id]) => id !== start)
        .map(([id, distance]) => ({ id, title: byId.get(id).title, status: byId.get(id).status, distance }))
        .sort((a, b) => a.distance - b.distance || byIdAsc(a, b));

    return {
      format: 'json',
      data: {
        id: t.id,
        title: t.title,
        status: t.status,
        upstream: neighborhood(t.id, prerequisites),
        downstream: neighborhood(t.id, dependents),
        // Peers only — the node itself is already the subject of the report.
        sameWave: (waves.find((w) => w.some((n) => n.id === t.id)) ?? [])
          .filter((n) => n.id !== t.id)
          .map((n) => n.id)
          .sort(),
        ownedFiles: [...ownedPaths(t)].sort(),
        acceptanceCount: Array.isArray(t.acceptance) ? t.acceptance.length : 0,
        artifacts: [...(t.artifacts ?? [])].sort(),
      },
    };
  }

  if (mermaid) {
    // Scale guard: whole-graph renders above the node ceiling are refused with
    // an actionable hint; scoped views stay exempt because their output is
    // bounded by the scope, not the graph.
    const nodeCount = uniqueTasks.length;
    if (nodeCount > MERMAID_WHOLE_MAX_NODES) {
      // The hint must name a combination that WORKS. It used to suggest
      // `module <name>`, which the tool refuses with mermaid — a dead end on
      // the documented path.
      throw invalidInput(
        `graph too large to render whole (${nodeCount} nodes) — scope it: node <id>`, { ...hint({ action: toolCall('archgen_plan', { action: 'graph', tasksYaml: '<tasks.yaml>', node: '<task id>' }), reason: "scope the graph to one task." }), nodes: nodeCount, max: MERMAID_WHOLE_MAX_NODES });
    }
    const ids = uniqueTasks.map((t) => t.id).sort();
    const lines = [
      'flowchart LR',
      ...(status ? classDefLines(Object.keys(MERMAID_CLASSES)) : []),
      ...ids.map((id) => `  ${nodeDecl(byId.get(id))}`),
      // allEdges() is deduped by construction, so no `X --> Y` line can repeat.
      ...allEdges(dependents).map(([a, b]) => `  ${a} --> ${b}`),
    ];
    if (status) lines.push(...statusClassLines(ids, byId));
    return { format: 'mermaid', data: lines.join('\n') };
  }

  if (module !== null) {
    // Module filter. The module names the tool PUBLISHES are the
    // architecture's own, so the filter matches a module NAME against the
    // ownership globs — a task owns "src/catalog/**", so it touches the
    // module "catalog". The old filter matched "<name>/**" against the
    // globs, and a module called "catalog" whose tasks own "src/catalog/**"
    // matched nothing at all: a silent zero for a name the tool had just
    // handed the agent.
    const modules = readModuleNames(root) ?? [];
    const matched = uniqueTasks
      .filter((t) => ownedPaths(t).some((g) => moduleMatches(module, g)))
      .sort(byIdAsc);
    if (!matched.length) {
      // A module that matches nothing is a question the tool cannot answer,
      // not an empty plan. The names it knows are in the error.
      throw notFound(
        `no task owns module '${module}'`,
        {
          ...hint({
            action: toolCall('archgen_plan', { action: 'graph', tasksYaml: '<tasks.yaml>' }),
            reason: 'the graph carries every task and the module it owns.',
          }),
          module,
          modules,
          available: uniqueTasks.map((t) => t.id),
        },
      );
    }
    return {
      format: 'json',
      data: {
        module,
        tasks: matched.map((t) => ({ id: t.id, title: t.title, status: t.status, file_ownership: ownedPaths(t) })),
      },
    };
  }

  const out = {
    slug,
    taskCount: uniqueTasks.length,
    // Unique edges post-dedup (raw depends_on entries that collapsed are
    // reported separately as duplicatesCollapsed).
    edgeCount: uniqueTasks.reduce((n, t) => n + (Array.isArray(t.depends_on) ? t.depends_on.length : 0), 0),
    duplicatesCollapsed,
    // Facts, not verdicts — the verifier owns pass/fail.
    quality,
    waves: waves.map((w) => w.map((t) => ({ id: t.id, status: t.status }))),
    roots: uniqueTasks.filter((t) => prerequisites.get(t.id).length === 0).map((t) => t.id).sort(),
    leaves: uniqueTasks.filter((t) => (dependents.get(t.id) ?? []).length === 0).map((t) => t.id).sort(),
  };
  const modules = readModuleNames(root);
  if (modules) out.modules = modules;
  return { format: 'json', data: out };
}
