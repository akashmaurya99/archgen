// tasks.mjs — the `archgen_tasks` tool: the wave execution loop.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { routingSentence } from '../core/routing.mjs';
import { resolveWaves, listTasks } from '../core/wave-resolver.mjs';
import { buildWorkerContract } from '../core/worker-contract.mjs';
import { matchSkills, findInstalledSkill, skillRules, skillSections } from '../core/skill-manager.mjs';
import { docIndex } from '../core/doc-navigator.mjs';
import { parseYaml } from '../core/yaml.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { loadAsset } from '../context.mjs';
import { setTaskStatus, STATUSES } from '../core/status-mutator.mjs';
import { writeResumeSnapshot } from '../core/resume-snapshot.mjs';
import { invalidInput } from '../core/errors.mjs';
import { hint } from '../core/guidance.mjs';
import { toolCall } from '../core/call.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';
import { resolveSlugInput, ScopeError } from '../core/scope.mjs';
import { dirname, join } from 'node:path';
import { ownedPaths } from '../core/graph.mjs';
import { resolutionWarning, resolveTasksFile } from '../core/tasks-file.mjs';

/**
 * Resolve the task file an action reads.
 *
 * The path is OPTIONAL. It is derived from the project when the caller does
 * not name it, so a caller that knows the project can act on the plan it is
 * working in — and the call that failed on a missing path can no longer
 * happen. The choice is REPORTED: the payload names the file, and a project
 * with several artifact spaces warns instead of guessing silently.
 *
 * @param {any} args
 * @param {import('../context.mjs').Context} ctx
 * @param {string} action
 * @returns {{file: string, warning: string|null}}
 */
function resolveTasks(args, ctx, action) {
  const resolved = resolveTasksFile({
    tasksYaml: args.tasksYaml ? ctx.contain(args.tasksYaml) : null,
    slugDir: args.slugDir ? ctx.contain(args.slugDir) : null,
    projectRoot: ctx.projectRoot,
    action,
  });
  return { file: resolved.file, warning: resolutionWarning(resolved) };
}

/**
 * The meta block for a resolved task file: the warning when the file was
 * chosen rather than named.
 *
 * @param {string|null} warning
 * @returns {object}
 */
function resolvedMeta(warning) {
  return warning ? { warnings: [warning] } : {};
}

/**
 * The `.archgen/<slug>/` directory a tasks file belongs to.
 *
 * A tasks.yaml outside the artifact space has no slug directory, so there is
 * nowhere the snapshot may be written — and the worker contract says the
 * snapshot is NEVER created outside `.archgen/`.
 */
function slugDirFor(tasksFile, action) {
  try {
    return resolveSlugInput(tasksFile).root;
  } catch (e) {
    if (e instanceof ScopeError) {
      throw invalidInput(
        `tasks.yaml must live in .archgen/<slug>/ — ${tasksFile} does not`, { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>' }), reason: "the task file lives inside the artifact space." }), action, file: tasksFile });
    }
    // A MISSING FILE is not an internal error. `realpathSync` throws a raw
    // ENOENT, which escaped as INTERNAL — a broken server, where the sibling
    // actions return INVALID_INPUT for the very same path.
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
      throw invalidInput(
        `cannot read ${tasksFile} (missing or unreadable)`,
        { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), action, file: tasksFile },
      );
    }
    throw e;
  }
}


/**
 * The arguments each action takes. An argument that belongs to another
 * action is a typed error, not a silent no-op.
 */
const TASKS_ACTION_ARGS = {
  next: ['tasksYaml', 'taskId', 'limit', 'offset'],
  set_status: ['tasksYaml', 'taskId', 'status', 'force'],
  list: ['tasksYaml', 'taskId', 'filterStatus', 'module', 'limit', 'offset'],
  snapshot: ['tasksYaml'],
  contract: ['tasksYaml', 'taskId', 'slugDir', 'codeStandardsPath'],
};

