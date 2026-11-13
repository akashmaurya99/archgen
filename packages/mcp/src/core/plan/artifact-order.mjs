// artifact-order.mjs — the ORDER the artifacts must be written in.
//
// WHY THIS EXISTS.
//
// The ladder's rule array WAS the write order: `profile.artifacts[]` is built
// by iterating those rules verbatim, and the scaffold served the create set
// in that same order. So the tool published an order that put `tasks.yaml`
// FIRST — before the PRD whose `FR-<MODULE>-nn` ids its acceptance lines must
// cite, and before the `architecture.yaml` whose `structure:` and `owns[]` its
// `file_ownership` globs must mirror.
//
// Writing a dependent before its dependency is not a style preference: it is
// a content inconsistency the moment the file is written. The floor proves
// every one of those joins afterwards (REQ_UNKNOWN, PATH_UNOWNED,
// MIRROR_MISSING, DECISION_MISSING, PLAN_TASK_COVERAGE) — one round later,
// after the plan was written, the gate dispatched and the user was asked.
//
// So the edges are DATA now (`dependsOn` in depth-ladder.json) and the order
// is DERIVED from them here. Nothing about the order is stored twice: the
// ladder holds the edges, this module computes the sequence, and the tool
// serves it.
//
// THE THREE STATES OF AN EDGE.
//
//   create   the dependency is in the write set — it must exist first.
//   host     the profile REUSES it — the host document satisfies it, so
//            there is nothing to wait for (cite it; never regenerate it).
//   omitted  the profile does not create it — the edge DISSOLVES.
//
// A dissolved edge is not a missing edge: the artifact is still ordered after
// whatever it does depend on, and the step still reports the dependency so
// the reader can see WHY the order is what it is.
import { invalidInput, cycle } from '../protocol/errors.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * The dependency-ordered write plan for a profile's artifact set.
 *
 * @param {Array<{path: string, pattern?: string|null, decision?: string, purpose?: string|null}>} artifacts
 *   the profile's artifacts, each already carrying its decision
 * @param {Array<{path: string, pattern?: string|null, purpose?: string|null, dependsOn?: Array<object>}>} rules
 *   the ladder's `profile.artifactRules`
 * @returns {{steps: Array<object>, order: string[]}}
 */
export function buildWriteOrder(artifacts, rules) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const ruleList = Array.isArray(rules) ? rules : [];

  // The family a rule speaks in. A dependency names a FAMILY, not a file: the
  // plan may name its files as it likes, and the floor already proves
  // decisions against the family.
  const ruleByFamily = new Map();
  for (const rule of ruleList) {
    const family = String(rule?.pattern ?? '').trim();
    if (family) ruleByFamily.set(family, rule);
  }

  // The create set, in the ladder's rule order. The order is the tie-break of
  // the sort below, so the two can never disagree.
  const created = list.filter((a) => a?.decision === 'create');
  const createdByFamily = new Map();
  for (const a of created) {
    const family = String(a?.pattern ?? '').trim();
    if (family && !createdByFamily.has(family)) createdByFamily.set(family, a);
  }

  // The edges, resolved against the create set.
  const edges = new Map(); // artifact path -> [dependency artifact]
  const steps = new Map(); // artifact path -> the step being built
  const slug = slugOf(list);

  for (const artifact of created) {
    const path = String(artifact?.path ?? '');
    const family = String(artifact?.pattern ?? '').trim();
    const rule = family ? ruleByFamily.get(family) : null;
    const dependsOn = [];
    for (const dep of rule?.dependsOn ?? []) {
      const depFamily = String(dep?.family ?? '').trim();
      if (!depFamily) continue;
      const depRule = ruleByFamily.get(depFamily);
      if (!depRule) {
        // A dependency that names no rule is a DATA defect, and it is
        // reported as one: a silent edge would order the set by a fact
        // nothing can explain.
        throw invalidInput(
          `the artifact rule for '${path}' depends on '${depFamily}', which is not a rule in the depth ladder`,
          {
            ...hint({
              action: toolCall('archgen_setup', { action: 'doctor' }),
              reason: 'the ladder and the artifact rules must agree before any order can be derived.',
            }),
            path,
            family: depFamily,
          },
        );
      }
      const depArtifact = createdByFamily.get(depFamily);
      const state = depArtifact ? 'create' : edgeState(list, depFamily);
      dependsOn.push({
        family: depFamily,
        // The rule's path carries the `<slug>` placeholder; the DEPENDENCY
        // the agent waits for is the plan's own path for it.
        path: depArtifact ? depArtifact.path : resolveSlug(depRule.path, slug),
        hard: dep?.hard === true,
        // The fact to carry forward is only meaningful when the dependency is
        // being WRITTEN. A reused one is satisfied by the host document, and
        // an omitted one has nothing to carry at all — so the text says that
        // instead of describing facts from a file that does not exist.
        carries:
          state === 'create'
            ? String(dep?.carries ?? '')
            : state === 'host'
              ? 'satisfied by the host document'
              : 'the profile omits it',
        state,
      });
    }
    steps.set(path, {
      path,
      family,
      // The purpose is NOT repeated here: the payload's `artifacts` list
      // already carries it, and a step is read for its ORDER and its
      // dependencies.
      dependsOn,
      unlocks: [],
    });
  }

  // The live edges: only a `create` dependency is an edge. A `host` or
  // `omitted` dependency is satisfied without the file existing.
  for (const artifact of created) {
    const path = String(artifact?.path ?? '');
    const deps = steps.get(path)?.dependsOn ?? [];
    edges.set(
      path,
      deps.filter((d) => d.state === 'create').map((d) => String(d.path)),
    );
  }

  // What each step unlocks: the artifacts that wait for it.
  for (const [path, deps] of edges) {
    for (const dep of deps) {
      const step = steps.get(dep);
      if (step) step.unlocks.push(path);
    }
  }

  const order = topologicalOrder(created.map((a) => String(a?.path ?? '')), edges);

  return {
    order,
    steps: order.map((path, i) => {
      const step = steps.get(path);
      return { step: i + 1, ...step };
    }),
  };
}

