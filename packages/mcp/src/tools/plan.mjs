// plan.mjs — the `archgen_plan` tool: plan validation & graph analysis.
//
// One tool, one action enum. The tool catalog is injected into the model's
// context by every client, so a single well-described tool with a short action
// enum costs far less context than five thin tools — and it removes the
// "which one do I call?" confusion the whole MCP exercise exists to fix.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { loadAsset, BRIEFS_DIR, TEMPLATES_DIR, serverVersion } from '../context.mjs';
import { buildScaffold } from '../core/scaffold.mjs';
import { loadBrief, remainingPlaceholders, renderBriefContext, BRIEF_KINDS } from '../core/briefs.mjs';
import { resolveBriefScope, briefVars } from '../core/brief-scope.mjs';
import { buildBriefContext } from '../core/brief-context.mjs';
import { validateTasksYaml } from '../core/validator.mjs';
import { verifyPlan, planCoverage } from '../core/verifier.mjs';
import { planGraph } from '../core/plan-grapher.mjs';
import { analyzeImpact } from '../core/impact-analyzer.mjs';
import { invalidInput } from '../core/errors.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

// The action list lives in archgen_help (one call away). Repeating it here
// would tax every request's context for no extra information.
const ACTION_DESC =
  'validate | verify | graph | impact | coverage | scaffold | brief — see archgen_help.';

