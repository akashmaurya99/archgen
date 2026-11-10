// tasks.mjs — the `archgen_tasks` tool: the wave execution loop.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
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
import { moreMeta, project, withMeta } from '../envelope.mjs';
import { resolveSlugInput, ScopeError } from '../core/scope.mjs';
import { dirname, join } from 'node:path';

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
        `tasks.yaml must live in .archgen/<slug>/ — ${tasksFile} does not`,
        { action, file: tasksFile },
      );
    }
    throw e;
  }
}

const ACTION_DESC = 'next|set_status|list|snapshot|contract';

const schema = z.object({
  action: z.enum(['next', 'set_status', 'list', 'snapshot', 'contract']).describe(ACTION_DESC),
  tasksYaml: z.string().optional().describe('tasks.yaml path (all actions).'),
  taskId: z.string().optional().describe('Task id (set_status, contract); one task (list, next).'),
  status: z.enum(STATUSES).optional().describe('New status (set_status).'),
  force: z.boolean().optional().describe('Allow reopening a done task (set_status).'),
  filterStatus: z
    .enum(STATUSES)
    .optional()
    .describe('Filter by status (list). One of the task statuses — a typo is rejected, not ignored.'),
  slugDir: z.string().optional().describe('.archgen/<slug>/ dir (contract).'),
  codeStandardsPath: z.string().optional().describe('Code-standards path (contract).'),
  module: z.string().optional().describe('Module path fragment (list).'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerTaskTools(server) {
  registerTool(server, 'archgen_tasks', {
    title: 'ArchGen tasks',
    description:
      'Execute an archgen plan: next dependency-safe wave, atomic status updates, task listing, ' +
      'resume snapshot, and the assembled worker contract.',
    inputSchema: schema,
    readOnly: false,
    destructive: true,
    handler: (ctx, args) => {
      const action = args.action;

      switch (action) {
        case 'set_status': {
          if (!args.tasksYaml) throw invalidInput('tasksYaml is required for set_status', { action });
          if (!args.taskId) throw invalidInput('taskId is required for set_status', { action });
          if (!args.status) throw invalidInput('status is required for set_status', { action });
          return setTaskStatus(ctx.contain(args.tasksYaml), args.taskId, args.status, { force: args.force === true });
        }
        case 'list': {
          if (!args.tasksYaml) throw invalidInput('tasksYaml is required for list', { action });
          // The schema rejects a bad status, but the handler does NOT rely on
          // that: the CLI facade drives the handlers directly, and a free-text
          // status there returned an EMPTY list for a typo — a silent
          // "these tasks do not exist" answer.
          if (args.filterStatus && !STATUSES.includes(args.filterStatus)) {
            throw invalidInput(
              `unknown status '${args.filterStatus}' (allowed: ${STATUSES.join('|')})`,
              { action, filterStatus: args.filterStatus, allowed: STATUSES },
            );
          }
          const file = ctx.contain(args.tasksYaml);
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
              throw invalidInput(`no task '${args.taskId}' in ${args.tasksYaml}`, {
                action,
                taskId: args.taskId,
                available: (all.tasks ?? []).map((t) => t.id),
              });
            }
            const excludedBy = [];
            if (args.filterStatus && one.status !== args.filterStatus) excludedBy.push(`status:${args.filterStatus}`);
            if (args.module) {
              const owned = (one.file_ownership ?? []).join(' ');
              if (!owned.includes(args.module)) excludedBy.push(`module:${args.module}`);
            }
            return {
              task: one,
              tasks: [one],
              ...(excludedBy.length
                ? { excludedBy, note: `this task exists but does not match ${excludedBy.join(', ')}` }
                : {}),
            };
          }
          const p = project(listed.tasks ?? [], {
            limit: args.limit,
            offset: args.offset,
            next: `archgen_tasks{action:'list',tasksYaml:'${args.tasksYaml}',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`,
          });
          return withMeta(
            { ...listed, tasks: p.items },
            moreMeta({
              total: p.total,
              returned: p.returned,
              next: p.next,
              available: { tasks: p.total },
              more: `archgen_tasks{action:'list',tasksYaml:'${args.tasksYaml}',taskId:'<one task>'}`,
            }),
          );
        }
        case 'snapshot': {
          if (!args.tasksYaml) throw invalidInput('tasksYaml is required for snapshot', { action });
          const tasksFile = ctx.contain(args.tasksYaml);
          // The snapshot belongs to the artifact space: `<slug>/.agent/`.
          // Deriving it from the tasks file's PARENT wrote it wherever that
          // file happened to be — `<project>/plans/.agent/resume.md`, outside
          // `.archgen/`, which is exactly what the worker contract forbids.
          const slugDir = slugDirFor(tasksFile, action);
          const waves = resolveWaves(tasksFile).waves;
          return writeResumeSnapshot(slugDir, waves);
        }
        case 'contract': {
          if (!args.tasksYaml) throw invalidInput('tasksYaml is required for contract', { action });
          if (!args.taskId) throw invalidInput('taskId is required for contract', { action });
          const tasksFile = ctx.contain(args.tasksYaml);
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
              fileOwnership: task?.file_ownership ?? [],
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
            // The cap is COUNTED, and the failures are named. A contract that
            // silently dropped three of five doc sections, or silently
            // emptied the capability block, was indistinguishable from a
            // contract that had nothing more to say.
            docSectionCount: docSections.length,
            docSectionsTotal,
            ...(docSectionsTotal > docSections.length
              ? {
                  docSectionsOmitted: docSectionsTotal - docSections.length,
                  docSectionsHint: `read the rest with archgen_docs{action:'map',token:'${args.taskId}'}`,
                }
              : {}),
            ...(capabilityWarnings.length
              ? { warnings: [...(contract.warnings ?? []), ...capabilityWarnings] }
              : {}),
          };
        }
        case 'next': {
          if (!args.tasksYaml) throw invalidInput('tasksYaml is required for next', { action });
          const resolved = resolveWaves(ctx.contain(args.tasksYaml));
          // ONE wave, when the caller named a task: "which wave is this in?"
          if (args.taskId) {
            const index = resolved.waves.findIndex((w) => w.some((t) => t.id === args.taskId));
            if (index < 0) {
              throw invalidInput(`no task '${args.taskId}' in ${args.tasksYaml}`, {
                action,
                taskId: args.taskId,
                available: resolved.waves.flat().map((t) => t.id),
              });
            }
            // The wave index is 1-BASED, like the snapshot's. It used to be
            // the 0-based array index, so `next{taskId:'T02'}.waveIndex` was
            // 1 (the SECOND wave) while `snapshot.waveIndex` was 1 (the
            // FIRST) — the same field name, opposite meanings.
            return {
              waveIndex: index + 1,
              waveCount: resolved.waves.length,
              wave: resolved.waves[index],
              blockedByFailure: resolved.blockedByFailure,
            };
          }
          // The waves are the plan's shape; a long plan would dump every task
          // in every wave, so the wave COUNT is reported and the waves
          // themselves are bounded.
          const p = project(resolved.waves, {
            limit: args.limit,
            offset: args.offset,
            next: `archgen_tasks{action:'next',tasksYaml:'${args.tasksYaml}',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`,
          });
          return withMeta(
            { ...resolved, waves: p.items },
            moreMeta({
              total: p.total,
              returned: p.returned,
              next: p.next,
              available: { waves: p.total, tasks: resolved.waves.flat().length },
              more: `archgen_tasks{action:'next',tasksYaml:'${args.tasksYaml}',taskId:'<one task>'}`,
            }),
          );
        }
        default:
          throw invalidInput(`unknown action '${action}'`, { action });
      }
    },
  });
}
