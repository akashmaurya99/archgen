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
import { loadBrief, remainingPlaceholders, BRIEF_KINDS } from '../core/briefs.mjs';
import { validateTasksYaml } from '../core/validator.mjs';
import { verifyPlan, planCoverage } from '../core/verifier.mjs';
import { planGraph } from '../core/plan-grapher.mjs';
import { analyzeImpact } from '../core/impact-analyzer.mjs';
import { invalidInput } from '../core/errors.mjs';

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
  planDir: z.string().optional().describe('Absolute path to the plans directory (verify, coverage).'),
  target: z.string().optional().describe('Task id or artifact path (impact).'),
  node: z.string().optional().describe('Restrict the graph to one task neighborhood (graph).'),
  format: z.enum(['json', 'mermaid']).optional().describe('Graph output format. Defaults to json.'),
  status: z.boolean().optional().describe('Include status styling (graph, mermaid only).'),
  module: z.string().optional().describe('Restrict the graph to one module (graph).'),
  scope: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional().describe('Scope class (scaffold).'),
  slug: z.string().optional().describe('Project slug (scaffold, brief).'),
  kind: z.enum(BRIEF_KINDS).optional().describe('Which dispatch brief (brief).'),
  featureRequest: z
    .string()
    .optional()
    .describe('The feature being requested, in one line (brief). Defaults to the slug.'),
  topic: z.string().optional().describe('Investigation topic (brief).'),
  round: z.number().int().positive().optional().describe('Investigation round number (brief).'),
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
          return planCoverage(file, ctx.contain(args.planDir));
        }
        case 'impact': {
          const file = requireTasksYaml(args, ctx);
          if (!args.target) throw invalidInput('impact requires target (a task id or an artifact path)', { action });
          return analyzeImpact(file, args.target);
        }
        case 'scaffold': {
          if (!args.scope) throw invalidInput('scaffold requires scope (SMALL | MEDIUM | LARGE)', { action });
          return buildScaffold(loadAsset('depth-ladder.json'), args.scope, {
            slug: args.slug ?? null,
            templatesDir: TEMPLATES_DIR,
            // The generator token carries the RUNNING server's version. The
            // server knows it exactly, so the artifact records the truth
            // instead of the agent having to guess, copy or type a version —
            // and no release ever has to update a version written by hand.
            generator: `archgen v${serverVersion()}`,
          });
        }
        case 'brief': {
          if (!args.kind) throw invalidInput('brief requires kind', { action });
          // Every placeholder the chosen brief uses is filled in, derived
          // from ONE source (the slug) so the paths in a brief agree with
          // each other. Previously only two of the seven were substituted,
          // and the 'slug dir' one was given the bare slug — so a worker
          // was told to read `checkout` and to write into `.archgen/<slug>/`
          // with the placeholder still in it.
          const slug = args.slug ?? null;
          const vars = {};
          if (slug) {
            vars['slug'] = slug;
            vars['slug dir'] = `.archgen/${slug}`;
            vars['plans dir'] = `.archgen/${slug}/plans`;
            vars['tasks.yaml'] = args.tasksYaml ?? `.archgen/${slug}/tasks.yaml`;
          }
          if (args.featureRequest) vars['feature request'] = args.featureRequest;
          else if (slug) vars['feature request'] = slug;
          if (args.topic) vars['topic'] = args.topic;
          if (args.round !== undefined) vars['round'] = String(args.round);
          const { kind, brief } = loadBrief(BRIEFS_DIR, args.kind, vars);
          // A brief with a placeholder still in it is a brief that would
          // send a worker looking for a directory named "<slug dir>".
          const missing = remainingPlaceholders(brief);
          if (missing.length) {
            throw invalidInput(
              `brief '${kind}' needs ${missing.join(', ')} — pass slug${missing.includes('topic') ? ', topic' : ''}${missing.includes('round') ? ', round' : ''}`,
              { action, kind, missing },
            );
          }
          return { kind, brief };
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