/**
 * The slug the artifact paths carry (`.archgen/<slug>/...`).
 *
 * @param {Array<{path?: string}>} artifacts
 * @returns {string|null}
 */
function slugOf(artifacts) {
  for (const a of artifacts) {
    const m = /^\.archgen\/([^/]+)\//.exec(String(a?.path ?? ''));
    if (m && !m[1].includes('<')) return m[1];
  }
  return null;
}

/**
 * A rule's path with the plan's slug in it.
 *
 * The rules carry `<slug>`; the plan's paths carry the real one. A
 * dependency that is not being written is still named in the order, and it
 * must not be published with the placeholder in it.
 *
 * @param {string} path
 * @param {string|null} slug
 * @returns {string}
 */
function resolveSlug(path, slug) {
  const p = String(path ?? '');
  return slug ? p.replaceAll('<slug>', slug) : p;
}

/**
 * The state of a dependency the profile does not create.
 *
 * `reuse` is EXTERNAL — the host document satisfies it. Everything else
 * (an `omit`, or a family the profile never listed) is dissolved: there is
 * nothing to wait for.
 *
 * @param {Array<{pattern?: string|null, decision?: string}>} artifacts
 * @param {string} family
 * @returns {'host'|'omitted'}
 */
function edgeState(artifacts, family) {
  const hit = artifacts.find((a) => String(a?.pattern ?? '').trim() === family);
  if (hit && hit.decision === 'reuse') return 'host';
  return 'omitted';
}

/**
 * A deterministic topological order.
 *
 * Kahn's algorithm, tie-broken by the input order: the same inputs always
 * produce the same sequence, and a set with no edges keeps the ladder's
 * order exactly.
 *
 * @param {string[]} nodes
 * @param {Map<string, string[]>} edges node -> the nodes it depends on
 * @returns {string[]}
 */
function topologicalOrder(nodes, edges) {
  const rank = new Map(nodes.map((n, i) => [n, i]));
  const remaining = new Map(nodes.map((n) => [n, new Set(edges.get(n) ?? [])]));
  const out = [];
  while (remaining.size) {
    // The ready node with the LOWEST rank wins, so the result is stable.
    let next = null;
    for (const node of remaining.keys()) {
      if ([...remaining.get(node)].some((d) => remaining.has(d))) continue;
      if (next === null || rank.get(node) < rank.get(next)) next = node;
    }
    if (next === null) {
      const stuck = [...remaining.keys()].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
      throw cycle(
        `the artifact dependencies form a cycle: ${stuck.join(' -> ')}`,
        {
          ...hint({
            action: toolCall('archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug: '<slug>' }),
            reason: 'the ladder declares the dependency edges; a cycle means two artifacts wait for each other.',
          }),
          artifacts: stuck,
        },
      );
    }
    remaining.delete(next);
    out.push(next);
  }
  return out;
}
