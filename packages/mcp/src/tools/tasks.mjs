// tasks.mjs — the `archgen_tasks` tool: the wave execution loop.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { resolveWaves, listTasks } from '../core/wave-resolver.mjs';
import { buildWorkerContract } from '../core/worker-contract.mjs';
import { matchSkills, findInstalledSkill } from '../core/skill-manager.mjs';
import { docIndex } from '../core/doc-navigator.mjs';
import { parseYaml } from '../core/yaml.mjs';
import { readFileSync } from 'node:fs';
import { loadAsset } from '../context.mjs';
import { setTaskStatus, STATUSES } from '../core/status-mutator.mjs';
import { writeResumeSnapshot } from '../core/resume-snapshot.mjs';
import { invalidInput } from '../core/errors.mjs';
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

const ACTION_DESC = 'next | set_status | list | snapshot | contract — see archgen_help.';

const schema = z.object({
  action: z.enum(['next', 'set_status', 'list', 'snapshot', 'contract']).describe(ACTION_DESC),
  tasksYaml: z.string().optional().describe('Absolute path to tasks.yaml. Required for next, set_status and list.'),
  taskId: z.string().optional().describe('Task id (set_status).'),
  status: z.enum(STATUSES).optional().describe('New status (set_status).'),
  force: z.boolean().optional().describe('Allow reopening a done task (set_status).'),
  filterStatus: z.string().optional().describe('Filter by status (list).'),
  slugDir: z.string().optional().describe('The .archgen/<slug>/ directory (contract) — locates the plan docs.'),
  codeStandardsPath: z.string().optional().describe('Path to the code-standards reference (contract).'),
  module: z.string().optional().describe('Filter by module path fragment (list).'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerTaskTools(server) {
  registerTool(server, 'archgen_tasks', {
    title: 'ArchGen tasks',
    description:
      'Execute an archgen plan: resolve the next dependency-safe wave, update task status atomically, ' +
      'list tasks, or write the resume snapshot that survives context compaction.',
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
          return listTasks(ctx.contain(args.tasksYaml), {
            status: args.filterStatus ?? null,
            module: args.module ?? null,
          });
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

          // The capability skill: match the task, then resolve the INSTALLED
          // path — the contract points at the file, not at a registry entry.
          let capability = null;
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
            if (required.length) {
              const found = findInstalledSkill(ctx.projectRoot, required[0].slug, { home: ctx.home });
              capability = {
                slug: required[0].slug,
                path: found.path,
                purpose: required[0].purpose,
                installed: found.installed,
              };
            }
          } catch {
            capability = null; // a missing registry or an unparsed task must not break the contract
          }

          // The doc sections that actually contain this task's contract — never
          // the whole plan.
          let docSections = [];
          try {
            const map = docIndex(slugDir, { mode: 'map', token: args.taskId, projectRoot: ctx.projectRoot });
            docSections = (map.data.sections ?? []).slice(0, 2).map((s) => ({
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
            capability,
            docSections,
          });
          if (capability && !capability.installed) {
            contract.warnings.push(
              `capability skill '${capability.slug}' is REQUIRED but NOT installed — install it with archgen_skills{action:'install'} before dispatch`,
            );
          }
          return contract;
        }
        case 'next': {
          if (!args.tasksYaml) throw invalidInput('tasksYaml is required for next', { action });
          return resolveWaves(ctx.contain(args.tasksYaml));
        }
        default:
          throw invalidInput(`unknown action '${action}'`, { action });
      }
    },
  });
}
