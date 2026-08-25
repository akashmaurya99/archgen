// graph.mjs — shared dependency-graph utilities for archgen scripts.
// WHY a lib: validate.mjs, next-tasks.mjs and verify-plan.mjs must agree on
// cycle detection and wave semantics; three copies would drift (Metis finding).

/** Build adjacency (prerequisite → dependents) + reverse maps from tasks.
 * Normative semantics: depends_on lists PREREQUISITE ids; a task is ready iff
 * every prerequisite is done; wave 1 = empty depends_on. */
export function buildGraph(tasks) {
  /** @type {Map<string, string[]>} prereq -> [dependent ids] */
  const dependents = new Map();
  /** @type {Map<string, string[]>} id -> prerequisite ids */
  const prerequisites = new Map();
  const byId = new Map();
  for (const t of tasks) {
    if (byId.has(t.id)) throw new GraphError(`duplicate task id: ${t.id}`);
    byId.set(t.id, t);
    prerequisites.set(t.id, Array.isArray(t.depends_on) ? t.depends_on : []);
  }
  for (const t of tasks) {
    for (const dep of prerequisites.get(t.id)) {
      if (!byId.has(dep)) throw new GraphError(`dangling depends_on reference: '${t.id}' depends on unknown task '${dep}'`);
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(t.id);
    }
  }
  return { byId, prerequisites, dependents };
}

export class GraphError extends Error {}

/** Return an array of ids forming a cycle (empty if acyclic). Iterative DFS. */
export function findCycle(prerequisites) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();
  for (const id of prerequisites.keys()) color.set(id, WHITE);

  for (const start of prerequisites.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack = [[start, 0]];
    color.set(start, GRAY);
    while (stack.length) {
      const [id, pi] = stack[stack.length - 1];
      const deps = prerequisites.get(id);
      if (pi < deps.length) {
        stack[stack.length - 1] = [id, pi + 1];
        const d = deps[pi];
        if (!color.has(d)) continue; // dangling handled elsewhere
        if (color.get(d) === GRAY) {
          // Found a back-edge: reconstruct the cycle path d ← id ← … ← d
          const cycle = [d];
          let cur = id;
          while (cur !== d) { cycle.push(cur); cur = parent.get(cur); }
          cycle.push(d);
          return cycle.reverse();
        }
        if (color.get(d) === WHITE) { color.set(d, GRAY); parent.set(d, id); stack.push([d, 0]); }
      } else {
        color.set(id, BLACK);
        stack.pop();
      }
    }
  }
  return [];
}

/** Topological waves over NOT-DONE tasks.
 * @param {Map<string,any>} byId
 * @param {Map<string,string[]>} prerequisites
 * @returns {{waves: Array<Array<any>>, blockedByFailure: string[]}}
 * Wave membership: every prerequisite is done. Tasks whose TRANSITIVE
 * prerequisites include any failed task are excluded entirely and reported in
 * blockedByFailure (no silent cascades — orchestrator re-plans around them). */
export function computeWaves(byId, prerequisites) {
  const done = new Set();
  const failed = new Set();
  for (const [id, t] of byId) {
    if (t.status === 'done') done.add(id);
    if (t.status === 'failed') failed.add(id);
  }
  // Propagate failure transitively.
  const blockedByFailure = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of prerequisites) {
      if (blockedByFailure.has(id) || failed.has(id)) continue;
      if (deps.some((d) => failed.has(d) || blockedByFailure.has(d))) {
        blockedByFailure.add(id); changed = true;
      }
    }
  }

  const remaining = [...byId.keys()].filter((id) =>
    !done.has(id) && !failed.has(id) && !blockedByFailure.has(id));
  const waves = [];
  const satisfied = new Set(done);
  let frontier = remaining.filter((id) => prerequisites.get(id).every((d) => satisfied.has(d)));
  const queued = new Set();

  while (frontier.length) {
    frontier.sort(); // deterministic output for identical inputs
    waves.push(frontier.map((id) => byId.get(id)));
    for (const id of frontier) { satisfied.add(id); queued.add(id); }
    const next = [];
    for (const id of remaining) {
      if (queued.has(id) || satisfied.has(id)) continue;
      if (prerequisites.get(id).every((d) => satisfied.has(d))) next.push(id);
    }
    frontier = next;
  }
  return { waves, blockedByFailure: [...blockedByFailure].sort() };
}

/** First ownership conflict inside a single wave, or null.
 * Ownership globs are treated as opaque strings for equality here — two tasks
 * in the same wave must not claim the SAME literal glob (conservative rule that
 * needs no glob-engine dependency). */
export function findOwnershipConflict(wave) {
  const seen = new Map();
  for (const t of wave) {
    for (const g of t.file_ownership ?? []) {
      if (seen.has(g)) return { glob: g, a: seen.get(g), b: t.id };
      seen.set(g, t.id);
    }
  }
  return null;
}
