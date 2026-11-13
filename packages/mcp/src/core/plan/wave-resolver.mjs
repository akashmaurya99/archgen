// wave-resolver.mjs — topological wave resolver for tasks.yaml.
//
// Extracted verbatim from skill/scripts/next-tasks.mjs (deleted in the
// MCP-first cutover).
//
// Exit-code semantics become typed errors:
//   2 -> CYCLE             (dependency cycle)
//   3 -> OWNERSHIP_CONFLICT (same-wave file_ownership overlap)
//   4 -> INVALID_INPUT     (missing/invalid file)
import { buildGraph, findCycle, computeWaves, findOwnershipConflict, GraphError, ownedPaths } from './graph.mjs';
import { readParsedPlanFile } from './plan-file.mjs';
import { cycle, invalidInput, ownershipConflict } from '../protocol/errors.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * Resolve the executable waves of a task graph.
 *
 * @param {string} file absolute path to tasks.yaml
 * @returns {{waves: Array<Array<{id: string, title: string, status: string, file_ownership: string[]}>>, blockedByFailure: string[]}}
 */
export function resolveWaves(file) {
  const { data } = readParsedPlanFile(file);
  const tasks = data?.tasks;
  if (!Array.isArray(tasks)) throw invalidInput(
    `${file}: missing 'tasks:' sequence`,
    { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file },
  );

  let byId;
  let prerequisites;
  try {
    ({ byId, prerequisites } = buildGraph(tasks));
  } catch (e) {
    if (e instanceof GraphError) throw invalidInput(
      e.message,
      { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file },
    );
    throw e;
  }

  const cyclePath = findCycle(prerequisites);
  if (cyclePath.length) {
    throw cycle(`dependency cycle detected: ${cyclePath.join(' -> ')}`, {
      ...hint({
        action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }),
        reason: 'the validator names every cycle with the ids that form it.',
      }),
      file,
      cycle: cyclePath,
    });
  }

  const { waves, blockedByFailure } = computeWaves(byId, prerequisites);

  for (const wave of waves) {
    const conflict = findOwnershipConflict(wave);
    if (conflict) {
      throw ownershipConflict(
        `file_ownership conflict in same wave: glob '${conflict.glob}' claimed by '${conflict.a}' and '${conflict.b}'`,
        {
          ...hint({
            action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }),
            reason: 'the validator names every same-wave ownership overlap with the tasks that cause it.',
          }),
          file,
          glob: conflict.glob,
          a: conflict.a,
          b: conflict.b,
        },
      );
    }
  }

  return {
    waves: waves.map((w) =>
      w.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        file_ownership: ownedPaths(t),
      }))),
    blockedByFailure,
  };
}

/**
 * Flat, filtered view of the task graph (the `list` action of archgen_tasks).
 *
 * @param {string} file absolute path to tasks.yaml
 * @param {{status?: string|null, module?: string|null}} [opts]
 * @returns {{tasks: Array<Record<string, unknown>>, total: number}}
 */
export function listTasks(file, opts = {}) {
  const { status = null, module = null } = opts;
  const { data } = readParsedPlanFile(file);
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const filtered = tasks.filter((t) => {
    if (status && (t?.status ?? 'pending') !== status) return false;
    if (module) {
      const owned = ownedPaths(t).join(' ');
      if (!owned.includes(module)) return false;
    }
    return true;
  });
  return {
    tasks: filtered.map((t) => ({
      id: t?.id ?? null,
      title: t?.title ?? null,
      status: t?.status ?? 'pending',
      depends_on: Array.isArray(t?.depends_on) ? t.depends_on : [],
      file_ownership: ownedPaths(t),
      artifacts: Array.isArray(t?.artifacts) ? t.artifacts : [],
    })),
    total: filtered.length,
  };
}
