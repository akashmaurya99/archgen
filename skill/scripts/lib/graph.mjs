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
 * Two rules, both conservative:
 *  1. Literal equality — two tasks must never claim the SAME glob string.
 *  2. Glob intersection — when a '**' is involved, patterns whose non-glob
 *     prefix segments overlap compatibly are flagged (e.g. "src/**" vs a
 *     TypeScript-scoped variant of it). When segment comparison is uncertain
 *     (wildcards), the pair IS flagged: false positives merely force a rename;
 *     false negatives let parallel workers corrupt each other's files.
 */
export function findOwnershipConflict(wave) {
  const seen = new Map();
  const claimed = [];
  for (const t of wave) {
    for (const g of t.file_ownership ?? []) {
      if (seen.has(g)) return { glob: g, a: seen.get(g), b: t.id };
      for (const prev of claimed) {
        if (globsMayOverlap(prev.glob, g)) return { glob: g, a: prev.id, b: t.id };
      }
      seen.set(g, t.id);
      claimed.push({ glob: g, id: t.id });
    }
  }
  return null;
}

/** Conservative may-intersect test for two ownership globs. */
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

// --- additive (hardening pass): dedup normalization + quality surfacing -----

/** Collapse redundant depends_on entries BEFORE graph construction so no
 * downstream consumer can ever see the same edge twice (idempotency: identical
 * input ⇒ byte-identical output with zero duplicated entities).
 * First occurrence wins; order otherwise preserved. Tasks without an array
 * depends_on pass through untouched.
 * @param {Array<any>} tasks
 * @returns {{tasks: Array<any>, duplicatesCollapsed: number}} */
export function dedupeDependencies(tasks) {
  let duplicatesCollapsed = 0;
  const normalized = tasks.map((t) => {
    if (!Array.isArray(t.depends_on)) return t;
    const seen = new Set();
    const deps = [];
    for (const d of t.depends_on) {
      if (seen.has(d)) { duplicatesCollapsed++; continue; }
      seen.add(d);
      deps.push(d);
    }
    return deps.length === t.depends_on.length ? t : { ...t, depends_on: deps };
  });
  return { tasks: normalized, duplicatesCollapsed };
}

/** Data-quality facts computed from parsed data WITHOUT judging them — the
 * verifier owns pass/fail; indexers only surface facts deterministically.
 *  - selfDeps: tasks whose depends_on includes their own id (note: such a task
 *    is also a 1-node cycle, so the CLI cycle gate normally exits 2 first;
 *    the field keeps the shape uniform for lib-level consumers).
 *  - emptyOwnership: missing or empty file_ownership (parallel workers would
 *    have no disjointness contract).
 *  - blankAcceptance: missing or empty acceptance (no objective done-criteria).
 * @param {Array<any>} tasks
 * @returns {{selfDeps: number, emptyOwnership: number, blankAcceptance: number}} */
export function computeQualityStats(tasks) {
  let selfDeps = 0;
  let emptyOwnership = 0;
  let blankAcceptance = 0;
  for (const t of tasks) {
    if (Array.isArray(t.depends_on) && t.depends_on.includes(t.id)) selfDeps++;
    const own = t.file_ownership;
    if (!Array.isArray(own) || own.length === 0) emptyOwnership++;
    const acc = t.acceptance;
    if (!Array.isArray(acc) || acc.length === 0) blankAcceptance++;
  }
  return { selfDeps, emptyOwnership, blankAcceptance };
}