const schema = z.object({
  action: z.enum(['validate', 'verify', 'graph', 'impact', 'coverage', 'scaffold', 'brief']).describe(ACTION_DESC),
  tasksYaml: z
    .string()
    .optional()
    .describe('Absolute path to tasks.yaml. Required for validate, verify, impact and coverage.'),
  planDir: z.string().optional().describe('Absolute path to the plans directory (verify, coverage, brief).'),
  target: z.string().optional().describe('Task id or artifact path (impact).'),
  taskId: z.string().optional().describe('ONE task id (coverage).'),
  node: z.string().optional().describe('Restrict the graph to one task neighborhood (graph).'),
  format: z.enum(['json', 'mermaid']).optional().describe('Graph output format. Defaults to json.'),
  status: z.boolean().optional().describe('Include status styling (graph, mermaid only).'),
  module: z.string().optional().describe('Restrict the graph to one module (graph).'),
  scope: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional().describe('Scope class (scaffold).'),
  slug: z.string().optional().describe('Project slug (scaffold, brief).'),
  file: z.string().optional().describe('ONE artifact file (scaffold) — returns just that skeleton.'),
  kind: z.enum(BRIEF_KINDS).optional().describe('Which dispatch brief (brief).'),
  featureRequest: z
    .string()
    .optional()
    .describe('The feature being requested, in one line (brief). Defaults to the slug.'),
  topic: z.string().optional().describe('Investigation topic (brief).'),
  round: z.number().int().positive().optional().describe('Investigation round number (brief).'),
  limit: z.number().int().positive().optional().describe('Max items to return. Default 50.'),
  offset: z.number().int().nonnegative().optional().describe('Skip this many items.'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerPlanTools(server) {
  registerTool(server, 'archgen_plan', {
    title: 'ArchGen plan',
    description:
      'Validate and analyze an archgen plan (tasks.yaml + plans/). Use after generating or editing a plan, ' +
      'before the verifier gate, and when you need the dependency graph or the blast radius of a change.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const action = args.action;

      switch (action) {
        case 'validate': {
          const file = requireTasksYaml(args, ctx);
          return validateTasksYaml(file, { planDir: args.planDir ? ctx.contain(args.planDir) : null });
        }
        case 'verify': {
          const file = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput('verify requires planDir', { action });
          return verifyPlan(file, ctx.contain(args.planDir));
        }
        case 'coverage': {
          const file = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput('coverage requires planDir', { action });
          const covered = planCoverage(file, ctx.contain(args.planDir));
          // ONE task, when the caller named one.
          if (args.taskId) {
            const isCovered = (covered.covered ?? []).includes(args.taskId);
            const isUncovered = (covered.uncovered ?? []).includes(args.taskId);
            if (!isCovered && !isUncovered) {
              throw invalidInput(`no task '${args.taskId}' in ${file}`, {
                action,
                taskId: args.taskId,
                available: [...(covered.covered ?? []), ...(covered.uncovered ?? [])],
              });
            }
            return { taskId: args.taskId, covered: isCovered, findings: covered.findings ?? [] };
          }
          const p = project([...(covered.covered ?? []), ...(covered.uncovered ?? [])], {
            limit: args.limit,
            offset: args.offset,
            next: `archgen_plan{action:'coverage',tasksYaml:'${file}',planDir:'${args.planDir}',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`,
          });
          return withMeta(
            { ...covered, covered: p.items.slice(0, (covered.covered ?? []).length) },
            moreMeta({
              total: p.total,
              returned: p.returned,
              next: p.next,
              available: { tasks: p.total, uncovered: (covered.uncovered ?? []).length },
              more: `archgen_plan{action:'coverage',tasksYaml:'${file}',planDir:'${args.planDir}',taskId:'<one task>'}`,
            }),
          );
        }
        case 'impact': {
          const file = requireTasksYaml(args, ctx);
          if (!args.target) throw invalidInput('impact requires target (a task id or an artifact path)', { action });
          const blast = analyzeImpact(file, args.target);
          const p = project([...(blast.direct ?? []), ...(blast.transitive ?? [])], {
            limit: args.limit,
            offset: args.offset,
            next: `archgen_plan{action:'impact',tasksYaml:'${file}',target:'${args.target}',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`,
          });
          return withMeta(
            blast,
            moreMeta({ total: p.total, returned: p.returned, next: p.next, available: { impacted: p.total } }),
          );
        }
        case 'scaffold': {
          if (!args.scope) throw invalidInput('scaffold requires scope (SMALL | MEDIUM | LARGE)', { action });
          const built = buildScaffold(loadAsset('depth-ladder.json'), args.scope, {
            slug: args.slug ?? null,
            templatesDir: TEMPLATES_DIR,
            // The generator token carries the RUNNING server's version. The
            // server knows it exactly, so the artifact records the truth
            // instead of the agent having to guess, copy or type a version —
            // and no release ever has to update a version written by hand.
            generator: `archgen v${serverVersion()}`,
          });
          // ONE file's skeleton, when the caller named one. The whole set is
          // the CONTRACT — truncating it would produce a broken plan — so the
          // default stays whole and the map to the rest lives in `meta`.
          if (args.file) {
            const key = Object.keys(built.skeletons ?? {}).find((k) => k === args.file || k.endsWith(`/${args.file}`));
            if (!key) {
              throw invalidInput(`no skeleton '${args.file}' for scope ${args.scope}`, {
                action,
                file: args.file,
                available: Object.keys(built.skeletons ?? {}),
              });
            }
            return { ...built, skeletons: { [key]: built.skeletons[key] }, one: key };
          }
          return withMeta(
            built,
            moreMeta({
              total: (built.writeThese ?? []).length,
              returned: (built.writeThese ?? []).length,
              available: { files: (built.writeThese ?? []).length },
              more: `archgen_plan{action:'scaffold',scope:'${args.scope}',slug:'${args.slug ?? '<slug>'}',file:'<one file>'}`,
            }),
          );
        }
        case 'brief': {
          if (!args.kind) throw invalidInput('brief requires kind', { action });
          // The artifact space is resolved from whatever the caller named:
          // the tasks.yaml it already holds, the plans dir, or the slug alone.
          //
          // The slug is DERIVED from the path when the path implies it — the
          // caller must not have to state the same fact twice. And every path
          // the brief carries is ABSOLUTE, because a brief is read by a
          // sub-agent whose working directory is not necessarily the
          // project's: a project-relative path in a brief resolves against
          // the SERVER's root and silently points at the wrong tree.
          const scope = resolveBriefScope({
            tasksYaml: args.tasksYaml ? ctx.contain(args.tasksYaml) : null,
            planDir: args.planDir ? ctx.contain(args.planDir) : null,
            slug: args.slug ?? null,
            projectRoot: ctx.projectRoot,
          });
          const vars = briefVars(scope, {
            featureRequest: args.featureRequest ?? null,
            topic: args.topic ?? null,
            round: args.round ?? null,
          });

          // The context the brief carries: the evidence map, the pre-rendered
          // graph and the reference-integrity result.
          //
          // RENDERING THEM HERE (instead of telling the orchestrator to
          // "attach" them) saves two tool calls per gate round, and removes a
          // dependency on a call that used to fail on every plan.
          const briefContext = buildBriefContext(args.kind, scope, ctx);

          const { kind, brief } = loadBrief(BRIEFS_DIR, args.kind, vars);
          // A brief with a placeholder still in it is a brief that would
          // send a worker looking for a directory named "<slug dir>".
          const missing = remainingPlaceholders(brief);
          if (missing.length) {
            const passable = missing.filter((m) => m === 'topic' || m === 'round');
            throw invalidInput(
              `brief '${kind}' is missing ${missing.join(', ')} — pass ${passable.length ? passable.join(', ') : 'the missing values'}`,
              { action, kind, missing },
            );
          }
          return { kind, brief: `${renderBriefContext(briefContext)}\n${brief}`, scope };
        }
        case 'graph': {
          const input = args.tasksYaml ?? args.planDir;
          if (!input) throw invalidInput('graph requires tasksYaml (a slug directory or a tasks.yaml path)', { action });
          const format = args.format ?? 'json';
          if (format === 'mermaid' && args.module) {
            throw invalidInput('module cannot combine with mermaid output', { action });
          }
          if (args.status && format !== 'mermaid') {
            throw invalidInput('status requires mermaid output', { action });
          }
          return planGraph(ctx.contain(input), {
            node: args.node ?? null,
            mermaid: format === 'mermaid',
            status: args.status === true,
            module: args.module ?? null,
            projectRoot: ctx.projectRoot,
          });
        }
        default:
          // The schema rejects unknown actions before this point; the explicit
          // default guarantees an unknown action can never fall through into
          // the wrong branch if validation is ever bypassed.
          throw invalidInput(`unknown action '${action}'`, { action });
      }
    },
  });
}

/**
 * Resolve the tasks.yaml argument, defaulting to the project's active slug.
 * @param {any} args
 * @param {import('../context.mjs').Context} ctx
 */
function requireTasksYaml(args, ctx) {
  if (!args.tasksYaml) throw invalidInput('tasksYaml is required for this action', { action: args.action });
  return ctx.contain(args.tasksYaml);
}