const schema = z.object({
  action: z.enum(['next', 'set_status', 'list', 'snapshot', 'contract']),
  tasksYaml: z.string().optional().describe('tasks.yaml path; omit → the active .archgen/<slug>/tasks.yaml.'),
  taskId: z.string().optional().describe('Task id; one task only.'),
  status: z.enum(STATUSES).optional().describe('New task status.'),
  force: z.boolean().optional().describe('Allow reopening a done task.'),
  filterStatus: z
    .enum(STATUSES)
    .optional()
    .describe('Filter by status — a typo is rejected, not ignored.'),
  slugDir: z.string().optional().describe('.archgen/<slug>/ dir.'),
  codeStandardsPath: z.string().optional().describe('Code-standards path.'),
  module: z.string().optional().describe('Module path fragment.'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerTaskTools(server) {
  registerTool(server, 'archgen_tasks', {
    actionArgs: TASKS_ACTION_ARGS,
    title: 'ArchGen tasks',
    description:
      'Execute an archgen plan: next dependency-safe wave, atomic status updates, task listing, ' +
      'resume snapshot, and the assembled worker contract. ' +
      routingSentence(TASKS_ACTION_ARGS),
    inputSchema: schema,
    readOnly: false,
    destructive: true,
    handler: (ctx, args) => {
      const action = args.action;

      switch (action) {
        case 'set_status': {
          const { file, warning } = resolveTasks(args, ctx, action);
          if (!args.taskId) throw invalidInput(
            'taskId is required for set_status',
            { ...hint({ action: toolCall('archgen_tasks', { action: 'set_status', tasksYaml: file, taskId: '<task id>', status: 'done' }), reason: "set_status names the task and the status." }), action, file },
          );
          if (!args.status) throw invalidInput(
            'status is required for set_status',
            { ...hint({ action: toolCall('archgen_tasks', { action: 'set_status', tasksYaml: file, taskId: '<task id>', status: 'done' }), reason: "set_status names the task and the status." }), action, file },
          );
          const updated = setTaskStatus(file, args.taskId, args.status, { force: args.force === true });
          return withMeta(updated, resolvedMeta(warning));
        }
        case 'list': {
          const { file, warning } = resolveTasks(args, ctx, action);
          // The schema rejects a bad status, but the handler does NOT rely on
          // that: the CLI facade drives the handlers directly, and a free-text
          // status there returned an EMPTY list for a typo — a silent
          // "these tasks do not exist" answer.
          if (args.filterStatus && !STATUSES.includes(args.filterStatus)) {
            throw invalidInput(
              `unknown status '${args.filterStatus}' (allowed: ${STATUSES.join('|')})`, { ...hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: file }), reason: "the list carries every status." }), action, filterStatus: args.filterStatus, allowed: STATUSES });
          }
          const listed = listTasks(file, {
            status: args.filterStatus ?? null,
            module: args.module ?? null,
          });
          // ONE task, when the caller named one.
          //
          // The lookup runs against the UNFILTERED task set. It used to run
          // against the filtered one, so `list{taskId:'B', filterStatus:
          // 'done'}` reported "no task 'B' in <tasks.yaml>" — a false claim
          // about the plan, for a task that was right there.
          if (args.taskId) {
            const all = listTasks(file, {});
            const one = (all.tasks ?? []).find((t) => t.id === args.taskId);
            if (!one) {
              throw invalidInput(
                `no task '${args.taskId}' in ${file}`,
                { ...hint({ action: toolCall('archgen_tasks', { action: 'list', tasksYaml: file }), reason: "the list carries every task id." }), action,
                taskId: args.taskId,
                available: (all.tasks ?? []).map((t) => t.id), },
              );
            }
            const excludedBy = [];
            if (args.filterStatus && one.status !== args.filterStatus) excludedBy.push(`status:${args.filterStatus}`);
            if (args.module) {
              const owned = (one.file_ownership ?? []).join(' ');
              if (!owned.includes(args.module)) excludedBy.push(`module:${args.module}`);
            }
            return withMeta(
              {
                file,
                task: one,
                tasks: [one],
                ...(excludedBy.length
                  ? { excludedBy, note: `this task exists but does not match ${excludedBy.join(', ')}` }
                  : {}),
              },
              resolvedMeta(warning),
            );
          }
          const p = project(listed.tasks ?? [], {
            limit: args.limit,
            offset: args.offset,
            // The continuation carries the RESOLVED path. It used to carry the
            // caller's own argument — which was undefined when the caller had
            // not passed one, so the tool published a "next call" that could
            // not work.
            next: toolCall('archgen_tasks', { action: 'list', tasksYaml: file, limit: args.limit ?? 50, offset: (args.offset ?? 0) + (args.limit ?? 50) }),
          });
          return withMeta(
            { ...listed, file, tasks: p.items },
            {
              ...moreMeta({
                total: p.total,
                returned: p.returned,
                next: p.next,
                available: { tasks: p.total },
                more: toolCall('archgen_tasks', { action: 'list', tasksYaml: file, taskId: '<one task>' }),
              }),
              ...resolvedMeta(warning),
            },
          );
        }
        case 'snapshot': {
          const { file: tasksFile, warning } = resolveTasks(args, ctx, action);
          // The snapshot belongs to the artifact space: `<slug>/.agent/`.
          // Deriving it from the tasks file's PARENT wrote it wherever that
          // file happened to be — `<project>/plans/.agent/resume.md`, outside
          // `.archgen/`, which is exactly what the worker contract forbids.
          const slugDir = slugDirFor(tasksFile, action);
          const waves = resolveWaves(tasksFile).waves;
          const snapshot = writeResumeSnapshot(slugDir, waves);
          return withMeta(snapshot, resolvedMeta(warning));
        }
        case 'contract': {
          const { file: tasksFile, warning } = resolveTasks(args, ctx, action);
          if (!args.taskId) throw invalidInput(
            'taskId is required for contract',
            { ...hint({ action: toolCall('archgen_tasks', { action: 'contract', tasksYaml: tasksFile, taskId: '<task id>' }), reason: "the contract is built for one task." }), action, file: tasksFile },
          );
          const slugDir = args.slugDir ? ctx.contain(args.slugDir) : dirname(tasksFile);

          // The capability skills: match the task, resolve the INSTALLED
          // path, and carry the skill's NORMATIVE RULES into the prompt.
          //
          // EVERY matched required skill is included. The old code injected
          // `required[0]` only — so a task matching the baseline AND the
          // accessibility skill silently lost the second, even though it had
          // been installed on purpose. An installed skill that no contract
          // ever names is a skill that is never applied.
          //
          // The rules travel WITH the contract rather than as a path alone:
          // a pointer is a file the worker may never open, and a worker that
          // never opens it produces work that ignores the skill.
          let capabilities = [];
          const capabilityWarnings = [];
          try {
            const registry = loadAsset('skill-registry.json');
            const raw = readFileSync(tasksFile, 'utf8');
            const { data } = parseYaml(raw, { filename: tasksFile });
            const task = (data?.tasks ?? []).find((t) => t?.id === args.taskId);
            const matched = matchSkills(registry, {
              title: task?.title ?? '',
              summary: task?.summary ?? '',
              fileOwnership: ownedPaths(task),
            });
            const required = matched.filter((m) => m.policy === 'required');
            capabilities = required.map((m) => {
              const found = findInstalledSkill(ctx.projectRoot, m.slug, { home: ctx.home });
              const cap = {
                slug: m.slug,
                path: found.path,
                purpose: m.purpose,
                domain: m.domain,
                installed: found.installed,
                rules: '',
                sections: [],
              };
              if (found.installed && found.path) {
                try {
                  const content = readFileSync(found.path, 'utf8');
                  cap.rules = skillRules(content).rules;
                  cap.sections = skillSections(content).map((s) => ({
                    slug: s.slug,
                    title: s.title,
                    normative: s.normative,
                  }));
                } catch (e) {
                  // A skill that cannot be read is a WARNING, not a silent
                  // empty capability: the worker must know its rules are
                  // missing from the prompt.
                  capabilityWarnings.push(
                    `capability skill '${m.slug}' is installed but unreadable (${e?.message ?? e}) — its rules are NOT in this contract`,
                  );
                }
              }
              return cap;
            });
          } catch (e) {
            // The capability match FAILED. It used to be swallowed into an
            // empty list, so the contract said "no capability skill is
            // required" when matching had never run — the worker was told
            // nothing was required when the truth was UNKNOWN.
            capabilityWarnings.push(
              `capability matching failed (${e?.message ?? e}) — the required capability skills are UNKNOWN, not absent`,
            );
          }

          // The doc sections that actually contain this task's contract —
          // never the whole plan. The count of what was left out is
          // reported: five matching sections used to arrive as two, with no
          // count and no hint.
          let docSections = [];
          let docSectionsTotal = 0;
          try {
            const map = docIndex(slugDir, { mode: 'map', token: args.taskId, projectRoot: ctx.projectRoot });
            const all = map.data.sections ?? [];
            docSectionsTotal = all.length;
            docSections = all.slice(0, 2).map((s) => ({
              file: s.file,
              section: s.section,
              title: s.title,
              line: s.line,
              endLine: s.endLine,
            }));
          } catch {
            docSections = [];
          }

          // The code-standards reference: resolved from the INSTALLED skill when
          // the caller does not name it. The worker needs a real path, and the
          // agent should not have to guess where the skill lives.
          //
          // A caller-supplied path is CONTAINED, exactly like every other
          // path argument: it ends up verbatim in a prompt a worker reads,
          // so an uncontained one would point the worker anywhere on the
          // machine.
          const codeStandardsPath = args.codeStandardsPath
            ? ctx.contain(args.codeStandardsPath)
            : ctx.skill
              ? join(ctx.skill.path, 'references', 'code-standards.md')
              : null;

          const contract = buildWorkerContract({
            tasksYaml: tasksFile,
            taskId: args.taskId,
            slugDir,
            codeStandardsPath,
            capabilities,
            docSections,
            // CodeGraph is DETECTED here, not left for the worker to work
            // out: the instruction only helps if it is in the prompt.
            codegraph: existsSync(join(ctx.projectRoot, '.codegraph')),
          });
          return {
            ...contract,
            // The plan the contract was built from. The agent has to know
            // WHICH plan it is about when the file was resolved rather than
            // named.
            file: tasksFile,
            // The cap is COUNTED, and the failures are named. A contract that
            // silently dropped three of five doc sections, or silently
            // emptied the capability block, was indistinguishable from a
            // contract that had nothing more to say.
            docSectionCount: docSections.length,
            docSectionsTotal,
            ...(docSectionsTotal > docSections.length
              ? {
                  docSectionsOmitted: docSectionsTotal - docSections.length,
                  docSectionsHint: `read the rest with ${toolCall('archgen_docs', { action: 'map', token: args.taskId })}`,
                }
              : {}),
            ...(capabilityWarnings.length || warning
              ? {
                  warnings: [
                    ...(contract.warnings ?? []),
                    ...capabilityWarnings,
                    ...(warning ? [warning] : []),
                  ],
                }
              : {}),
          };
        }
        case 'next': {
          const { file, warning } = resolveTasks(args, ctx, action);
          const resolved = resolveWaves(file);
          // ONE wave, when the caller named a task: "which wave is this in?"
          if (args.taskId) {
            const index = resolved.waves.findIndex((w) => w.some((t) => t.id === args.taskId));
            // The wave resolver EXCLUDES done tasks, so a completed task is
            // in no wave. The lookup therefore runs against the TASK SET —
            // reporting "no task 'X'" for a task that exists was a false
            // claim about the plan.
            if (index < 0) {
              const all = listTasks(file, {});
              const one = (all.tasks ?? []).find((t) => t.id === args.taskId);
              if (!one) {
                throw invalidInput(
                  `no task '${args.taskId}' in ${file}`,
                  {
                    ...hint({
                      action: toolCall('archgen_tasks', { action: 'list', tasksYaml: file }),
                      reason: 'the list carries every task id.',
                    }),
                    action,
                    taskId: args.taskId,
                    available: resolved.waves.flat().map((t) => t.id),
                  },
                );
              }
              return withMeta(
                {
                  file,
                  taskId: args.taskId,
                  waveIndex: null,
                  waveCount: resolved.waves.length,
                  wave: [],
                  task: one,
                  note: `task '${args.taskId}' is ${one.status} — it is in no active wave`,
                  blockedByFailure: resolved.blockedByFailure,
                },
                resolvedMeta(warning),
              );
            }
            // The wave index is 1-BASED, like the snapshot's. It used to be
            // the 0-based array index, so `next{taskId:'T02'}.waveIndex` was
            // 1 (the SECOND wave) while `snapshot.waveIndex` was 1 (the
            // FIRST) — the same field name, opposite meanings.
            return withMeta(
              {
                file,
                waveIndex: index + 1,
                waveCount: resolved.waves.length,
                wave: resolved.waves[index],
                blockedByFailure: resolved.blockedByFailure,
              },
              resolvedMeta(warning),
            );
          }
          // The waves are the plan's shape; a long plan would dump every task
          // in every wave, so the wave COUNT is reported and the waves
          // themselves are bounded.
          const p = project(resolved.waves, {
            limit: args.limit,
            offset: args.offset,
            next: toolCall('archgen_tasks', { action: 'next', tasksYaml: file, limit: args.limit ?? 50, offset: (args.offset ?? 0) + (args.limit ?? 50) }),
          });
          return withMeta(
            {
              ...resolved,
              file,
              waves: p.items,
              // THE FRONTIER — the wave that is executable NOW. The payload
              // listed every remaining wave with nothing marking which one
              // to dispatch, so the agent had to guess.
              frontier: p.items[0] ?? null,
              frontierIndex: p.offset + 1,
              ...(p.items.length === 0 && resolved.waves.length === 0
                ? { note: 'no waves remain — every task is done or blocked' }
                : {}),
            },
            {
              ...moreMeta({
                total: p.total,
                returned: p.returned,
                next: p.next,
                available: { waves: p.total, tasks: resolved.waves.flat().length },
                more: toolCall('archgen_tasks', { action: 'next', tasksYaml: file, taskId: '<one task>' }),
              }),
              ...resolvedMeta(warning),
            },
          );
        }
        default:
          throw invalidInput(
            `unknown action '${action}'`,
            { ...hint({ action: toolCall('archgen_help', { topic: 'tasks' }), reason: "the actions are listed there." }), action },
          );
      }
    },
  });
}
